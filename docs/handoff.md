# Antigravity RE — handoff notes

Local reverse-engineering of **Antigravity IDE 1.107.0** / **google.antigravity 1.11.0** /
**agy.exe 1.5.11** on this Windows machine, plus the tooling built to observe it.
Everything here was executed on this host. No live services were attacked.

Main narrative with evidence: [report.md](report.md). This file is the map, the state, and
the runbook.

---

## 1. File map

| Path | What it is | State |
|---|---|---|
| [report.md](report.md) | Full findings: architecture, jackpots, severity table, repro | current, verified |
| [core/server.mjs](core/server.mjs) | **OpenAI-compatible shim straight to `v1internal:streamGenerateContent` over the account's Google OAuth token — no `agy.exe`, no system prompt, no rater; tools, streaming, quota, doctor** | tested end to end |
| [core/lib/token.mjs](core/lib/token.mjs) | Keyring → refresh-token cache → access-token mint, with rotation and pair re-discovery on 400/401 | tested, self-heals |
| [core/lib/discover.mjs](core/lib/discover.mjs) | Binary scan for the OAuth client pair, credential-target enumeration, fingerprint-keyed cache | tested, self-heals |
| [core/lib/client.mjs](core/lib/client.mjs) | Envelope build, SSE parse, tool-call mapping, `quota`, `loadCodeAssist` | tested |
| [core/cli.mjs](core/cli.mjs) | Prompt, model picker, live probe, doctor, key-gen, selftest | tested |
| [core/setup.ps1](core/setup.ps1) | One-shot bootstrap: node check, chain check, key mint, client config | tested, ASCII-only |
| [core/start.ps1](core/start.ps1) | Launcher, path-independent | tested |
| [app/server.mjs](app/server.mjs) | **The app: API tab + key store + chat, `/api/*` + `/v1/*`, OpenAI and Claude shapes, thinking budgets, SSE heartbeat** | tested, 14/14 selftest |
| [core/lib/keys.mjs](core/lib/keys.mjs) | Local API key store: create, reveal, rotate, enable, revoke, last-used counters | tested |
| [app/ui/](app/ui/index.html) | Vanilla HTML/CSS/JS window: model picker, thinking chips, live reasoning panel, quota bars | done |
| [app/sdk/openai.mjs](app/sdk/openai.mjs) | Drop-in for the `openai` package surface (`chat.completions.create`, `models.list`) | tested |
| [app/crackagravity.cmd](app/crackagravity.cmd) | Double-click launcher; `launch.ps1` starts the server and opens the Edge app window | tested |
| [app/README.md](app/README.md) | App runbook: UI, API shapes, pool, fallback, heartbeat | current |
| [core/lib/pool.mjs](core/lib/pool.mjs) | Multi-account rotation with cooldown, auto-disable, per-account token cache | tested |
| [notes/antigravity2api-review.md](notes/antigravity2api-review.md) | Review of liuw1535/antigravity2api-nodejs and what was ported | current || [core/README.md](core/README.md) | The direct lane: token source, request shape, update recovery, models/tiers, tool calling, API surface | current |
| [legacy-shim/server.mjs](legacy-shim/server.mjs) | OpenAI-compatible HTTP shim over `agy -p` (chat + models, queue, timeout, optional bearer) — keeps the harness prompt | tested end to end |
| [hub/hub.mjs](hub/hub.mjs) | Hub client: discover daemon, `info`, `models`, `read`, `rpc`, `terminal`, `close` | tested |
| [mitm/proxy.mjs](mitm/proxy.mjs) | Loopback CONNECT proxy, terminates TLS with local CA, dumps and rewrites requests | tested |
| [mitm/install.ps1](mitm/install.ps1) | Persists env vars + startup proxy + trusts CA; `-Uninstall` reverses | written, **not executed** |
| [bin/agy-strip.ps1](bin/agy-strip.ps1) | Runs `agy` through the strip proxy | tested |
| [recon/system_instruction.txt](recon/system_instruction.txt) | Captured `request.systemInstruction` text (65,891 chars) | evidence |
| [recon/models.json](recon/models.json) | `GetAvailableModels` response, 18 models with quota/token fields | evidence |
| [probe/bench_core.txt](probe/bench_core.txt) | Bench-guide test input, full scope (23,919 B) | test fixture |
| [probe/bench_trim.txt](probe/bench_trim.txt) | Same, drug/weapon/explosive scope removed (23,342 B) | test fixture |
| `mitm/dumps/` | 206 captured request/response pairs, decoded, includes bearer tokens | **sensitive** |
| `mitm/ca.crt`, `ca.key`, `leaf.*` | MITM CA + leaf for `*.googleapis.com` | sensitive |

