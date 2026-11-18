# agy-direct — Antigravity quota over Google OAuth, no harness

Plugs in like any OpenAI-compatible endpoint: point a client at
`http://127.0.0.1:8787/v1`, give it a key and a model id. Underneath it is one
HTTPS POST per turn to `v1internal:streamGenerateContent`, authorized with the
account's own Google OAuth token.

`agy-api/` spawns `agy.exe` per request, which drags the whole agent harness —
65,891 chars of client-built `systemInstruction`, 14 tool declarations and a
separate `agent_monitoring` rater call per tool step: **21,830 prompt tokens** for
a three-word reply. `agy-direct/` sends only the caller's messages and tools:
**6–38 prompt tokens** for the same kind of turn.

---

## Setup on any machine

```powershell
powershell -ExecutionPolicy Bypass -File agy-direct\setup.ps1
powershell -ExecutionPolicy Bypass -File agy-direct\setup.ps1 -Port 8787 -Start
```

`setup.ps1` checks node, runs the full chain check, mints a local API key, prints
the client config, and (with `-Start`) launches the shim. `start.ps1` is the
plain launcher. Both resolve their own directory, so the folder can live
anywhere.

## Where the credentials come from

| thing | where it lives | how it is found |
|---|---|---|
| refresh token + account | Windows Credential Manager | enumerate every generic credential, read each, keep the ones whose blob has `refresh_token` |
| OAuth client id/secret | Go string constants inside `agy.exe` | scan the binary for `*.apps.googleusercontent.com` + `GOCSPX-*`, verify each pair against the live token endpoint |
| model catalog | `v1internal:fetchAvailableModels` | live per account, cached briefly |

Resolution order for the binary — nothing assumes one install path:

```
AGY_BIN → config.binary_path → known dirs (~/.gemini/bin, Programs, …)
        → registry Uninstall keys → running agy process → where.exe → bounded scan
```

Only files named `agy*.exe` are accepted from the automatic sources (the IDE's own
`Antigravity IDE.exe` is not the backend). `AGY_BIN` may point at anything.

Resolution order for the credential: `AGY_REFRESH_TOKEN` → remembered target →
scored scan (`gemini:antigravity` wins, then any Antigravity/Gemini target, then
any credential holding a Google refresh token). A remembered target that no
longer reads falls through to the next candidate in the same pass.

## Surviving updates

Every value above moves between releases. All of them recover automatically.

| what an update breaks | symptom | recovery |
|---|---|---|
| client id / secret re-signed | `invalid_client`, `unauthorized_client`, `OAuth client was not found` | pair marked stale, binary rescanned, every (id, secret) pair re-validated |
| binary replaced | `binary_fingerprint` (`size:mtime`) mismatch | fingerprint mismatch revalidates the pair, then rescans |
| binary moved / installed elsewhere | nothing found at the old path | registry, running process, PATH, then a bounded scan |
| keyring target renamed | read returns nothing under the old name | full credential scan, next candidate adopted |
| refresh token rotated | `invalid_grant` / 401 | store re-read; if the token did not move, the pair is rescanned |
| fallback pair cached, install reappeared | pair works but is not the account's own | fallback-sourced cache is treated as weak and re-resolved from the binary |

State in `~/.gemini/antigravity-direct/`:

- `credentials.json` — `client_id`, `client_secret`, `source` (`binary` / `fallback` / `cache`), `binary_fingerprint`, `keyring_target`
- `token.json` — `refresh_token`, `access_token`, `expiry`, account email, token source
- `config.json` — local `api_key`, chosen `default_model`, optional `binary_path`
- `models.json` — last live catalog (10 minute TTL)

`--recheck` throws the derived state away and rebuilds from the installed
client. `--doctor` reports every link without changing anything.

### Verified recovery on this host

