# r/node (and r/selfhosted variant below)

**Title:** A zero-dependency Node client + local API that turns a subscription CLI into an OpenAI endpoint

**Body:**

Most "turn X into OpenAI API" projects pull in express, axios, dotenv,
jsonwebtoken, protobufjs and a compiled TLS binary. This one is plain Node:
`http`, `fetch`, `crypto`, `fs`, `child_process`. No `npm install`, no build.

What's interesting engineering-wise:

- **Credential discovery, not configuration.** The OAuth refresh token comes out
  of Windows Credential Manager (read via `CredReadW` through a PowerShell
  snippet compiled with `Add-Type`), the client id/secret out of the installed
  binary, verified against the token endpoint before use. No `.env` to fill.
- **Update resilience.** Vendor updates re-sign the client pair, move the binary,
  or rotate the refresh token. Each has a recovery path (fingerprint mismatch →
  revalidate → rescan; new keyring target → rescan; `invalid_grant` → re-read
  store) and each was tested by breaking it on purpose.
- **Upstream fallback** across `daily` / `sandbox` / `production`, only on
  network/5xx and never after the first byte has reached the client, so a
  mid-stream switch can't duplicate output.
- **SSE heartbeat** every 15 s, because thinking models go silent and proxies
  give up.
- **Single-file UI** — vanilla HTML/CSS/JS, no framework, no bundler.

API: OpenAI `chat/completions` (stream, tools, `thinking_budget`), Claude
`/v1/messages`, live `/v1/models` + `/v1/quota`, key store with create/rotate/
revoke, and a `/v1/doctor` that consumes no model quota.

Zero deps means the whole thing is auditable in an afternoon — which for a tool
that handles your Google token is the point.

https://github.com/crackallergicaleinstein/crackagravity