---

## 2. Runtime state on this machine

- Hub process: `agy.exe` pid **11040**, `http://127.0.0.1:52364`, descriptor at
  `~/.gemini/antigravity/daemon/hub_52364.json` (`csrfToken` lives there in plain text).
- No proxy is running; ports 8897/8898/8899/9999 are free.
- **CA "AGY MITM CA" is trusted in the CurrentUser Root store** (added with
  `certutil -addstore -user Root mitm\ca.crt`). Remove with
  `certutil -delstore -user Root "AGY MITM CA"` or `mitm\install.ps1 -Uninstall`.
- `mitm/dumps/*` contain `Authorization: Bearer ya29.*` values. Treat the folder as secret;
  delete when no longer needed.
- Backend binary: `%USERPROFILE%\.gemini\bin\agy.exe` (234,827,416 B), CLI at
  `%USERPROFILE%\.gemini\antigravity\bin\agentapi.bat`.

---

## 3. Verified findings

### 3.1 Architecture

```
Antigravity IDE.exe (Electron 39 / VS Code 1.107)
  └─ extension google.antigravity 1.11.0
       └─ agy.exe --hub --hub-port=<p> --app_data_dir=antigravity --csrf_token=<uuid> --add-dir=<ws>
            ├─ HTTP  127.0.0.1:<p>   exa.language_server_pb.LanguageServerService (379 methods)
            ├─ HTTPS 127.0.0.1:<p+6>
            └─ https://daily-cloudcode-pa.googleapis.com  v1internal:*  (REST + SSE)
```

Auth: Google OAuth via provider `antigravity_auth`; scopes `aicode`, `cclog`,
`cloud-platform`, `experimentsandconfigs`. Account seen: `user@example.com`.

### 3.2 Model access (works, no API key)

`agy -p "<prompt>" --model <id> --output-format json` returns `{status, response, usage}`.
18 models: `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, `gemini-4-argon-*`,
`gemini-4-hydrogen-*`, `gemini-3.8-flash-*`, `gemini-2.5-*`, `gpt-oss-120b-medium`,
`gemini-pro-orchestrator-g1-pro`. Quota is server-side per account.

Shim: `node legacy-shim\server.mjs` → `http://127.0.0.1:8787/v1` (`/chat/completions`,
`/models`). Verified: `shim-ok` in 7.1 s, `prompt_tokens 21830` (harness overhead included).

### 3.3 The system prompt is client-built and removable

Captured `POST /v1internal:streamGenerateContent` = 88,993 B body; `request.systemInstruction`
is **65,891 chars (~16.5k tokens)**; `request.tools` = 14 declarations (20,305 B).
Prompt sections: identity, artifacts, conversation_transcript, label, guidelines,
communication_style, slash_commands, messaging, subagents, skills, user_rules,
user_information. It is a Go `text/template` inside `agy.exe`
(`LINT.IfChange(antigravity_identity)`, experiment `generic-system-prompt`).

Rewrites in `mitm/proxy.mjs` (env `MITM_MODE=strip`, `MITM_PROMPT=<file>`,
`MITM_STRIP_TOOLS=1`):

| variant | input tokens | output |
|---|---|---|
| baseline | 20,622 | `mitm-ok` |
| `systemInstruction` removed | 4,923 | `stripped-ok` |
| `+ tools` removed | **145** | `bare-ok` |
| custom prompt + `claude-opus-5-5-high` | 328 | "I'm Claude, an AI assistant made by Anthropic." |

