# Discord / Telegram / group chats

Short form, because long posts get scrolled past. Pick the variant that matches
the room; do **not** paste all three.

## Variant A — dev/LLM server (2 lines)

> Built a local OpenAI/Claude-compatible endpoint on Antigravity's own quota.
> Measured: the stock CLI sends 21,830 prompt tokens per turn, this sends 6–38.
> Windows app + CLI, zero deps: https://github.com/crackallergicaleinstein/crackagravity

## Variant B — coding-agent room (feature angle)

> If you point Cline/Roo at Antigravity through the CLI, it spawns a 235 MB
> process and 16.5k tokens of prompt per request. This is the direct call behind
> an OpenAI endpoint (tools + streaming + thinking budget).
> https://github.com/crackallergicaleinstein/crackagravity — no npm, no bundled bins.

## Variant C — homelab/selfhosted

> Local service, 127.0.0.1 only, own API keys with rotate/revoke, no telemetry
> replay, no bundled binary. Turns a subscription CLI into an OpenAI endpoint and
> says plainly which vendor control it does not touch.
> https://github.com/crackallergicaleinstein/crackagravity

## If someone asks "does it bypass the filter?"

> No. Client-side scaffolding is gone (that's the 21.8k tokens), server-side
> content filter and model refusals are untouched — they come back as normal
> 200s. README says so in bold.

## If a mod asks about ToS

> Fair. It uses the account's own quota, one request per turn, normal user agent,
> no fake telemetry and no account rotation. If that's not welcome here, delete
> the message — no hard feelings.
