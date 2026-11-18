# Launch kit — crackagravity

Repo: https://github.com/crackallergicaleinstein/crackagravity

This folder is the whole distribution plan: where to post, what to say in each
place, and what not to do. Posting is manual — nobody should be running a bot
across forums, least of all a project whose whole pitch is "less machinery".

## The one-line pitch

**Antigravity burns 21,830 prompt tokens before it reads your question. This
sends 6–38, straight to the same endpoint, on your own quota.**

## The three sentences that survive any moderation queue

> Antigravity's CLI sends a 65,891-character system prompt, 14 tool declarations
> and a per-tool-call safety rater with every request. All of that is built
> client-side, so a direct `streamGenerateContent` call costs ~7 tokens of
> overhead instead of ~21,830. This repo is that direct call, with an
> OpenAI/Claude-compatible API and a Windows app, and it is honest about what it
> does not touch (Google's content filter).

## Rules for this rollout (learned the hard way by other repos)

1. **Never post the same text in more than two places.** Rewrite per community;
   the variants are already written below.
2. **Answer comments for the first 4 hours.** A repo posted once and abandoned
   gets buried; a repo with 20 real replies rides.
3. **Lead with the measurement, not the bypass.** "21,830 → 6 tokens" is
   verifiable and interesting; "bypass" without the number reads like malware.
4. **Say what it does not do** in the same post. Communities forgive a tool with
   limits; they hunt a tool that oversells.
5. **No DMs to strangers, no cross-posting the same link into 30 Discords.** That
   is how the GitHub account gets flagged, not the repo starred.
6. **One account per platform, your real one.** An alt with no history posting a
   link is deleted in minutes.

## Order of attack

| day | place | variant |
|---|---|---|
| 1 | r/LocalLLaMA | `posts/reddit-localllama.md` |
| 1 | Hacker News (Show HN) | `posts/show-hn.md` |
| 1 | X / Twitter thread | `posts/x-thread.md` |
| 2 | r/GeminiAI, r/ClaudeAI | `posts/reddit-gemini.md`, `posts/reddit-claudeai.md` |
| 2 | Discord servers you are already in | `posts/discord.md` |
| 3 | Chinese: V2EX / 即刻 / QQ groups | `posts/chinese.md` |
| 3 | Uzbek/Russian Telegram channels | `posts/telegram-uz-ru.md` |
| 4 | dev.to + Hashnode write-up | `posts/article.md` |
| 4 | r/node, r/selfhosted | `posts/reddit-node.md` |

Do not do all of it on day one. Two posts a day, answered well, beats thirty
drive-by links.

## Assets

- `social-card.png` — 1200×630 card for link previews (generated from `card.html`)
- `docs/images/api.png`, `docs/images/chat.png` — real app screenshots
- README — the long form, for whoever clicks through

## The comment answers you will need

**"This is against ToS / you'll get banned."**
> Probably. It uses your own account's quota with a normal user agent and sends
> fewer requests than the official client. No fake telemetry, no account
> rotation against the same quota pool, no filter circumvention. If that is too
> close to the line for you, don't run it — but at least the README says exactly
> what it does instead of pretending to be a "research tool".

**"Does it bypass the content filter?"**
> No. Client-side scaffolding is gone; the server-side filter and model refusals
> are untouched and arrive as ordinary 200 responses. That boundary is written
> in the README in bold so nobody buys it for the wrong reason.

**"Windows only?"**
> The app and credential discovery are Windows (wincred + PowerShell). The core
> client is plain Node; on Linux/macOS you feed it `AGY_REFRESH_TOKEN` and it
> runs.

**"Why not just use the official API?"**
> Because this costs nothing beyond the subscription you already pay for, and
> the official API is a different quota. If you have API credit and no IDE
> install, use the API — this is for the other case.

**"Is this a repack of <other repo>?"**
> It solves the same problem by subtraction rather than impersonation: no forged
> client telemetry, no TLS-fingerprint binary, no signature cache. Read
> `docs/handoff.md` for the measurements.

## Tracking

`checklist.csv` — one row per channel, with a status column. Update it as you
post; the file is the source of truth for "where did I already put this".