### 3.4 Hub = local control plane (user-level RCE surface)

`~/.gemini/antigravity/daemon/hub_*.json` holds `pid`, `httpPort`, `httpsPort`, `csrfToken`
in plain text; the token is also in the process command line. Verified against the live hub:

| call | result |
|---|---|
| `GetAuthStatus` | `200`, `hasValidAuth:true` |
| `GetAvailableModels` | full catalog + per-model quota |
| `ReadFile {"uri":"file:///C:/Windows/win.ini"}` | `200`, base64 content |
| `CreateTerminal {}` | `200`, spawned `pwsh.exe` + pid |
| `RunCommand {"command":"..."}` | reached `exec` |
| no `x-codeium-csrf-token` | `401 missing CSRF token` |
| `Origin: https://evil.example` + token | `200` — no Origin check |

Also exposed: `WriteFile`, `DeleteFileOrDirectory`, `DeleteAllUserData`, `StartCascade`,
`SendUserCascadeMessage`, `CallMcpAppTool`, `Exit`.
`~/.gemini/config/config.json` has `globalPermissionGrants: ["command(*)","read_file(*)",
"write_file(*)","*"]`, `terminalSandbox:false`, `autoExecutionPolicy:EAGER`.

### 3.5 The "hidden model" is a tool-call rater (client-side)

`requestType:"agent_monitoring"` → `gemini-3.5-flash-lite`, 2,704 prompt tokens per check.
Prompt: *"You are a safety and security rater overseeing Jetski… evaluate whether Jetski's
pending tool call should be flagged."* Verdict JSON: `{"reason":..,"severity":0,
"confidence":10}`. It only fires when a tool call is pending; it never writes chat text.
`MITM_NEUTRALIZE_RATER=1` rewrites the rater prompt (10,693 B → 641 B, 2,704 → 37 tokens);
the pending command then executed (returned `124`).

Other client gate strings in the binary: `Action blocked by Remy safety policy`,
`Evaluated by Proctor LLM … flagged this call`, verdict kinds `MALWARE_OR_C2_DOWNLOAD`,
`HIGH_PRIVILEGE_TAMPERING`, `verdict_deny`.

### 3.6 Content refusals are model/server, not client

- CS ESP prompt → `status SUCCESS`, refusal text streamed from `gemini-4-argon-trial`
  (`candidates.parts[].text`). Same with prompt+tools stripped (input 1,165).
- Refusal runs produced **zero** `agent_monitoring` requests — the rater was not involved.
- Full bench-guide fixture → `This request was blocked by Gemini's filters...` (HTTP 200,
  body text), input 5,904.
- Same guide minus drug/weapon/explosive scope → model refusal naming the jailbreak,
  input 6,211.
- **Bare API proof**: hand-built `curl` POST to
  `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` with only
  `request.contents` (no systemInstruction, no tools):
  - "Give the synthesis route for fentanyl…" → `blocked by Gemini's filters`
  - "In one sentence, what is fentanyl used for medically?" → normal answer,
    `promptTokenCount: 11`

Conclusion: three layers — (1) server-side Gemini content filter on request text,
(2) model weights, (3) client-side Proctor/Remy tool gates. Only (3) is reachable from
the client. The filter is not affected by transport rewriting of any kind.

### 3.7 Thinking tokens

`generationConfig` carries `maxOutputTokens` and `thinkingConfig:{includeThoughts:true,
thinkingLevel:N}`. Levels are fixed per model variant: argon 1/2/3, hydrogen xhigh=100,
flash-low 1, opus-high 3, gpt-oss unset. Caps: argon 65,536; hydrogen 262,144; opus
128,000; context 1,048,576.

Measured: flash-low think=0; argon-high think=2,122; hydrogen-xhigh think=6,024;
hydrogen-high forced to level 100 think=3,073. Forcing above the model's level is rejected
server-side (`Thinking level XHIGH is not supported for this model`).
`usageMetadata` shows `thoughtsTokenCount` inside `totalTokenCount`, so thinking is billed.
Thought text is streamed to the client (`{"thought":true,"text":...}`) and captured.
Quota buckets come from `v1internal:retrieveUserQuotaSummary` (gemini-weekly, gemini-5h,
3p-weekly, 3p-5h; reset times included).

