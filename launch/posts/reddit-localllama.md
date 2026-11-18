# r/LocalLLaMA

**Title:** Antigravity's CLI spends 21,830 prompt tokens before it reads your question — I measured it and stripped it out

**Body:**

I run Antigravity (Google's agentic IDE) and got annoyed at how much of my quota
disappeared. So I MITM'd the client and measured a single three-word reply:

- `request.systemInstruction` — 65,891 chars, ~16.5k tokens
- `request.tools` — 14 declarations, ~5k tokens
- a second request per tool call (`agent_monitoring`, the "safety rater") — 2,704 tokens
- and one 235 MB `agy.exe` process per turn, ~7 s of spawn

All of it is built **client-side**. The upstream endpoint
`v1internal:streamGenerateContent` does not require any of it. Strip it and the
same reply costs **6–38 prompt tokens**, one `fetch`, no process.

So I built the whole lane around that: OAuth refresh token lifted from Windows
Credential Manager, client id/secret discovered from the installed binary (and
re-verified against the token endpoint), direct HTTPS call. Then wrapped it in an
OpenAI + Claude compatible API plus a small Windows app, because pointing Cline
at it is more useful than a CLI.

What it does NOT do, and the README says this in bold: it does not touch the
server-side content filter or model refusals. Those come back as normal 200s.
Transport tricks never moved them; pretending otherwise would be a lie.

Other details that matter here:

- **Thinking is a token budget** (`thinkingBudget`), not a vibe. Measured:
  1024 → 153 thought tokens, 8192 → 348, 30000 → 1218, same prompt.
- **Account pool + upstream fallback**: `daily → sandbox → production` on 5xx
  only, never after the first byte; 429/403 cooldown per account.
- **No forged telemetry.** Other proxies replay `unleash` register/features and
  `recordTrajectoryAnalytics` to look like the IDE. This one doesn't; that's why
  the request count per turn is 1.
- Zero npm deps, no bundled binaries, no build step.

Numbers are in the repo, including the selftest (14/14) and a `--probe` run
across every model the account can see (22/24 answered; the two failures are
404-by-design and a 503 no-capacity).

Repo: https://github.com/crackallergicaleinstein/crackagravity

Curious what people think about the "subtract the harness instead of imitating
it" approach vs the proxies that fake client telemetry. Both are in the wild;
only one of them sends extra authenticated requests.
