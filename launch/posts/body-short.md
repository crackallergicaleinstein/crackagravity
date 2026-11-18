# Short body — paste-ready (cost + fresh-account angle)

The hook is money. Then the monthly-account trick, said out loud but without
pretending it's risk-free. ~260 words.

---

Let's do the math that nobody at Google wants you to do.

API access to the good models — Claude Opus, Sonnet, Gemini Pro — runs you real
money. Per million tokens, every single month, forever. Meanwhile the Antigravity
subscription includes those exact same models, and depending on where you live
and what promos are running, that subscription is **free tier, a couple of bucks,
a student deal, or bundled with your carrier**. Plenty of people are paying
literally nothing for it.

And here's the part that makes it funny: **you can make a fresh account every
month and get a fresh quota.** New signup, new promo, all the modern models again
for another thirty days. Is that against their terms? Probably. Will accounts get
flagged? Eventually, yeah. But if you're already rotating trials, you might as
well get the whole quota instead of watching a 235 MB binary eat it.

Because that's what the stock CLI does: 21,830 prompt tokens of its own client-side
scaffolding — 65k-character system prompt, 14 tool declarations, a per-tool-call
rater, a new 235 MB spawn — per turn. Your "$2 account" dies after ten questions.
Strip the bullshit and the same request costs **6–38 tokens**, one `fetch`. That
cheap account suddenly covers a month of real work.

Ships as: local OpenAI + Claude compatible API (streaming, tools, numeric thinking
budget), a Windows app with key management and a live reasoning panel, CLI with a
14-check selftest. Zero npm deps, no build step, no bundled binaries.

And yes, before the choir asks: it does **not** touch Google's server-side content
filter or model refusals. Normal 200s. Subtraction, not magic.

Windows + Node 20+: https://github.com/crackallergicaleinstein/crackagravity

---

## Ultra-short (comment / Discord)

> Do the math: API pricing for Opus/Sonnet/Gemini Pro vs the Antigravity sub that
> already includes them — free tier, a couple of bucks, student deal, carrier
> bundle. Fresh account each month = fresh quota. The only reason that quota used
> to die in ten questions is the 21,830 tokens of client-side scaffolding the CLI
> shoves into every turn. Strip it → 6–38. Local OpenAI/Claude API, zero deps,
> server-side filter untouched.
> https://github.com/crackallergicaleinstein/crackagravity

## One-line (X / Telegram)

> Your $2/month (or free) Antigravity account includes the same models people pay
> per-token for. Fresh account monthly = fresh quota. The IDE just burns it on
> 21,830 tokens of scaffolding per question — this doesn't.
> github.com/crackallergicaleinstein/crackagravity