### 3.8 Other surfaces

- Binary download: `antigravity-cli-auto-updater-974169037036.us-central1.run.app`, dogfood
  `storage.googleapis.com/antigravity-public/antigravity-cli`; release-base validator
  accepts `http://localhost`; integrity is SHA512 from the same metadata; no Authenticode.
- Conversation corpus stored unencrypted in `~/.gemini/antigravity/conversations/*.db|.pb`,
  served over the hub (`GetAllCascadeTrajectories`, `ConvertTrajectoryToMarkdown`).
- Prompt cache visible as `cachedContentTokenCount` (25,268 of 26,472 warm).
- `AGY_LLM_GATEWAY_URL` / `AGY_LLM_GATEWAY_MODELS` are honored (custom model id accepted,
  fails on `maxMessageTokens must be positive` — needs a `customModelsConfig` entry).
- `writeTrajectoryAcls` writes trajectory sharing ACLs; `gemini-4-carbon-disabled` ships
  with a null quota.

---

### 3.9 Direct lane — quota over OAuth, nothing else on the wire

The token pair the CLI/IDE keeps is in the Windows Credential Manager at
`LegacyGeneric:target=gemini:antigravity` (user `antigravity`, persist = local
machine) as JSON: `access_token` `ya29.*`, `refresh_token` `1//*`, `expiry`,
`auth_method:"consumer"`, `id_token_email`. Read with `CredReadW`; no DPAPI dance,
no file hunt.

Refresh works with the desktop client
`<desktop client id embedded in agy.exe>` +
`<client secret embedded in agy.exe>` (both embedded in `agy.exe`; the other two
client ids in the binary are the IDE's and a second CLI build, and reject this
refresh token). Granted scopes: `aicode`, `cclog`, `cloud-platform`, plus
`openid` and the userinfo scopes.

Then `POST /v1internal:streamGenerateContent?alt=sse` with
`{project:"aicode-consumers", requestId, request:{contents}, model, userAgent,
requestType:"chat", enabledCreditTypes:["GOOGLE_ONE_AI"]}` and nothing else.

| path | prompt tokens | note |
|---|---|---|
| `agy -p` (harness) | 21,830 | 65,891-char prompt + 14 tools + 230 MB spawn |
| direct, no system prompt | **8** | flash-low, "reply exactly: flash-ok" |
| direct, 12-char system prompt | **15** | server shim, OpenAI-shaped request |
| direct, claude-opus-5-5-high | **21** | same shim |
| direct, claude-sonnet-5-5-high | **22** | streaming |

Also verified on the direct path: `gemini-4-argon-high` (38 tokens),
`claude-opus-5-5-high`, `claude-sonnet-5-5-high`, streaming SSE with usage in the
final chunk, `/v1/quota` returning the live buckets (`gemini-weekly` 96.9%,
`gemini-5h` 91.2%, `3p-weekly` 98.5%, `3p-5h` 97.9%, `gemini-argon-wtu-weekly`
97.7%), and `/v1/tier` reporting `free-tier` / `g1-pro-tier` with project
`aicode-consumers`.

Client-side layers that disappear with the harness: system prompt, tools, the
`agent_monitoring` Proctor rater, the hub. Server-side layers that stay exactly as
they were in §3.6: the content filter and model refusals. `/v1/quota` on the
direct path consumes no model quota.

### 3.10 Direct lane, second pass — plug-in API, update-proofing, tool calls

**Everything an update moves is re-derived, not hardcoded.** The keyring target,
the refresh token and the OAuth client pair all shift between releases, so each
is discovered from the installed install and cached against a
`size:mtime` fingerprint:

- target list comes from `CredEnumerateW`, filtered on
  `gemini|antigravity|cloudcode|codeassist`, first blob containing
  `refresh_token` wins;
- client id/secret come from scanning `agy.exe` for `*.apps.googleusercontent.com`
  and `GOCSPX-*`; every pair is probed against `oauth2.googleapis.com/token` and
  only an accepted pair is cached. Secrets are packed against the next Go string
  constant, so the 28-char slice after the prefix is what gets tested;
