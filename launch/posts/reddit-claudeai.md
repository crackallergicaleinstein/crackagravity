# r/ClaudeAI

**Title:** Antigravity serves Claude Opus 5.5 / Sonnet 5.5 on subscription quota — here's a local Claude-format endpoint for it

**Body:**

If you have Antigravity installed, it exposes Claude Opus 5.5 and Sonnet 5.5
through the same `cloudcode-pa` backend it uses for Gemini. The stock CLI adds
~21,830 prompt tokens of its own scaffolding per turn (65,891-char system prompt,
14 tool declarations, a per-tool-call "rater" request, 235 MB spawn).

The direct call needs none of that — 6–38 tokens for the same answer — so I put
it behind a real **Claude Messages endpoint**:

```bash
curl http://127.0.0.1:8790/v1/messages \
  -H "content-type: application/json" \
  -H "Authorization: Bearer agy_…" \
  -d '{"model":"claude-sonnet-5-5-high","max_tokens":300,
       "thinking":{"type":"enabled","budget_tokens":8192},
       "messages":[{"role":"user","content":"hi"}]}'
```

Streaming follows the Anthropic event shape (`message_start` →
`content_block_delta` → `message_stop`), thinking budgets map to the backend's
`thinkingBudget`, and tool use round-trips with `input_json_delta`.

The same port also speaks OpenAI shape, so both kinds of client work.

Two honest caveats:

- **Anthropic's own filters**: model refusals come from the model, untouched.
- **Quota** is the Antigravity subscription quota, not an Anthropic plan.

Windows app + CLI, Node 20+, no npm deps:
https://github.com/crackallergicaleinstein/crackagravity
