# crackagravity — one window, one API

A Windows app around the direct Antigravity lane: chat with the account's own
quota, thinking control that actually changes the request, live reasoning in a
side panel, and an OpenAI/Claude-compatible API on the same port.

No build step, no npm dependencies, no bundled binaries. Node 20+ is the only
requirement.

```
app/
  crackagravity.cmd        double-click launcher (starts the server, opens the window)
  launch.ps1         same thing, with -Port / -NoWindow
  server.mjs         UI + /api/* + /v1/*
  ui/                index.html, styles.css, app.js (vanilla, no framework)
  sdk/openai.mjs     drop-in for the `openai` package surface, for machines without it
  examples/          openai-node.mjs — the docs call pattern, local
  shot*.png          screenshots
```

## Run

```powershell
app\crackagravity.cmd
# or
powershell -ExecutionPolicy Bypass -File app\launch.ps1 -Port 8790
```

The window is Edge in `--app=` mode at `http://127.0.0.1:8790/`. The server keeps
running after the window closes; `launch.ps1` reuses it on the next double-click.

## The UI

Two views, because the point is the API:

**API** (default) — base URL with copy, the key table, and a quickstart in curl /
python / node that carries whichever key you copy. This is where keys are made.

- create a key with a name, it is copied to the clipboard immediately
- per key: `copy` (clipboard + fills the snippets), `rotate` (new secret, same
  name, old one dies at once), `disable`/`enable`, `revoke`
- each row shows last-used time and request count, so a dead key is obvious
- `curl`, `python`, `node` snippets are generated with the live base URL, the
  selected model and the chosen key

**Chat** — the same engine with a window: transcript, thinking chips + numeric
budget, and the reasoning panel.

- **left rail** — account, live model picker (grouped by the backend's own
  "Recommended" order, with per-model quota), thinking chips, budget box, quota
  bars
- **right** — the reasoning stream as it arrives, TTFT / elapsed / tokens /
  thought tokens, backend provenance, self-check button

Thinking is a **token budget**, not a word. The chips are convenience presets
that write a number into the `budget` box; the number is what ships as
`generationConfig.thinkingConfig.thinkingBudget`. `auto` (budget 0) sends
`includeThoughts` only. The panel is the model's actual `thought` parts.

The backend honours the budget and rejects word levels a model does not carry
(`Thinking level MINIMAL is not supported for this model`), so words exist only
in the UI and in request convenience — on the wire it is always a number.

Measured on `gemini-4-hydrogen-high` with the same prompt:

| budget | thought tokens spent |
|---|---|
| 1024 | 153 |
| 8192 | 348 |
| 30000 | 1218 |

From code: `thinking_budget: 8192` (OpenAI shape), `thinking: {type:"enabled",
budget_tokens: 8192}` (Claude shape), `--budget 8192` (CLI), and
`thinkingBudget` on the internal envelope. `max_tokens` is raised by the budget
automatically, because thoughts are counted against the output cap.

The demo at `/?demo=1` replays a real captured stream (`ui/demo-stream.json`,
captured with `tools/capture-demo.mjs`) so screenshots do not have to wait out a
thinking model.

## The API

Two different credentials are involved, and they are easy to confuse:

| key | what it is | where it lives | who uses it |
|---|---|---|---|
| `agy_…` (local API keys) | gate for the app's own API | `~/.gemini/antigravity-direct/apikeys.json`, created and revoked in the **API** tab | your clients → this app |
| Google OAuth pair | the account's own quota | Windows Credential Manager `gemini:antigravity` → cached in `~/.gemini/antigravity-direct/token.json` | this app → Google |

Keys are managed from the app (API tab) and from the same-origin admin API:

| call | does |
|---|---|
| `GET /api/keys` | list (masked), legacy key presence, file path |
| `POST /api/keys {name}` | create, returns the full key once in the response |
| `POST /api/keys/{id}/reveal` | full key for the copy button |
| `POST /api/keys/{id}/rotate` | new secret, same name; old one stops working immediately |
| `POST /api/keys/{id}/enable {enabled}` | pause without deleting |
| `DELETE /api/keys/{id}` | revoke |