| injected fault | result |
|---|---|
| cached client id/secret replaced with bogus values, access token expired | rescan → `healed-ok`, source back to `binary` |
| cached refresh token replaced with a fake | store re-read → `token-healed` |
| keyring target renamed to `bogus:gone` | scan adopts `gemini:antigravity` again |
| `USERPROFILE` pointed at an empty profile, no config, no cache | binary found via running process, keyring still per-user, catalog live, all OK |
| cached pair marked `fallback` while a real binary exists | upgraded to `binary` (235 MB, `agy.exe`) |

## Models, tiers, Google AI Pro

The catalog is asked of the backend per account, so tiers differ by themselves:

```
node agy-direct\cli.mjs --models              # grouped, live, addressable only
node agy-direct\cli.mjs --models --all        # include internal/tab slots
node agy-direct\cli.mjs --models --quota      # merge per-model quota + reset time
node agy-direct\cli.mjs --models --google     # --claude --gpt --provider openai
node agy-direct\cli.mjs --models --json --refresh
node agy-direct\cli.mjs --pick                # numbered picker, saves default_model
```

`--models` prints the backend's own grouping ("Recommended", …), provider,
context window, thinking support and remaining quota. This account (free-tier)
sees 36 entries, 31 addressable; a Google AI Pro / standard-tier or Ultra
account gets its own list from the same call — no branch in the code.

Tier check: `node agy-direct/cli.mjs --tier`. On this account it reports
`current_tier: free-tier`, `paid_tier: g1-pro-tier`, project `aicode-consumers`,
which is why the upgrade line offers AI Pro / Ultra.

### Live probe — every Google model, one request each

`node agy-direct/cli.mjs --probe` sends `Reply with exactly: ok` to each model and
reports status, latency, tokens and the resolved backend name. `--probe --all`
covers Claude/GPT too, `--probe --model <id>` checks one.

```
gemini-4-argon-medium          OK    5702ms  ok  in=36 out=5 think=0   gemini-4-argon-trial
gemini-4-argon-high            OK    6687ms  ok  in=36 out=5 think=0   gemini-4-argon-trial
gemini-4-hydrogen-high         OK    2476ms  ok  in=36 out=5 think=35  gemini-4-hydrogen
gemini-4-hydrogen-xhigh        OK    1692ms  ok  in=36 out=5 think=33  gemini-4-hydrogen
gemini-pro-orchestrator-g1-pro OK    5115ms  ok  in=36 out=5 think=0
gemini-3.8-flash-low           OK    3247ms  ok  in=6  out=1 think=114 gemini-3.8-flash-n
gemini-3.8-flash-tiered        OK    2030ms  ok  in=6  out=1 think=65  gemini-3.8-flash-tiered
gemini-2.5-flash               OK     573ms  ok  in=6  out=1 think=0
gemini-2.5-pro                 FAIL   227ms  no capacity     503
gemini-4-carbon-disabled       FAIL   425ms  unavailable     404 (ships with a null quota)
gemini-3.1-flash-image         OK    1452ms  ok  in=6  out=1
gemini-3-flash / 3.1-flash-lite / 3.5-flash-lite / 2.5-flash-*     all OK, 500–1000ms
gemini-4-hydrogen-sonar        OK    2771ms  ok
gemini-4-hydrogen-tiered-*     OK    1865–2141ms  ok
```

22/24 answered. The two failures are server-side facts, not client bugs:
`gemini-4-carbon-disabled` returns 404 by design, `gemini-2.5-pro` returned 503
"no capacity available for model" at the time of the run.

Note on thinking models: a 32-token output cap gets spent on thoughts and returns
empty text. The probe uses 512 and reports `think=N` so an empty answer is never
mistaken for a broken model.

## API surface

| endpoint | what it is |
|---|---|
| `POST /v1/chat/completions` | OpenAI chat, streaming and non-streaming, `tools` / `tool_choice` / `tool_calls` |
| `POST /v1/completions` | legacy text completion |
| `GET /v1/models` | live catalog (`?quota=1`, `?refresh=1`) |
| `GET /v1/models/{id}` | one model |
| `GET /v1/quota` | live buckets: `gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`, `gemini-argon-wtu-weekly` |
| `GET /v1/tier` | tier, allowed tiers, paid tier, project |
| `GET /v1/doctor`, `GET /health` | self-check, no model quota consumed |

