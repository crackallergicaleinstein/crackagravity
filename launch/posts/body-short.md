# Short body — paste-ready ("crackagravity solves this")

Claim first, evidence second, limits last. ~230 words.

---

**crackagravity solves this.**

The problem, in one sentence: the good models are locked behind a per-token API
bill or an IDE that eats your quota before it answers you. Claude Opus, Sonnet,
Gemini Pro — you either pay per million tokens forever, or you get quota through
Antigravity and watch a 235 MB binary burn it on its own bullshit.

crackagravity deletes the middleman. Your account's quota, your OAuth token, one
direct call to the same endpoint — exposed as a normal OpenAI + Claude compatible
API on localhost. Cline, aider, your own script, whatever the fuck you use: it
just works, and it costs nothing on top of the plan you already have (free tier, a
couple of bucks, or a promo account — that part is your business, not mine).

Why your quota used to evaporate: 21,830 prompt tokens of client-side scaffolding
per turn — 65k-character system prompt, 14 tool declarations, a per-tool-call
"rater", a fresh 235 MB spawn. Strip the shit and the same answer is **6–38
tokens**, one `fetch`. Same quota, lasts a month instead of an afternoon.

Thinking is a number, not a vibe: 1024/8192/30000 → 153/348/1218 thought tokens,
measured. Local API, Windows app with key management and a live reasoning panel,
CLI with a 14-check selftest. Zero npm deps, no build step, no bundled binaries.

And it does not touch Google's content filter or model refusals — normal 200s.
Subtraction, not magic.

https://github.com/crackallergicaleinstein/crackagravity

---

## Ultra-short (comment / Discord)

> crackagravity solves this: your Antigravity quota behind a normal OpenAI/Claude
> API on localhost, zero marginal cost. The IDE was burning 21,830 tokens of its
> own scaffolding per turn — stripped, it's 6–38. Local API + Windows app + CLI,
> no deps, no build. Server-side filter untouched.
> https://github.com/crackallergicaleinstein/crackagravity

## One-line (X / Telegram)

> Paying per token for models your Antigravity plan already covers? crackagravity
> solves it — your quota as a local OpenAI/Claude API, 6–38 tokens per call instead
> of 21,830.
> github.com/crackallergicaleinstein/crackagravity
