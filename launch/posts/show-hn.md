# Show HN

**Title:** Show HN: Crackagravity – Antigravity quota as an OpenAI/Claude endpoint

**Body:**

Antigravity's CLI can answer without an API key, on your subscription quota, but
every call carries the client's own agent harness. I captured a request: 65,891
characters of `systemInstruction`, 14 tool declarations, and a second
`agent_monitoring` request per tool call, plus a 235 MB process spawn. Measured
cost for a three-word reply: 21,830 prompt tokens.

The harness is built in the client, so the direct call doesn't need it. This repo
is that direct call: OAuth token from the Windows credential store, client
credentials recovered from the installed binary and verified against the token
endpoint, one HTTPS POST to the same endpoint the official client uses.

Same reply: 6–38 prompt tokens. Thinking is exposed as a token budget
(`thinkingBudget`), measured at 1024/8192/30000 → 153/348/1218 thought tokens.

It ships as a local API (OpenAI chat/completions + Claude messages, tools,
streaming, SSE heartbeat), a small Windows app with a real key store and a chat
view, and a CLI with a 14-check selftest.

Explicit about limits: Google's server-side content filter and model refusals
are untouched — they arrive as ordinary 200 responses. No forged client
telemetry, no TLS-fingerprint binary, no filter claims. The README says which
half is removed and which half cannot be.

Node 20+, Windows for the app; the core client runs anywhere with a refresh
token.

https://github.com/crackallergicaleinstein/crackagravity

I expect the interesting criticism to be "isn't this just quota arbitrage" —
honestly yes, it is the quota you already paid for, minus 21.8k tokens of
scaffolding per turn. Happy to answer questions about the measurements or the
update-resilience side (credential re-discovery when the vendor re-signs the
binary).