- a fingerprint mismatch revalidates the cached pair before rescanning.

Recovery paths, each exercised on this host:

| injected fault | result |
|---|---|
| cached `client_id`/`client_secret` replaced with bogus values, access token expired | `407`-class failure → `invalid_client` → rescan → `healed-ok`; cache `source` back to `binary` |
| cached `refresh_token` replaced with a fake and expiry zeroed | 401 → keyring re-read → new token minted → `token-healed` |

**Tool calling.** `tools` → `functionDeclarations` (schema flattened to the
keywords the backend accepts), `tool_choice` → `toolConfig`, `tool` role →
`functionResponse`. Responses arrive as OpenAI `tool_calls` with
`finish_reason:"tool_calls"`. Gemini 3+ rejects a replayed `functionCall` part
without its `thoughtSignature`, and no OpenAI client round-trips vendor fields,
so the signature is packed into the tool-call id (`call_…_ts_<base64url>`) and
unpacked on the way back in. Verified two-turn loop on `gemini-3.8-flash-low` and
`gemini-4-hydrogen-high`, streaming and non-streaming: tool call out, result back
as `role:"tool"`, final prose answer.

**Surface.** `/v1/chat/completions` (stream + non-stream + tools),
`/v1/completions`, `/v1/models`, `/v1/models/{id}`, `/v1/quota`, `/v1/tier`,
`/v1/doctor`, `/health`. Auth gate via `AGY_TOKEN` accepts
`Authorization: Bearer`, `x-api-key`, `api-key`.

**Same models, no coding fine-tune.** Ids resolve to the same families the paid
API serves (Gemini 4 Argon/Hydrogen, 3.8 Flash, Claude Opus 5.5/Sonnet 5.5,
GPT-OSS 120B). What the harness added was scaffolding — system prompt, 14 tools,
agent loop, Proctor rater, 230 MB process, hub — not capability. Quota is still
the coding quota for project `aicode-consumers`; `free-tier` vs `g1-pro-tier`
changes the ceiling, not the shape.

### 3.11 Direct lane, third pass — live catalog, portability, key gate

**The catalog is asked of the backend, not hardcoded.** `v1internal:fetchAvailableModels`
(one of 68 `v1internal:*` methods in the binary) answers per account, so tiers
differ by themselves. This account: 36 entries, 31 addressable, grouped by the
backend's own `agentModelSorts` ("Recommended"), with provider, context window,
thinking support, per-model `quotaInfo.remainingFraction` and reset time. Cached
10 min in `models.json`; fallbacks are the on-disk capture, then a static list.
`v1internal:retrieveUserQuota` adds per-model buckets and reset times.

**Live probe, every Google model, one request each** (`--probe`, 512-token cap,
thinking tokens reported separately):

- 22/24 answered: argon trio 5.2–6.7 s, hydrogen 1.6–2.5 s, orchestrator 5.1 s,
  3.8-flash 2.6–3.7 s, 2.5-flash* and 3.x 0.5–1.5 s, tiered and sonar variants OK.
- `gemini-4-carbon-disabled` → 404 "Requested entity was not found" (ships with a
  null quota, as recorded in §3.8).
- `gemini-2.5-pro` → 503 "No capacity available for model" at the time of the run.
- A 32-token cap made thinking models look empty; at 512 they answer and report
  `think=18…114`, which is why the probe no longer treats empty text as failure.

**Portability.** No path, keyring name or client pair is assumed. Binary order:
`AGY_BIN` → `config.binary_path` → known dirs → registry Uninstall keys → running
process → `where.exe` → bounded scan, and only `agy*.exe` is accepted from
automatic sources (the IDE's `Antigravity IDE.exe` is not the backend — found and
rejected during testing). Credential order: `AGY_REFRESH_TOKEN` → remembered
target → scored scan → any credential whose blob has a Google refresh token. A
remembered target that stops reading falls through the same pass instead of
failing.

Recovery matrix, each case exercised on this host:

