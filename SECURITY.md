# Security

## What is sensitive in this project

| item | where it lives | in this repo? |
|---|---|---|
| Google OAuth refresh token | Windows Credential Manager (`gemini:antigravity`) + `~/.gemini/antigravity-direct/token.json` | **no** |
| Google access tokens | same, short-lived | **no** |
| Local API keys (`agy_…`) | `~/.gemini/antigravity-direct/apikeys.json` | **no** |
| Account pool refresh tokens | `~/.gemini/antigravity-direct/accounts.json` | **no** |
| Local CA + leaf keys | `mitm/*.key` | **no** (gitignored) |
| Captured traffic | `mitm/dumps/` | **no** (gitignored — contains live bearer tokens) |

`.gitignore` covers every path above. If you fork this and capture your own
traffic, keep `mitm/dumps/` out of the repository.

## If a token leaks

1. Revoke it: <https://myaccount.google.com/permissions> — remove the Antigravity
   grant, then sign in again from the client you use.
2. Delete `~/.gemini/antigravity-direct/token.json` and `apikeys.json`.
3. Rotate every local API key from the app's **API** tab.

A refresh token grants quota usage on your account only; it cannot read your
mail, files or Drive (the granted scopes are `aicode`, `cclog`,
`cloud-platform`, `openid`).

## What this project does not do

- no forged client telemetry, no analytics replay
- no traffic to anything except the same `cloudcode-pa` endpoint the official
  client uses
- no attempts against Google infrastructure, no filter circumvention, no
  credential stuffing
- no listening on a public interface by default (`127.0.0.1`, key-gated)

## Reporting

Open an issue without secrets in it. If the report itself needs a token to
reproduce, redact it first — the maintainers do not need a working credential to
read a bug.
