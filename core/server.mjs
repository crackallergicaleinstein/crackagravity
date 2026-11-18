#!/usr/bin/env node
/**
 * OpenAI-compatible facade over the Antigravity backend, direct.
 *
 * One HTTPS POST to `v1internal:streamGenerateContent` per request, authorized
 * with the account's Google OAuth token. No agy.exe process, no hub, no harness
 * system prompt, no tool roster, no agent_monitoring rater call.
 *
 * Env:
 *   AGY_PORT             listen port (default 8787)
 *   AGY_HOST             bind host (default 127.0.0.1)
 *   AGY_MODEL            default model id
 *   AGY_TOKEN            optional bearer token required from clients
 *   AGY_TIMEOUT_MS       per-request limit (default 300000)
 *   AGY_CONCURRENCY      max in-flight upstream calls (default 4)
 *   AGY_THINKING_LEVEL   optional default thinking level
 *   AGY_TOOLS            set to 0 to advertise no tool support
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { streamGenerate, quota, loadCodeAssist } from './lib/client.mjs';
import { catalog as modelCatalog, DEFAULT_MODEL } from './lib/models.mjs';
import { identity, syncFromKeyring, ensureReady } from './lib/token.mjs';
import { findBinary, loadCache, loadConfig } from './lib/discover.mjs';

const PORT = Number(process.env.AGY_PORT || 8787);
const HOST = process.env.AGY_HOST || '127.0.0.1';
/** Key gate: env wins, then the key written by `cli --key-gen`. */
function resolveToken() {
  if (process.env.AGY_TOKEN) return process.env.AGY_TOKEN;
  try { return loadConfig().api_key || ''; } catch { return ''; }
}
const TOKEN = resolveToken();
const CONCURRENCY = Math.max(1, Number(process.env.AGY_CONCURRENCY || 4));
const TIMEOUT_MS = Math.max(1000, Number(process.env.AGY_TIMEOUT_MS || 300_000));
const DEFAULT_THINKING = process.env.AGY_THINKING_LEVEL || '';
const TOOLS_ENABLED = process.env.AGY_TOOLS !== '0' && process.env.AGY_FORCE_TOOLS !== '0';

const MAX_BODY = 8_000_000;

let active = 0;
const queue = [];

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < CONCURRENCY && queue.length > 0) {
    const { task, resolve, reject } = queue.shift();
    active += 1;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/**
 * Tool-call ids carry the upstream `thoughtSignature`, because Gemini 3+ refuses
 * to replay a functionCall part without one and no OpenAI client round-trips a
 * vendor field. The client echoes the id, we unpack it on the next turn.
 */
const TS_MARK = '_ts_';

function encodeCallId(baseId, signature) {
  if (!signature) return baseId;
  return `${baseId}${TS_MARK}${Buffer.from(signature, 'utf8').toString('base64url')}`;
}

function decodeCallId(id) {
  const idx = typeof id === 'string' ? id.indexOf(TS_MARK) : -1;
  if (idx < 0) return { id, signature: '' };
  const signature = Buffer.from(id.slice(idx + TS_MARK.length), 'base64url').toString('utf8');
  return { id: id.slice(0, idx), signature };
}

/**
 * OpenAI chat messages → Gemini `contents` + system instruction.
 *
 * Handles the coding-agent shape too: assistant turns that carry `tool_calls`
 * become `functionCall` parts, and `tool` turns become `functionResponse` parts
 * so multi-step tool loops keep their history.
 */
export function toContents(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error('messages must be a non-empty array'), { status: 400 });
  }
  const systemParts = [];
  const contents = [];
  const callNames = new Map();

  for (const m of messages) {
    if (!m) continue;

    if (m.role === 'system' || m.role === 'developer') {
      const text = contentText(m.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (m.role === 'tool') {
      const { id } = decodeCallId(m.tool_call_id);
      const name = callNames.get(id) || callNames.get(m.tool_call_id) || m.name || 'tool';
      const raw = contentText(m.content);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: parsed && typeof parsed === 'object' ? parsed : { result: raw } } }],
      });
      continue;
    }

    if (m.role === 'assistant') {
      const parts = [];
      const text = contentText(m.content);
      if (text) parts.push({ text });
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = call?.function;
        if (!fn?.name) continue;
        let args = {};
        try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { args = {}; }
        const { id, signature } = decodeCallId(call.id);
        if (id) callNames.set(id, fn.name);
        if (call.id) callNames.set(call.id, fn.name);
        const part = { functionCall: { name: fn.name, args } };
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      if (parts.length > 0) contents.push({ role: 'model', parts });
      continue;
    }

    const text = contentText(m.content);
    if (text) contents.push({ role: 'user', parts: [{ text }] });
  }

  if (contents.length === 0) {
    throw Object.assign(new Error('messages contained no user, assistant or tool content'), { status: 400 });
  }
  return { contents, system: systemParts.join('\n\n') };
}