Verified lifecycle: create → use → revoke → 401, and rotate → old 401, new 200.
A legacy key from `AGY_TOKEN` or `config.api_key` keeps working alongside the
store, so an existing client does not break on upgrade.

Set `AGY_TOKEN` to override it; the app then requires that value instead.
Accepted headers: `Authorization: Bearer`, `x-api-key`, `api-key`. There is
also a same-origin session token injected into `index.html` so the UI can call
`/api/*` without holding the real key.

| endpoint | shape |
|---|---|
| `POST /v1/chat/completions` | OpenAI — stream, non-stream, `tools`, `tool_choice`, `reasoning_effort` |
| `POST /v1/messages` | Claude Messages — stream, non-stream, `tools` with `input_schema`, `thinking.budget_tokens` |
| `POST /v1/completions` | legacy text completion |
| `GET /v1/models`, `/v1/models/{id}` | live catalog, `?quota=1`, `?refresh=1` |
| `GET /v1/quota`, `/v1/tier` | live buckets, tier, project |
| `GET /health`, `/v1/doctor` | self-check, no model quota |

### OpenAI, exactly like the docs

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="agy_…")
r = client.chat.completions.create(
    model="gemini-3.8-flash-low",
    messages=[{"role": "user", "content": "hi"}],
    reasoning_effort="high",          # thinking control, same knob as the UI
)
print(r.choices[0].message.content)
```

No SDK on the box? `app/sdk/openai.mjs` mirrors the surface:

```js
import OpenAI from './sdk/openai.mjs';
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8790/v1', apiKey });
const stream = await client.chat.completions.create({ model, messages, stream: true });
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');
```

`node app/examples/openai-node.mjs [--stream]` runs exactly that.

### Claude

```bash
curl http://127.0.0.1:8790/v1/messages \
  -H "content-type: application/json" -H "Authorization: Bearer agy_…" \
  -d '{"model":"gemini-3.8-flash-low","max_tokens":200,
       "thinking":{"type":"enabled","budget_tokens":12000},
       "messages":[{"role":"user","content":"hi"}]}'
```

Thinking budgets map to levels: `>=24000` high, `>=8000` medium, otherwise low.

## Under the hood (ported hardening)

- **Upstream fallback** — `daily → sandbox → production`, moving on only for
  network errors and 5xx, and never after the first byte reaches the client. On
  2026-11-18 `production` answered 429 for this account while `daily` and
  `sandbox` answered 200.
- **Account pool** — if `~/.gemini/antigravity-direct/accounts.json` lists more
  than one refresh token, requests rotate across them. A 429 puts an account on
  an exponential cooldown, a 403 on a ten-minute one and disables it after three,
  `invalid_grant` disables it immediately. With no file, the machine's own
  keyring account is used.
- **SSE heartbeat** — `: heartbeat` every 15 s (`AGY_HEARTBEAT_MS`) on every
  streaming endpoint, because thinking runs go quiet for tens of seconds.
- **Thought passthrough** — `includeThoughts` is on by default; thoughts go to
  `delta.reasoning` (OpenAI), `thinking_delta` (Claude) and the UI panel.

## Verify

```powershell
node core\cli.mjs --doctor
node core\cli.mjs --selftest     # 12 checks, boots the app on a throwaway port
```

Selftest covers: health, 401 without key on models and chat, models with key,
`x-api-key`, chat, SSE stream, tool call, thinking events, Claude message,
Claude stream, thinking budget, key lifecycle (create → use → revoke → 401),
quota. 14/14 on this host.

## Env

`AGY_APP_PORT` (8790), `AGY_APP_HOST` (127.0.0.1), `AGY_APP_OPEN=0`,
`AGY_TOKEN`, `AGY_CONCURRENCY` (4), `AGY_TIMEOUT_MS`, `AGY_HEARTBEAT_MS` (15000),
`AGY_THINKING_LEVEL`, `AGY_ACCOUNTS_FILE`, `AGY_TOKEN_DIR`.

## Notes

- `token.json` and `accounts-tokens.json` hold live credentials; user-profile
  ACL, never commit.
- The UI's session token is injected into `index.html` at serve time, so `/api/*`
  is same-origin only while `/v1/*` keeps the real key gate.
- `core/server.mjs` still exists as the bare API-only shim; the app is the
  product now.
