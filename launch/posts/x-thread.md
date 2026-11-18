# X / Twitter thread

**1/**
Antigravity's CLI burns 21,830 prompt tokens before it reads your question.

I captured a request. All of it is client-side scaffolding. Strip it → 6–38 tokens, same endpoint, same models, your own quota.

Built the whole lane: 🧵

**2/**
The bill:
• 65,891-char system prompt ≈ 16.5k tokens
• 14 tool declarations ≈ 5k
• a second "safety rater" request per tool call = 2,704
• 235 MB process per turn ≈ 7 s

For a three-word answer.

**3/**
The trick isn't a bypass. It's subtraction. The prompt, tools and rater are built in the client, so the direct `streamGenerateContent` call doesn't need them.

One fetch. One auth header. Nothing else.

**4/**
Thinking is a number now, not a vibe:

1024 → 153 thought tokens
8192 → 348
30000 → 1218

Same prompt, three real measurements. `thinking_budget` in OpenAI shape, `thinking.budget_tokens` in Claude shape, a bare box in the app.

**5/**
What it does NOT do — and the README says it in bold:

• does not touch Google's content filter
• does not fake client telemetry
• does not ship a TLS-fingerprint binary

The filter comes back as a normal 200. Transport never moved it.

**6/**
Ships as:
• OpenAI + Claude compatible API on localhost
• Windows app: key store, live reasoning panel, stop/regenerate
• CLI with `--doctor`, `--where`, `--selftest` (14/14)
• zero npm deps, no build step

github.com/crackallergicaleinstein/crackagravity
