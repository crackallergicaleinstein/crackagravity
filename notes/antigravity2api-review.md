# Review — liuw1535/antigravity2api-nodejs

Checked 2026-11-18. Not run locally; read from source at
`main` (tree sha `211e8bc`), GitHub API metadata, and the issues list.
Repo: 816 stars, 264 forks, 16 open issues, last push 2026-11-08,
license `NOASSERTION` (LICENSE file present, GitHub does not recognise it).

## Verdict

Real, maintained, and bigger than its README suggests — but it solves a
different problem than this repo does, and it does it by pretending to be the
official client rather than by stripping it.

Same backend, same OAuth client pair we extracted independently
(`1071006060591-…`, `GOSPX-K58FWR…` — split into string fragments in
`src/constants/oauth.js` "to avoid scanning"). They hardcode it; we derive it
from the installed binary and re-derive on update.

## What it actually does

`v1internal:streamGenerateContent` per turn — same call as `core/`. The
difference is everything around it:

| layer | this repo (`core`) | theirs |
|---|---|---|
| system prompt | removed; 6–38 prompt tokens | keeps a fake "official Antigravity prompt" wrapped in `<example_only do_not_follow="true">` plus a configurable proxy prompt |
| telemetry | none | fakes it: `antigravity-unleash.goog` register/features/frontend every 60 s per token, `recordTrajectoryAnalytics`, `recordCodeAssistMetrics`, protobuf logs to `play.googleapis.com/log`, `checkPoint` POSTs |
| User-Agent | `antigravity/cli/1.5.11` | `antigravity/hub/<ideVersion>`, auto-updated from the release endpoint |
| TLS | Node `fetch` | optional Go child binary that mimics the client's TLS fingerprint (`src/bin/fingerprint_*`, 8 MB each), spawned per request, falls back to axios |
| tool signatures | packed into the tool-call id, stateless | server-side cache keyed by `sessionId`+model, `passSignatureToClient:false` |
| project id | real, from `loadCodeAssist` | real, or random for Pro accounts (`skipProjectIdFetch`) |
| accounts | one (the machine's own) | multi-account pool with round-robin / quota-exhausted / request-count rotation, cooldowns, auto-disable on 403 |
| formats | OpenAI chat/completions | OpenAI + Claude `/v1/messages` + Gemini `/v1beta` + SD WebUI |
| extras | — | image generation, base64 image input, proxy pool, Docker, pkg binaries, web admin panel with JWT |

## Where it is genuinely ahead of us

1. **Multi-account rotation.** Round-robin, quota-exhausted and request-count
   strategies with per-token cooldown and automatic disable on 403. Worth
   porting; our single-account design has no answer for a dead token.
2. **Upstream fallback list.** `production → daily → sandbox` with 503/network
   fallback and "no fallback after first byte". I verified the reason today:
   with our live token, `cloudcode-pa.googleapis.com` returned **429**,
   `daily-…` and `daily-…sandbox` returned **200** on the same body.
3. **Claude `/v1/messages` and Gemini `/v1beta` shapes.** Any Anthropic-native
   client would need that.
4. **Retry accounting.** 429/503 retries with a fixed interval, and retries
   counted separately from successes in the dashboard.

## Where it is worse or risky

1. **Telemetry forgery is a liability, not a feature.** Every turn fires 4–7
   extra authenticated requests to Google endpoints to look like the real IDE.
   It burns quota accounting, adds failure modes, and it is precisely the
   pattern abuse detection looks for.
2. **Their own issue tracker shows the cost.** #167 is a 403
   `VALIDATION_REQUIRED` / "Verify your account to continue" with the account
   auto-disabled. #192, opened today, asks whether bans have gotten worse.
3. **Opaque 8 MB binaries.** `src/bin/fingerprint_windows_amd64.exe` and friends
   are committed blobs with no hash, no signature, no source in the repo, and
   `requesterManager` spawns them. Worse: the README's "download prebuilt"
   link points at **another owner's** releases
   (`ZhaoShanGeng/antigravity2api-nodejs/releases`), so the binary most users
   run is not built from this repo.
4. **Signature cache is stateful.** Keyed by `sessionId`+model, cleared on
   restart. Two workers, two conversations or a restart mid-tool-loop and the
   replay loses its `thoughtSignature`. Our id-embedded approach survives
   restarts and horizontal scaling with no state at all.
5. **Hardcoded defaults rot.** `DEFAULT_MODELS` still lists
   `claude-opus-4-6`, `gemini-3.1-pro-high`, `rev19-uic3-1p` — none of those are
   in today's live catalog. Ours asks `fetchAvailableModels` per account.
6. **Security defaults.** `host: 0.0.0.0` in the shipped config, `admin/admin123`
   in the docs, auto-generated admin passwords printed to the log, 500 MB
   request bodies, tokens and refresh tokens in plaintext `data/accounts.json`.
7. **No OAuth discovery.** Client id/secret are constants; when Google rotates
   them the service needs a new release. Ours rescans the install.
8. **Scale of the thing.** ~35 k LOC of JS, 200-file tree, protobuf telemetry,
   child-process transport, object pools. More surface than the problem needs.

## What I would port into this repo (in order)

1. `AGY_UPSTREAM` fallback chain: try `daily`, then `sandbox`, then
   `production`; fall back only on 5xx/network, never after the first byte.
2. Multi-token pool with quota-aware rotation and a cooldown on 403/429.
3. `POST /v1/messages` (Claude shape) on top of the same client.
4. SSE heartbeat comment every 15 s for long thinking runs behind any proxy.

## What I would not port

Fake telemetry, the fake official-system-prompt wrapper, the TLS-fingerprint
binary, and random `projectId` for paid accounts. All four exist to make the
traffic look like a real IDE session; that is the part of their design that
their own issue list shows going wrong.