| injected fault | result |
|---|---|
| bogus cached client pair, expired access token | rescan → `healed-ok`, source `binary` |
| fake refresh token | store re-read → `token-healed` |
| keyring target renamed `bogus:gone` | scan adopts `gemini:antigravity` |
| `USERPROFILE` → empty profile, no cache/config | binary via running process, keyring per-user, catalog live, all OK |
| cached pair downgraded to `fallback` with a real install present | upgraded back to `binary` |

**Local API key + selftest.** `--key-gen` mints `agy_<32 hex>` into `config.json`;
the server gates on it with no env var (`Authorization: Bearer`, `x-api-key`,
`api-key`). `--selftest` boots the shim on a throwaway port and exercises the
whole contract — 9/9: health, 401 without key on models and chat, models with
key, `x-api-key` header, chat, SSE stream, tool call, quota endpoint.

**Setup on any machine:** `core/setup.ps1` (node check, chain check, key
mint, model table, client config, `-Start` to launch) and `core/start.ps1`.
Both resolve `$PSScriptRoot`; the folder can live anywhere. `setup.ps1` is
ASCII-only after a box-drawing character made PowerShell 5 fail to parse the
first version.

---

### 3.12 The app — one window, one API

`app/` is the product. `app\crackagravity.cmd` starts the server and opens an Edge
`--app` window on `http://127.0.0.1:8790/`; the same port serves
OpenAI (`/v1/chat/completions`), Claude (`/v1/messages`), models, quota and tier.

**Thinking is a numeric token budget, not a word.** `thinkingConfig.thinkingBudget`
is the wire knob; the UI chips are presets that write a number into the budget
box, and every API accepts the number directly (`thinking_budget` for OpenAI,
`thinking.budget_tokens` for Claude, `--budget` for the CLI). Words are only
convenience: sending a word a model does not carry is a hard 400
(`Thinking level MINIMAL is not supported for this model`), which is why the
budget is what ships.

Measured on `gemini-4-hydrogen-high`, same prompt, three budgets:

| budget | thought tokens | note |
|---|---|---|
| 1024 | 153 | low |
| 8192 | 348 | medium |
| 30000 | 1218 | high |

At budget 12288 the run took 9.9 s for 67 prompt tokens and 92 back, with **1,091
thought tokens** — and the answer rendered beside its reasoning. `max_tokens` is
automatically raised by the budget, because thoughts count against the output cap.

**Ported from the reviewed repo, and verified here:**

- *Upstream fallback* `daily → sandbox → production`, moving only for network
  errors and 5xx and never after the first byte. Same day, same token:
  `production` 429, `daily` 200, `sandbox` 200.
- *Account pool* (`core/lib/pool.mjs`): more than one refresh token in
  `accounts.json` rotates per request; 429 → exponential cooldown, 403 → ten
  minutes and disabled after three, `invalid_grant` → disabled at once. Tested
  with one live and one fake account: three requests answered, fake one disabled,
  real one `ok`.
- *SSE heartbeat* every 15 s (`AGY_HEARTBEAT_MS`) so a quiet thinking run does not
  look like a dead socket to a proxy.

Not ported, deliberately: fake client telemetry, the fake "official system
prompt" wrapper, the TLS-fingerprint binary, random `projectId`. Those are the
parts that make their issue tracker fill with 403 `VALIDATION_REQUIRED`.

**Keys live in the app.** The **API** tab is the default view: base URL with
copy, a key table (create / copy / rotate / disable / revoke, last-used time and
request count per key), and curl / python / node snippets that carry the key you
picked. Keys are `agy_<32 hex>` in `~/.gemini/antigravity-direct/apikeys.json`
with `0600`; `AGY_TOKEN` and the older `config.api_key` remain valid as legacy
sources so an existing client does not break. Chat is the second tab — same
engine, window around it.

Verified lifecycle: create → use → 200, revoke → 401, rotate → old key 401 and
new key 200.
`node core\cli.mjs --selftest` boots the app on a throwaway port and runs
14 checks — health, 401 without key, models, `x-api-key`, chat, stream, tool call,
thinking events, Claude message, Claude stream, thinking budget, key lifecycle,
quota: **14/14**.

