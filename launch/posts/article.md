# dev.to / Hashnode article

**Title:** What a 21,830-token system prompt costs you, and how to delete it

**Tags:** ai, node, opensource, reverseengineering

---

Antigravity can answer without an API key. That is the useful part. The
expensive part is everything the client sends along with your question.

I captured one `POST` to `v1internal:streamGenerateContent` from the stock CLI
and measured the body:

```
request.systemInstruction  65,891 chars   ≈ 16,500 tokens
request.tools              14 declarations ≈ 5,000 tokens
+ agent_monitoring request per tool call    2,704 tokens
+ a 235 MB process spawn per turn          ≈ 7 seconds
```

The upstream endpoint accepts a body with only `contents`. Everything above is
constructed client-side, by the client, for its own agent loop.

## The measurement that started it

Same prompt, two transports:

| path | prompt tokens |
|---|---|
| `agy -p "reply exactly: ok"` | 21,830 |
| bare `streamGenerateContent` | 6–38 |
| + a 12-character system prompt | 15 |
| + a tool declaration | 21 |

The answer is identical because the model is identical. What disappeared was the
harness.

## What this means for a client

If the scaffolding is optional, a thirty-line call is enough to become an API:

```js
const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    project: 'aicode-consumers',
    requestId: `chat/${crypto.randomUUID()}`,
    request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    model: 'gemini-3.8-flash-low',
    userAgent: 'antigravity',
    requestType: 'chat',
    enabledCreditTypes: ['GOOGLE_ONE_AI'],
  }),
});
```

Two things that took longer than the call itself:

**1. Auth.** The refresh token lives in the Windows credential store; the OAuth
client id/secret is a string constant inside the installed binary. Both move
between releases, so both are discovered and cached against a
`size:mtime` fingerprint, and re-derived when the token endpoint starts saying
no. That resilience is most of the code.

**2. Thinking.** `thinkingConfig` takes a **token budget**, not a word. Words are
UI sugar; sending a word a model doesn't carry returns a 400. Measured:
1024 → 153 thought tokens, 8192 → 348, 30000 → 1218.

## What is not solved, and cannot be

Google's server-side content filter and the model's own refusals. They arrive as
perfectly normal responses. No transport-layer trick has ever changed that; any
repo claiming otherwise is either lying or talking about the client-side rater,
which is a different object.

The honest framing: this is subtraction, not magic. You get the quota you already
pay for, without paying the token tax.

Repo (MIT, zero deps): https://github.com/crackallergicaleinstein/crackagravity