function usageOut(u, promptChars) {
  const input = Number(u?.promptTokenCount ?? 0);
  const output = Number(u?.candidatesTokenCount ?? 0);
  const thoughts = Number(u?.thoughtsTokenCount ?? 0);
  const total = Number(u?.totalTokenCount ?? input + output);
  return {
    prompt_tokens: input || Math.ceil(promptChars / 4),
    completion_tokens: output,
    total_tokens: total,
    completion_tokens_details: { reasoning_tokens: thoughts },
    prompt_tokens_details: { cached_tokens: Number(u?.cachedContentTokenCount ?? 0) },
  };
}

function finishFrom(reason, hasToolCalls) {
  if (hasToolCalls) return 'tool_calls';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT') return 'content_filter';
  return 'stop';
}

function promptCharsOf(system, contents) {
  const bodyChars = contents.reduce((n, c) => n + (c.parts || []).reduce((k, p) => k + (p.text?.length || 0), 0), 0);
  return system.length + bodyChars;
}

async function handleCompletion(req, res, { legacyText = false } = {}) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } });
  }

  if (legacyText) {
    const prompt = Array.isArray(body.prompt) ? body.prompt.join('\n') : String(body.prompt ?? '');
    body = { ...body, messages: [{ role: 'user', content: prompt }] };
  }

  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
  const thinking = body.thinking_level ?? body.thinkingLevel ?? DEFAULT_THINKING ?? undefined;

  let contents;
  let system;
  try {
    ({ contents, system } = toContents(body.messages));
  } catch (e) {
    return sendJson(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error' } });
  }

  const input = {
    model,
    contents,
    system,
    thinkingLevel: thinking,
    maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
    tools: TOOLS_ENABLED ? body.tools : undefined,
    toolConfig: TOOLS_ENABLED ? body.tool_choice : undefined,
  };

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), TIMEOUT_MS);
  const onClose = () => controller.abort(new Error('client disconnected'));
  res.on('close', onClose);

  try {
    if (body.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const chunkObject = (delta, finishReason = null) => {
        if (legacyText) {
          res.write(`data: ${JSON.stringify({
            id, object: 'text_completion', created, model,
            choices: [{ index: 0, text: delta.content || '', finish_reason: finishReason }],
          })}\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
      };
      const chunk = chunkObject;
      let sentRole = false;
      let usage = null;
      let finish = 'stop';
      let callIndex = 0;
      const promptChars = promptCharsOf(system, contents);
      const ensureRole = () => {
        if (sentRole) return;
        chunk({ role: 'assistant', content: '' });
        sentRole = true;
      };

      await schedule(async () => {
        for await (const event of streamGenerate(input, { signal: controller.signal })) {
          if (event.kind === 'text') {
            ensureRole();
            chunk({ content: event.text });
          } else if (event.kind === 'thought') {
            ensureRole();
            chunk({ reasoning: event.text });
          } else if (event.kind === 'tool_call') {
            ensureRole();
            chunk({
              tool_calls: [{
                index: callIndex,
                id: encodeCallId(event.id, event.thoughtSignature),
                type: 'function',
                function: { name: event.name, arguments: JSON.stringify(event.args) },
              }],
            });
            callIndex += 1;
          } else if (event.kind === 'usage') {
            usage = event.usage;
            finish = finishFrom(event.finishReason, callIndex > 0);
          }
        }
      });

      chunk({}, finish);
      if (usage) {
        res.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model, choices: [],
          usage: usageOut(usage, promptChars),
        })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let text = '';
    let thoughts = '';
    const toolCalls = [];
    let usage = null;
    let modelVersion = '';
    let responseId = '';
    let reason = '';

    await schedule(async () => {
      for await (const event of streamGenerate(input, { signal: controller.signal })) {
        if (event.kind === 'text') text += event.text;
        else if (event.kind === 'thought') thoughts += event.text;
        else if (event.kind === 'tool_call') toolCalls.push(event);
        else if (event.kind === 'usage') {
          usage = event.usage;
          modelVersion = event.modelVersion;
          responseId = event.responseId;
          reason = event.finishReason;
        }
      }
    });

    if (legacyText) {
      return sendJson(res, 200, {
        id,
        object: 'text_completion',
        created,
        model,
        choices: [{ index: 0, text, logprobs: null, finish_reason: finishFrom(reason, toolCalls.length > 0) }],
        usage: usageOut(usage, promptCharsOf(system, contents)),
      });
    }

    const message = { role: 'assistant', content: text || (toolCalls.length > 0 ? null : '') };
    if (thoughts) message.reasoning_content = thoughts;
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map((c) => ({
        id: encodeCallId(c.id, c.thoughtSignature),
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
    }

    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishFrom(reason, toolCalls.length > 0) }],
      usage: usageOut(usage, promptCharsOf(system, contents)),
      system_fingerprint: modelVersion || undefined,
      upstream_response_id: responseId || undefined,
    });
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
}

function authorized(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const candidates = [bearer, req.headers['x-api-key'], req.headers['api-key']].filter(Boolean);
  return candidates.includes(TOKEN);
}

async function doctor() {
  const report = { ok: true, checks: [] };
  const add = (name, ok, detail) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.ok = false;
  };

  let binary = null;
  try { binary = findBinary(); } catch { binary = null; }
  add('binary', Boolean(binary), binary ? `${binary.path} (${(binary.size / 1e6).toFixed(0)} MB)` : 'agy.exe not found');

  const creds = loadCache();
  add('client_creds', Boolean(creds?.client_id), creds ? `${creds.source || 'cache'} · ${creds.client_id.slice(0, 18)}…` : 'none resolved');

  let who = null;
  try { who = identity(); } catch { who = null; }
  add('keyring', Boolean(who?.keyring_target), who?.keyring_target || 'no credential target');

  try {
    const t = await loadCodeAssist();
    add('auth', true, `tier=${t?.currentTier?.id} project=${t?.cloudaicompanionProject}`);
  } catch (e) {
    add('auth', false, e.message);
  }

  try {
    const q = await quota();
    const buckets = (q.groups || []).flatMap((g) => g.buckets || []);
    add('quota', buckets.length > 0, buckets.map((b) => `${b.bucketId}=${(b.remainingFraction * 100).toFixed(1)}%`).join(' '));
  } catch (e) {
    add('quota', false, e.message);
  }

  try {
    const c = await modelCatalog({ refresh: true });
    const addr = c.models.filter((m) => m.addressable);
    add('catalog', addr.length > 0, `${addr.length} addressable / ${c.models.length} total (${c.source})`);
  } catch (e) {
    add('catalog', false, e.message);
  }
  add('api_key', Boolean(TOKEN), TOKEN ? `gate on (${TOKEN.slice(0, 10)}…)` : 'gate off — no key configured');
  return report;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key, api-key',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/' || path === '/health') {
      let who = {};
      try { who = identity(); } catch { who = {}; }
      let count = 0;
      try {
        const c = await modelCatalog();
        count = c.models.filter((m) => m.addressable).length;
      } catch { /* report what we have */ }
      return sendJson(res, 200, {
        ok: true,
        mode: 'direct',
        backend: 'daily-cloudcode-pa.googleapis.com/v1internal',
        account: who.email || null,
        models: count,
        default_model: DEFAULT_MODEL,
        tools: TOOLS_ENABLED,
        auth_gate: Boolean(TOKEN),
        in_flight: active,
        queued: queue.length,
      });
    }

    if (path === '/v1/doctor' || path === '/doctor') {
      return sendJson(res, 200, await doctor());
    }

    if (!authorized(req)) {
      return sendJson(res, 401, { error: { message: 'unauthorized', type: 'invalid_request_error' } });
    }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      const c = await modelCatalog({ withQuota: url.searchParams.get('quota') === '1', refresh: url.searchParams.get('refresh') === '1' });
      return sendJson(res, 200, {
        object: 'list',
        source: c.source,
        data: c.models.filter((m) => m.addressable).map((m) => ({
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: m.provider,
          permission: [],
          antigravity: {
            display_name: m.displayName,
            context_window: m.contextWindow,
            max_output_tokens: m.maxOutput,
            thinking: m.thinking,
            recommended: m.recommended,
            quota_remaining: m.quotaRemaining,
            reset_time: m.resetTime,
          },
        })),
      });
    }

    const modelMatch = path.match(/^\/(?:v1\/)?models\/(.+)$/);
    if (req.method === 'GET' && modelMatch) {
      const id = decodeURIComponent(modelMatch[1]);
      const c = await modelCatalog();
      const found = c.models.find((m) => m.id === id);
      if (!found) return sendJson(res, 404, { error: { message: `model not found: ${id}`, type: 'invalid_request_error' } });
      return sendJson(res, 200, {
        id: found.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: found.provider,
        antigravity: {
          display_name: found.displayName,
          context_window: found.contextWindow,
          max_output_tokens: found.maxOutput,
          thinking: found.thinking,
          recommended: found.recommended,
          quota_remaining: found.quotaRemaining,
          reset_time: found.resetTime,
        },
      });
    }

    if (req.method === 'GET' && (path === '/v1/quota' || path === '/quota')) {
      try {
        return sendJson(res, 200, await quota());
      } catch (e) {
        return sendJson(res, e.status || 502, { error: { message: e.message, type: 'upstream_error' } });
      }
    }

    if (req.method === 'GET' && path === '/v1/tier') {
      try {
        const t = await loadCodeAssist();
        return sendJson(res, 200, {
          current_tier: t?.currentTier?.id ?? null,
          project: t?.cloudaicompanionProject ?? null,
          paid_tier: t?.paidTier?.id ?? null,
          upgrade: t?.upgradeSubscriptionText ?? null,
        });
      } catch (e) {
        return sendJson(res, e.status || 502, { error: { message: e.message, type: 'upstream_error' } });
      }
    }

    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      return await handleCompletion(req, res);
    }

    if (req.method === 'POST' && (path === '/v1/completions' || path === '/completions')) {
      return await handleCompletion(req, res, { legacyText: true });
    }

    return sendJson(res, 404, { error: { message: `not found: ${path}`, type: 'invalid_request_error' } });
  } catch (e) {
    if (!res.headersSent) {
      return sendJson(res, e.status || 500, { error: { message: e.message || 'internal error', type: 'server_error' } });
    }
    try { res.end(); } catch { /* already gone */ }
  }
});

server.listen(PORT, HOST, () => {
  let who = {};
  try { syncFromKeyring(); who = identity(); } catch (e) { console.error(`auth: ${e.message}`); }
  console.log(`core listening on http://${HOST}:${PORT}/v1`);
  console.log(`account: ${who.email || 'unknown'} | default: ${DEFAULT_MODEL} | tools: ${TOOLS_ENABLED ? 'on' : 'off'} | key gate: ${TOKEN ? 'on' : 'off'} | concurrency: ${CONCURRENCY}`);

  // Warm both caches off the hot path: the OAuth pair and the live model list.
  ensureReady()
    .then((r) => console.log(`creds: ${r.client_source} · ${r.client_id} | keyring: ${r.keyring_target}`))
    .catch((e) => console.error(`creds: ${e.message}`));
  modelCatalog()
    .then((c) => console.log(`models: ${c.models.filter((m) => m.addressable).length} addressable / ${c.models.length} total (${c.source})`))
    .catch((e) => console.error(`models: ${e.message}`));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