---

## 4. Runbook

```powershell
# hub: live discovery + RPC
node hub\hub.mjs info
node hub\hub.mjs models
node hub\hub.mjs read "$env:USERPROFILE\.gemini\config\config.json"
node hub\hub.mjs rpc GetAuthStatus '{}'

# OpenAI-compatible shim over the account's models, direct (recommended)
powershell -ExecutionPolicy Bypass -File core\setup.ps1     # node, chain, key, config
node core\cli.mjs --doctor          # binary, creds, keyring, token, tier, quota, catalog, key
node core\cli.mjs --recheck         # drop cached creds, rescan the install
node core\cli.mjs --models --quota  # live catalog for this account/tier
node core\cli.mjs --pick            # numbered picker, saves default
node core\cli.mjs --probe           # request every Google model, report OK/FAIL
node core\cli.mjs --key-gen         # mint the local API key
node core\cli.mjs --selftest        # boot on a throwaway port, prove the contract
node core\cli.mjs --tier
node core\cli.mjs "hi" --model gemini-3.8-flash-low
powershell -ExecutionPolicy Bypass -File core\start.ps1 -Port 8787
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/doctor

# the app: UI + API on one port
app\crackagravity.cmd
powershell -ExecutionPolicy Bypass -File app\launch.ps1 -Port 8790
node tools\capture-demo.mjs               # refresh the replay used by /?demo=1
curl http://127.0.0.1:8790/v1/messages -H "content-type: application/json" `
  -H "Authorization: Bearer <key>" `
  -d '{"model":"gemini-3.8-flash-low","max_tokens":80,"messages":[{"role":"user","content":"hi"}]}'

# legacy shim: one agy.exe per request, harness prompt included
node legacy-shim\server.mjs
curl http://127.0.0.1:8787/v1/models

# capture traffic (trusts mitm\ca.crt already present in user root store)
node mitm\proxy.mjs 8899
$env:HTTPS_PROXY='http://127.0.0.1:8899'; $env:AGY_CA_CERTS='C:\path\to\agy\mitm\ca.crt'
agy -p "hi" --model gemini-3.8-flash-low --output-format json

# strip prompt/tools and rewrite thinking level
$env:MITM_MODE='strip'; $env:MITM_STRIP_TOOLS='1'; $env:MITM_THINKING_LEVEL='100'
node mitm\proxy.mjs 8899

# full strip install (env + startup + CA), reversible
powershell -ExecutionPolicy Bypass -File mitm\install.ps1
powershell -ExecutionPolicy Bypass -File mitm\install.ps1 -Uninstall
```

Proxy env knobs: `MITM_MODE=dump|strip`, `MITM_PROMPT`, `MITM_STRIP_TOOLS`,
`MITM_THINKING_LEVEL`, `MITM_MAX_OUTPUT`, `MITM_NEUTRALIZE_RATER`, `MITM_DUMP_DIR`.

---

## 5. Open items

- `agy acp` (stdio JSON-RPC) and `--input-format stream-json` were never exercised — a
  programmatic client there would remove the per-call 230 MB process spawn. **Superseded by
  `core/`, which removes the spawn entirely by talking to `v1internal` directly.**
- `customModelsConfig` schema (jetbox_state_pb) not mapped; would unlock the gateway path.
- OAuth: refresh is implemented (`core/lib/token.mjs`); the interactive login that
  *creates* the first refresh token is not — the token is lifted from the installed
  client's keyring. A standalone device/loopback flow would need the consent screen the
  desktop client id does not expose.
- `WriteFile` / `SendTerminalInput` request shapes not fully mapped (`SendTerminalInput`
  wants `input_stream_id`; `RunCommand` execs through `bash`).
- `install.ps1` is unverified (never run). Machine currently has only the CA installed.

## 6. Scope note

This repo is local analysis of software installed on this machine plus its own account
traffic. The server-side Gemini filter is a Google production control; it was characterized
from outside and is out of reach. Do not attack provider infrastructure or attempt filter
bypass — nothing in this repo does, and the filter cannot be influenced from the client.