### The API key

`--key-gen` mints `agy_<32 hex>` and stores it in `config.json`; the server picks
it up with no env var. Clients send it as `Authorization: Bearer`, `x-api-key` or
`api-key`. `AGY_TOKEN` overrides the stored key.

`--selftest` boots the shim on a throwaway port and proves the contract end to
end — 9/9 on this host:

```
PASS  health                 account=…@gmail.com models=31
PASS  models_no_key_401      rejected without key
PASS  models_with_key        31 models
PASS  api_key_header         x-api-key accepted
PASS  chat_no_key_401        rejected without key
PASS  chat                   "selftest-ok" tokens=112
PASS  chat_stream            6 frames
PASS  tool_call              read_file({"path":"C:\\Windows\\win.ini"})
PASS  quota_endpoint         5 buckets
```

## Tool calling

OpenAI `tools` → Gemini `functionDeclarations` (schema sanitised to accepted
keywords), `tool_choice` → `toolConfig` (`auto`→`AUTO`, `required`→`ANY`,
`none`→`NONE`, `{function:{name}}`→allowed names). Responses come back as OpenAI
`tool_calls` with `finish_reason: "tool_calls"`; `tool` role messages replay as
`functionResponse` parts.

Gemini 3+ refuses to replay a `functionCall` without its `thoughtSignature`, and
no OpenAI client round-trips vendor fields, so the signature is packed into the
tool-call id (`call_…_ts_<base64url>`) and unpacked on the way back in — opaque
to the caller, correct upstream.

Verified two-turn loop on `gemini-3.8-flash-low` and `gemini-4-hydrogen-high`,
stream and non-stream.

## Are these coding models?

Same weights as the API serves — Gemini 4 Argon / Hydrogen, Gemini 3.8 Flash,
Claude Opus 5.5 / Sonnet 5.5, GPT-OSS 120B — and not fine-tuned for coding: they
are general models answering without the Antigravity prompt at all. What the
harness added was scaffolding, not capability: the 16.5k system prompt, the 14
tool declarations, the agent loop, the Proctor rater, the 230 MB process, the
hub. All client-side, all gone, replaced by the tool-calling loop here on the
same backend and the same quota — so any OpenAI-compatible coding agent works.

Quota is the coding quota (`aicode-consumers`, tier-dependent buckets).
`/v1/quota` and `--models --quota` read the live numbers.

## Still not ours

- The content filter on request text — refusals arrive as a normal 200 with
  `This request was blocked by Gemini's filters…` in `candidates[].text`.
- Model-level refusals.
- Per-account quota.

## Env

`AGY_MODEL`, `AGY_PORT`, `AGY_HOST`, `AGY_TOKEN`, `AGY_CONCURRENCY` (4),
`AGY_TIMEOUT_MS`, `AGY_THINKING_LEVEL`, `AGY_TOOLS=0`, `AGY_PROJECT`,
`AGY_BASE_URL`, `AGY_TOKEN_DIR`, `AGY_REFRESH_TOKEN`, `AGY_EMAIL`, `AGY_BIN`,
`AGY_MODELS_JSON`, `AGY_MODELS_TTL_MS`, `AGY_SHOW_THOUGHTS=1`, `AGY_JSON=1`.

Thinking levels are per-model and server-validated: argon `MINIMAL|MEDIUM|HIGH`,
hydrogen accepts `XHIGH`, opus-high fixed. A level the model does not have returns
400 `Thinking level X is not supported for this model`.

## Notes

- `token.json` holds a live refresh token — a credential. User-profile ACL, never
  commit, delete when done.
- Everything is per-Windows-user: a second account gets its own keyring entry and
  its own state directory.
- `agy-api/server.mjs` stays for the case where the harness prompt is wanted.
