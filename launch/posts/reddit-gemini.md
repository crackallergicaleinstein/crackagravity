# r/GeminiAI

**Title:** Measured what Antigravity actually sends per request: 21,830 prompt tokens of client-side scaffolding

**Body:**

If you use Antigravity and your quota vanishes faster than the work justifies,
this is why. I captured a `streamGenerateContent` request from the CLI:

| what | size |
|---|---|
| `request.systemInstruction` | 65,891 chars (~16.5k tokens) |
| `request.tools` | 14 declarations (~5k tokens) |
| `agent_monitoring` rater request per tool call | 2,704 tokens |
| `agy.exe` spawn per turn | 235 MB, ~7 s |

None of it is server-mandated. I re-ran the same prompt as a bare
`v1internal:streamGenerateContent` body with only `contents`: **6–38 prompt
tokens**, and a normal answer.

So I built a small local service around that: your Google OAuth token, direct
call, OpenAI + Claude compatible API, plus a Windows app that shows the reasoning
stream with a numeric thinking budget (1024/8192/30000 → 153/348/1218 thought
tokens, measured).

Being precise about scope, because this matters on a Gemini sub: the **server-side
content filter and model refusals are untouched**. They arrive as ordinary
responses. This is not a filter bypass and the repo doesn't claim to be one.

Also: catalog is asked live per account (`fetchAvailableModels`), so tier changes
(free vs AI Pro) show up without code changes. 36 entries / 31 addressable on a
free-tier account, with per-model quota from `retrieveUserQuota`.

https://github.com/crackallergicaleinstein/crackagravity
