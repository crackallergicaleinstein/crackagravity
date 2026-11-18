# Short body — paste-ready

Use this as the post body on Reddit / forums / Telegram. It is deliberately
~230 words: long enough to carry the numbers, short enough that people actually
read it. Swap the first line for the community-specific one in the other files
if you want.

---

So I got sick of Antigravity eating my quota and went and measured the fucking
thing. One captured request, one three-word answer:

- 65,891-character system prompt ≈ 16.5k tokens
- 14 tool declarations ≈ 5k tokens
- a second "safety rater" request per tool call = 2,704 tokens
- a 235 MB `agy.exe` spawn per turn, ~7 seconds

**21,830 prompt tokens** before it even reads your question. All of that shit is
built client-side — the upstream endpoint does not need any of it. Strip it and
the same answer costs **6–38 tokens**, one `fetch`, no process.

So I built the whole lane around that and wrapped it in what you actually want:
an OpenAI + Claude compatible local API (streaming, tools, thinking budgets),
a Windows app with a key store and a live reasoning panel, and a CLI with a
14-check selftest. Zero npm deps, no build step, no mystery 8 MB binary.

Thinking is a number now, not a vibe — measured: 1024 → 153 thought tokens,
8192 → 348, 30000 → 1218, same prompt.

And before someone asks: **it does not touch Google's content filter or model
refusals.** Those come back as normal 200s. This is subtraction, not magic, and
the README says so in bold instead of overselling you a bypass fantasy.

Windows + Node 20+: https://github.com/crackallergicaleinstein/crackagravity

---

## Ultra-short (comment reply / Discord)

> Measured Antigravity's CLI: 21,830 prompt tokens of client-side scaffolding per
> turn for a three-word answer. Same endpoint without it: 6–38 tokens. Built an
> OpenAI/Claude-compatible local API + Windows app around that, zero deps.
> Doesn't touch the server-side filter — README says so. 
> https://github.com/crackallergicaleinstein/crackagravity

## One-line (X reply / Telegram)

> Antigravity: 21,830 prompt tokens of scaffolding before it reads your question.
> Direct call: 6–38. Same quota, one fetch, no 235 MB spawn.
> github.com/crackallergicaleinstein/crackagravity
