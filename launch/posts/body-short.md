# Short body — paste-ready

The pitch is **money**, not tokens. Tokens are the supporting evidence: they are
why the free quota died fast. Lead with cost, back it with the measurement, and
close on the honest limits. ~240 words.

---

You know what's actually ridiculous? Paying per token for Claude Opus, Sonnet or
Gemini Pro, when the Antigravity subscription sitting on your machine already
includes quota for those exact models. Twenty bucks a month, or free tier, or
Ultra — and then you open an API bill on top of it because the IDE quota is
locked behind a 235 MB binary that eats it for you.

That's the whole reason this exists. Same models, same endpoint, your own
already-paid quota, exposed as a plain OpenAI + Claude compatible API on
localhost. No API key to buy, no per-million-token invoice, no "big plan"
upgrade to get a usable rate limit. If you already pay for the subscription, the
marginal cost of a request is **zero**.

Why it wasn't usable before: the stock CLI shoves 21,830 prompt tokens of its own
client-side scaffolding — 65k-character system prompt, 14 tool declarations, a
per-tool-call rater, a fresh 235 MB spawn — into every single turn. That's why
your free quota evaporated asking one question. Strip the bullshit and the same
answer costs **6–38 tokens**, one `fetch`. Same quota, lasts a hell of a lot
longer.

Ships as a local API (streaming, tools, thinking budgets as numbers), a Windows
app with key management and a live reasoning panel, and a CLI with a 14-check
selftest. Zero npm deps, no build step.

Before anyone asks: it does **not** touch Google's server-side content filter or
model refusals — those come back as normal 200s. This is subtraction, not magic.

Windows + Node 20+: https://github.com/crackallergicaleinstein/crackagravity

---

## Ultra-short (comment reply / Discord)

> You're paying per token for Claude/Gemini while the Antigravity sub you already
> have includes the same models — the IDE just burns that quota on 21,830 tokens
> of its own scaffolding per turn. Exposed it as a local OpenAI/Claude API: same
> models, zero marginal cost, 6–38 tokens per call. Server-side filter untouched.
> https://github.com/crackallergicaleinstein/crackagravity

## One-line (X reply / Telegram)

> Stop paying per token for models your Antigravity subscription already covers.
> Local OpenAI/Claude API on your own quota — the stock client was just burning it
> on 21,830 tokens of scaffolding.
> github.com/crackallergicaleinstein/crackagravity
