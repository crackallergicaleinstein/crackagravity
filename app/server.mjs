#!/usr/bin/env node
/**
 * agy-app — one Windows app: UI + OpenAI-compatible API over the Antigravity
 * backend, with per-request thinking control.
 *
 * What it serves
 *   /                the app UI (static, from ./ui)
 *   /api/*           UI endpoints (same-origin token injected into index.html)
 *   /v1/*            OpenAI-compatible API for any client
 *
 * Env:
 *   AGY_APP_PORT      default 8790
 *   AGY_APP_HOST      default 127.0.0.1
 *   AGY_TOKEN         API key (falls back to config.json api_key)
 *   AGY_CONCURRENCY   default 4
 *   AGY_APP_OPEN      set 0 to skip opening a browser window
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { streamGenerate, generate, quota, loadCodeAssist, availableModels, toFunctionDeclarations, resolveBudget } from '../agy-direct/lib/client.mjs';
import { catalog as modelCatalog, DEFAULT_MODEL, clearModelCache } from '../agy-direct/lib/models.mjs';
import { identity, ensureReady, syncFromKeyring } from '../agy-direct/lib/token.mjs';
import { accounts } from '../agy-direct/lib/pool.mjs';
import * as keys from '../agy-direct/lib/keys.mjs';
import { loadConfig, saveConfig, loadCache, findBinary, paths } from '../agy-direct/lib/discover.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, 'ui');
const PORT = Number(process.env.AGY_APP_PORT || 8790);
const HOST = process.env.AGY_APP_HOST || '127.0.0.1';
const CONCURRENCY = Math.max(1, Number(process.env.AGY_CONCURRENCY || 4));
const TIMEOUT_MS = Math.max(1000, Number(process.env.AGY_TIMEOUT_MS || 300_000));
const MAX_BODY = 8_000_000;

/**
 * Two credentials, two jobs:
 *   - the keys in apikeys.json (created in the UI) gate this app's /v1 surface
 *   - the Google OAuth pair in the credential store reaches the backend
 * `AGY_TOKEN` and the older `config.api_key` stay valid as legacy sources.
 */
function legacyKey() {
  if (process.env.AGY_TOKEN) return process.env.AGY_TOKEN;
  try { return loadConfig().api_key || ''; } catch { return ''; }
}
const API_KEY = legacyKey();

function presentedKeys(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return [bearer, req.headers['x-api-key'], req.headers['api-key']].filter(Boolean);
}

/** Returns the matching key record, or null. */
function authenticate(req) {
  for (const candidate of presentedKeys(req)) {
    const hit = keys.verify(candidate, [API_KEY]);
    if (hit) return hit;
  }
  return null;
}
const SESSION = crypto.randomBytes(24).toString('hex');

/* ─────────────────────────── concurrency gate ─────────────────────────── */

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

/* ─────────────────────────── helpers ─────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

/**
 * SSE keep-alive. Thinking models can sit silent for tens of seconds, which is
 * exactly when a CDN or a proxy decides the connection is dead.
 */
function heartbeat(res, intervalMs = Number(process.env.AGY_HEARTBEAT_MS || 15_000)) {
  const timer = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(timer); }
  }, intervalMs);
  timer.unref?.();
  res.on('close', () => clearInterval(timer));
  return () => clearInterval(timer);
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
    return content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
}

const TS_MARK = '_ts_';
function encodeCallId(baseId, signature) {
  if (!signature) return baseId;
  return `${baseId}${TS_MARK}${Buffer.from(signature, 'utf8').toString('base64url')}`;
}
function decodeCallId(id) {
  const idx = typeof id === 'string' ? id.indexOf(TS_MARK) : -1;
  if (idx < 0) return { id, signature: '' };
  return { id: id.slice(0, idx), signature: Buffer.from(id.slice(idx + TS_MARK.length), 'base64url').toString('utf8') };
}

/** OpenAI messages → Gemini contents (+ system text and tool call names). */
function toContents(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error('messages must be a non-empty array'), { status: 400 });
  }
  const system = [];
  const contents = [];
  const callNames = new Map();

  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = contentText(m.content);
      if (t) system.push(t);
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
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    const text = contentText(m.content);
    if (text) contents.push({ role: 'user', parts: [{ text }] });
  }

  if (contents.length === 0) throw Object.assign(new Error('messages contained no user, assistant or tool content'), { status: 400 });
  return { contents, system: system.join('\n\n') };
}

/**
 * Thinking control.
 *
 * The wire knob is a **token budget** (`thinkingConfig.thinkingBudget`), not a
 * word. Words are convenience presets that map onto budgets; numbers go through
 * untouched. The backend accepted 1024/8192/30000 and produced
 * 173/208/2886 thought tokens respectively, while sending a word a model does
 * not carry is a hard 400 — so budgets are what we send.
 */
export const THINKING_PRESETS = {
  off: 0,
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 12288,
  xhigh: 32768,
};

function levelsFor(modelId = '') {
  // Chips are advisory; the budget is what actually ships.
  if (/^gemini-4-argon/.test(modelId)) return ['minimal', 'medium', 'high'];
  if (/^gemini-4-hydrogen/.test(modelId)) return ['low', 'medium', 'high', 'xhigh'];
  if (/^claude-opus-5-5-high/.test(modelId)) return ['high'];
  if (/^claude-opus-5-5-medium|^claude-sonnet-5-5-medium/.test(modelId)) return ['medium'];
  if (/^claude-opus-5-5-low|^claude-sonnet-5-5-low/.test(modelId)) return ['low'];
  if (/^claude/.test(modelId)) return ['low', 'medium', 'high'];
  if (/^gpt-oss/.test(modelId)) return ['low', 'medium', 'high'];
  if (/flash-lite|2\.5-flash/.test(modelId)) return ['low', 'medium'];
  return ['low', 'medium', 'high'];
}

/** Human label for a budget, matching the presets. */
function budgetLabel(budget) {
  const n = Number(budget) || 0;
  if (n <= 0) return 'off';
  let label = 'minimal';
  for (const [name, value] of Object.entries(THINKING_PRESETS)) {
    if (name !== 'off' && n >= value) label = name;
  }
  return label;
}

/**
 * Accepts a budget number, a preset word, or a numeric level (1/2/3/100) and
 * returns the resolved budget plus what it means.
 */
function normalizeThinking(modelId, level, budget) {
  const numeric = Number(budget);
  const hasBudget = Number.isFinite(numeric) && numeric >= 0 && budget !== undefined && budget !== null && budget !== '';

  let resolved = hasBudget ? Math.max(0, Math.min(32768, Math.trunc(numeric))) : 0;
  if (!hasBudget && level !== undefined && level !== null && level !== '') {
    if (typeof level === 'number') {
      resolved = resolveBudget(0, level);
    } else {
      const word = String(level).toLowerCase();
      resolved = THINKING_PRESETS[word] ?? resolveBudget(0, word);
    }
  }

  return {
    budget: resolved,
    label: budgetLabel(resolved),
    requested: hasBudget ? resolved : (level ?? ''),
    note: resolved ? `thinkingBudget=${resolved}` : 'model default',
  };
}

function usageOut(u, promptChars) {
  const input = Number(u?.promptTokenCount ?? 0);
  const output = Number(u?.candidatesTokenCount ?? 0);
  const thoughts = Number(u?.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: input || Math.ceil(promptChars / 4),
    completion_tokens: output,
    total_tokens: Number(u?.totalTokenCount ?? input + output),
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

/* ─────────────────────────── OpenAI API ─────────────────────────── */

async function openaiChat(req, res, { legacyText = false } = {}) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } }); }

  if (legacyText) {
    const prompt = Array.isArray(body.prompt) ? body.prompt.join('\n') : String(body.prompt ?? '');
    body = { ...body, messages: [{ role: 'user', content: prompt }] };
  }

  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
  const thinking = body.thinking_level ?? body.thinkingLevel ?? body.reasoning_effort ?? '';
  const thinkingBudget = body.thinking_budget ?? body.thinkingBudget ?? body.thinking?.budget;

  let contents;
  let system;
  try { ({ contents, system } = toContents(body.messages)); } catch (e) {
    return sendJson(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error' } });
  }

  const norm = normalizeThinking(model, thinking, thinkingBudget);
  const input = {
    model,
    contents,
    system,
    thinkingBudget: norm.budget || undefined,
    maxOutputTokens: (() => {
      const m = Number(body.max_tokens ?? body.max_completion_tokens);
      return Number.isFinite(m) && m > 0 ? m + (norm.budget || 0) : undefined;
    })(),
    tools: body.tools,
    toolConfig: body.tool_choice,
  };

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), TIMEOUT_MS);
  res.on('close', () => controller.abort(new Error('client disconnected')));

  try {
    if (body.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const stopBeat = heartbeat(res);
      let sentRole = false;
      let usage = null;
      let finish = 'stop';
      let callIndex = 0;
      const promptChars = system.length + contents.reduce((n, c) => n + (c.parts || []).reduce((k, p) => k + (p.text?.length || 0), 0), 0);

      const chunk = (delta, finishReason = null) => {
        if (legacyText) {
          res.write(`data: ${JSON.stringify({ id, object: 'text_completion', created, model, choices: [{ index: 0, text: delta.content || '', finish_reason: finishReason }] })}\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      };
      const ensureRole = () => {
        if (sentRole) return;
        chunk({ role: 'assistant', content: '' });
        sentRole = true;
      };

      await schedule(async () => {
        for await (const event of streamGenerate(input, { signal: controller.signal })) {
          if (event.kind === 'text') { ensureRole(); chunk({ content: event.text }); }
          else if (event.kind === 'thought') { ensureRole(); chunk({ reasoning: event.text }); }
          else if (event.kind === 'tool_call') {
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
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOut(usage, promptChars) })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      stopBeat();
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
          usage = event.usage; modelVersion = event.modelVersion; responseId = event.responseId; reason = event.finishReason;
        }
      }
    });

    const promptChars = system.length + contents.reduce((n, c) => n + (c.parts || []).reduce((k, p) => k + (p.text?.length || 0), 0), 0);
    if (legacyText) {
      return sendJson(res, 200, {
        id, object: 'text_completion', created, model,
        choices: [{ index: 0, text, logprobs: null, finish_reason: finishFrom(reason, toolCalls.length > 0) }],
        usage: usageOut(usage, promptChars),
      });
    }

    const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
    if (thoughts) message.reasoning_content = thoughts;
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((c) => ({
        id: encodeCallId(c.id, c.thoughtSignature),
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
    }

    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: finishFrom(reason, toolCalls.length > 0) }],
      usage: usageOut(usage, promptChars),
      system_fingerprint: modelVersion || undefined,
      upstream_response_id: responseId || undefined,
      thinking: norm,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── Claude Messages API ─────────────────────────── */

/** Anthropic `tools` ({name, description, input_schema}) → OpenAI shape. */
function claudeToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => t && t.name)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}

/** Anthropic message list → Gemini contents, including tool_use / tool_result. */
function claudeToContents(messages) {
  const contents = [];
  const systemParts = [];
  const names = new Map();
  let pendingToolResults = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    contents.push({ role: 'user', parts: pendingToolResults.map((p) => ({ functionResponse: p })) });
    pendingToolResults = [];
  };

  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'system') {
      const text = contentText(m.content);
      if (text) systemParts.push(text);
      continue;
    }

    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];

    if (m.role === 'assistant') {
      flushToolResults();
      const parts = [];
      for (const block of blocks) {
        if (block?.type === 'text' && block.text) parts.push({ text: block.text });
        if (block?.type === 'thinking' && block.thinking) parts.push({ text: block.thinking, thought: true });
        if (block?.type === 'tool_use') {
          if (block.id) names.set(block.id, block.name);
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        }
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }

    // user
    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'tool_result') {
        pendingToolResults.push({
          name: names.get(block.tool_use_id) || block.name || 'tool',
          response: typeof block.content === 'string'
            ? { result: block.content }
            : { result: contentText(block.content) },
        });
        continue;
      }
      if (block?.type === 'text' && block.text) parts.push({ text: block.text });
    }
    if (parts.length) contents.push({ role: 'user', parts });
  }
  flushToolResults();

  if (contents.length === 0) throw Object.assign(new Error('messages produced no content'), { status: 400 });
  return { contents, system: systemParts.join('\n\n') };
}

/** Anthropic thinking budget → the backend's level vocabulary. */
function levelFromBudget(budget) {
  const n = Number(budget) || 0;
  if (n <= 0) return '';
  if (n >= 24_000) return 'HIGH';
  if (n >= 8_000) return 'MEDIUM';
  return 'LOW';
}

function claudeStopReason(reason, hasTools) {
  if (hasTools) return 'tool_use';
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  return 'end_turn';
}

async function claudeMessages(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }); }

  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
  const thinkingOn = body.thinking && body.thinking.type !== 'disabled';
  const norm = normalizeThinking(model, '', thinkingOn ? body.thinking.budget_tokens : 0);

  let contents;
  let system;
  try {
    ({ contents, system } = claudeToContents(body.messages));
    const sys = body.system;
    if (sys) {
      const sysText = Array.isArray(sys) ? sys.map((s) => s?.text || '').join('\n\n') : String(sys);
      system = [system, sysText].filter(Boolean).join('\n\n');
    }
  } catch (e) {
    return sendJson(res, e.status || 400, { type: 'error', error: { type: 'invalid_request_error', message: e.message } });
  }

  const input = {
    model,
    contents,
    system,
    thinkingBudget: norm.budget || undefined,
    maxOutputTokens: Number(body.max_tokens) > 0 ? Number(body.max_tokens) + (norm.budget || 0) : undefined,
    tools: claudeToolsToOpenAI(body.tools),
    toolConfig: body.tool_choice === 'any' ? 'required' : body.tool_choice === 'none' ? 'none' : 'auto',
  };

  const id = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), TIMEOUT_MS);
  res.on('close', () => controller.abort(new Error('client disconnected')));

  try {
    if (body.stream === true) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const stopBeat = heartbeat(res);
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      send('message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let blockIndex = -1;
      let blockKind = '';
      let stopReason = 'end_turn';
      let usage = null;

      const openBlock = (kind) => {
        blockIndex += 1;
        blockKind = kind;
        if (kind === 'thinking') {
          send('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } });
        } else {
          send('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        }
      };
      const closeBlock = () => {
        if (blockIndex >= 0) send('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      };

      await schedule(async () => {
        for await (const event of streamGenerate(input, { signal: controller.signal })) {
          if (event.kind === 'thought') {
            if (blockKind !== 'thinking') { closeBlock(); openBlock('thinking'); }
            send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: event.text } });
          } else if (event.kind === 'text') {
            if (blockKind !== 'text') { closeBlock(); openBlock('text'); }
            send('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: event.text } });
          } else if (event.kind === 'tool_call') {
            closeBlock();
            blockIndex += 1;
            blockKind = 'tool';
            send('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
            });
            send('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.args) },
            });
            stopReason = 'tool_use';
          } else if (event.kind === 'usage') {
            usage = event.usage;
            if (event.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
          }
        }
      });

      closeBlock();
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: Number(usage?.candidatesTokenCount ?? 0) },
      });
      send('message_stop', { type: 'message_stop' });
      stopBeat();
      res.end();
      return;
    }

    let text = '';
    let thoughts = '';
    const toolCalls = [];
    let usage = null;
    let modelVersion = '';
    let reason = '';

    await schedule(async () => {
      for await (const event of streamGenerate(input, { signal: controller.signal })) {
        if (event.kind === 'text') text += event.text;
        else if (event.kind === 'thought') thoughts += event.text;
        else if (event.kind === 'tool_call') toolCalls.push(event);
        else if (event.kind === 'usage') {
          usage = event.usage; modelVersion = event.modelVersion; reason = event.finishReason;
        }
      }
    });

    const content = [];
    if (thoughts) content.push({ type: 'thinking', thinking: thoughts });
    if (text) content.push({ type: 'text', text });
    for (const call of toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
    if (content.length === 0) content.push({ type: 'text', text: '' });

    return sendJson(res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model: modelVersion || model,
      content,
      stop_reason: claudeStopReason(reason, toolCalls.length > 0),
      stop_sequence: null,
      usage: {
        input_tokens: Number(usage?.promptTokenCount ?? 0),
        output_tokens: Number(usage?.candidatesTokenCount ?? 0),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── app API ─────────────────────────── */

async function appChat(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
  const norm = normalizeThinking(model, body.thinking, body.thinking_budget ?? body.thinkingBudget);
  const history = Array.isArray(body.messages) ? body.messages : [];
  let contents;
  let system;
  try { ({ contents, system } = toContents(history)); } catch (e) { return sendJson(res, 400, { error: e.message }); }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), TIMEOUT_MS);
  res.on('close', () => controller.abort(new Error('client disconnected')));
  const started = Date.now();
  let firstToken = 0;
  let usage = null;
  let modelVersion = '';

  // One line per turn: enough to see what was actually sent when a reply looks wrong.
  try {
    const last = [...history].reverse().find((m) => m.role === 'user');
    const preview = String(last?.content || '').replace(/\s+/g, ' ').slice(0, 120);
    const logDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'agy-app');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'requests.log'),
      `${new Date().toISOString()} chat model=${model} budget=${norm.budget} msgs=${history.length} chars=${preview.length} :: ${preview}\n`);
  } catch { /* logging is best-effort */ }

  emit('meta', { model, thinking: norm, startedAt: started });
  const stopBeat = heartbeat(res);

  try {
    await schedule(async () => {
      for await (const event of streamGenerate({
        model, contents, system,
        thinkingBudget: norm.budget || undefined,
        maxOutputTokens: Number(body.max_tokens) > 0 ? Number(body.max_tokens) + (norm.budget || 0) : undefined,
      }, { signal: controller.signal })) {
        if (event.kind === 'text') {
          if (!firstToken) firstToken = Date.now();
          emit('text', { text: event.text });
        } else if (event.kind === 'thought') {
          if (!firstToken) firstToken = Date.now();
          emit('thought', { text: event.text });
        } else if (event.kind === 'tool_call') {
          emit('tool', { name: event.name, args: event.args, id: event.id });
        } else if (event.kind === 'usage') {
          usage = event.usage;
          modelVersion = event.modelVersion;
        }
      }
    });
    emit('done', {
      usage: usageOut(usage, system.length + contents.reduce((n, c) => n + (c.parts || []).reduce((k, p) => k + (p.text?.length || 0), 0), 0)),
      modelVersion,
      elapsedMs: Date.now() - started,
      ttftMs: firstToken ? firstToken - started : null,
    });
  } catch (e) {
    emit('error', { message: e.message || String(e) });
  } finally {
    stopBeat();
    clearTimeout(timer);
    res.end();
  }
}

async function appState() {
  let who = {};
  try { who = identity(); } catch { who = {}; }
  const cfg = loadConfig();
  let tier = null;
  try { tier = await loadCodeAssist(); } catch { tier = null; }
  const binary = findBinary();
  const cache = loadCache();
  return {
    app: { port: PORT, host: HOST, session: Boolean(SESSION) },
    account: {
      email: who.email || '',
      authMethod: who.auth_method || '',
      keyring: who.keyring_target || '',
      tokenSource: who.token_source || '',
    },
    tier: {
      current: tier?.currentTier?.id || null,
      paid: tier?.paidTier?.id || null,
      project: tier?.cloudaicompanionProject || null,
      upgrade: tier?.upgradeSubscriptionText || null,
    },
    backend: {
      binary: binary ? { path: binary.path, via: binary.via, mb: Math.round(binary.size / 1e6) } : null,
      clientSource: cache?.source || '',
      endpoint: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
    },
    pool: accounts.snapshot(),
    settings: {
      model: cfg.default_model || DEFAULT_MODEL,
      thinking: cfg.thinking || '',
      thinking_budget: Number(cfg.thinking_budget) || 0,
      apiKey: Boolean(API_KEY) || keys.list().length > 0,
      keysCount: keys.list().length,
      concurrency: CONCURRENCY,
    },
  };
}

/* ─────────────────────────── static ─────────────────────────── */

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(UI_DIR, rel);
  if (!full.startsWith(UI_DIR)) return sendText(res, 403, 'forbidden');

  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return sendText(res, 404, 'not found');
  }
  if (rel === '/index.html') {
    const html = buf.toString('utf8').replace('__SESSION__', SESSION);
    return sendText(res, 200, html, MIME['.html']);
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

/* ─────────────────────────── wiring ─────────────────────────── */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key, api-key, x-session',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    /* ---- UI endpoints: same-origin session token ---- */
    if (pathname === '/health') {
      let who = {};
      try { who = identity(); } catch { who = {}; }
      return sendJson(res, 200, {
        ok: true,
        app: 'agy-app',
        port: PORT,
        account: who.email || null,
        models: (await modelCatalog().catch(() => ({ models: [] }))).models.filter((m) => m.addressable).length,
        api_key: Boolean(API_KEY) || keys.list().length > 0,
        keys: keys.list().length,
        in_flight: active,
      });
    }

    if (pathname.startsWith('/api/')) {
      if (req.headers['x-session'] !== SESSION) return sendJson(res, 401, { error: 'session' });

      if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, await appState());
      if (req.method === 'GET' && pathname === '/api/models') {
        const c = await modelCatalog({ withQuota: url.searchParams.get('quota') === '1', refresh: url.searchParams.get('refresh') === '1' });
        return sendJson(res, 200, {
          source: c.source,
          default: c.defaultModelId || DEFAULT_MODEL,
          models: c.models.filter((m) => m.addressable).map((m) => ({
            id: m.id, name: m.displayName, provider: m.provider, ctx: m.contextWindow,
            thinking: m.thinking, quota: m.quotaRemaining, reset: m.resetTime,
            groups: m.sortGroups, recommended: m.recommended, levels: levelsFor(m.id),
          })),
        });
      }
      if (req.method === 'GET' && pathname === '/api/quota') {
        try { return sendJson(res, 200, await quota()); } catch (e) { return sendJson(res, 502, { error: e.message }); }
      }
      if (req.method === 'GET' && pathname === '/api/doctor') {
        const out = { checks: [] };
        const add = (name, ok, detail) => out.checks.push({ name, ok, detail });
        try { await ensureReady(); add('auth', true, 'token live'); } catch (e) { add('auth', false, e.message); }
        try { const q = await quota(); add('quota', true, `${(q.groups || []).length} groups`); } catch (e) { add('quota', false, e.message); }
        try { const c = await modelCatalog({ refresh: true }); add('catalog', true, `${c.models.filter((m) => m.addressable).length} models`); } catch (e) { add('catalog', false, e.message); }
        out.ok = out.checks.every((c) => c.ok);
        return sendJson(res, 200, out);
      }
      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = JSON.parse(await readBody(req) || '{}');
        const patch = {};
        if (typeof body.model === 'string' && body.model) patch.default_model = body.model;
        if (typeof body.thinking === 'string') patch.thinking = body.thinking;
        if (body.thinking_budget !== undefined) patch.thinking_budget = Number(body.thinking_budget) || 0;
        saveConfig(patch);
        return sendJson(res, 200, { ok: true, settings: patch });
      }
      if (req.method === 'POST' && pathname === '/api/thinking') {
        const body = JSON.parse(await readBody(req) || '{}');
        const model = String(body.model || DEFAULT_MODEL);
        return sendJson(res, 200, {
          model,
          presets: THINKING_PRESETS,
          levels: levelsFor(model),
          resolved: normalizeThinking(model, body.thinking, body.thinking_budget),
        });
      }
      /* ---- key management (same-origin session required) ---- */
      if (pathname === '/api/keys' && req.method === 'GET') {
        return sendJson(res, 200, {
          keys: keys.list(),
          legacy: Boolean(API_KEY),
          legacy_mask: API_KEY ? keys.mask(API_KEY) : '',
          file: keys.file,
        });
      }
      if (pathname === '/api/keys' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const created = keys.create({ name: body.name });
        return sendJson(res, 201, { key: created, keys: keys.list() });
      }

      const keyMatch = pathname.match(/^\/api\/keys\/([^/]+)(?:\/([a-z]+))?$/);
      if (keyMatch) {
        const id = decodeURIComponent(keyMatch[1]);
        const action = keyMatch[2] || '';
        try {
          if (req.method === 'DELETE' && !action) return sendJson(res, 200, keys.revoke(id));
          if (req.method === 'POST' && action === 'rotate') return sendJson(res, 200, { key: keys.rotate(id), keys: keys.list() });
          if (req.method === 'POST' && action === 'reveal') return sendJson(res, 200, keys.reveal(id));
          if (req.method === 'POST' && action === 'enable') {
            const body = JSON.parse(await readBody(req) || '{}');
            return sendJson(res, 200, keys.setEnabled(id, body.enabled !== false));
          }
        } catch (e) {
          return sendJson(res, e.status || 400, { error: e.message });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      if (req.method === 'POST' && pathname === '/api/chat') return await appChat(req, res);
      return sendJson(res, 404, { error: `no route ${pathname}` });
    }

    /* ---- OpenAI-compatible API: key gate ---- */
    if (pathname.startsWith('/v1') || pathname === '/models' || pathname === '/quota') {
      if (!authenticate(req)) {
        return sendJson(res, 401, { error: { message: 'unauthorized', type: 'invalid_request_error' } });
      }

      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
        const c = await modelCatalog({ withQuota: url.searchParams.get('quota') === '1', refresh: url.searchParams.get('refresh') === '1' });
        return sendJson(res, 200, {
          object: 'list',
          data: c.models.filter((m) => m.addressable).map((m) => ({
            id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider,
            antigravity: {
              display_name: m.displayName, context_window: m.contextWindow, max_output_tokens: m.maxOutput,
              thinking: m.thinking, recommended: m.recommended, quota_remaining: m.quotaRemaining,
              reset_time: m.resetTime, thinking_levels: levelsFor(m.id),
            },
          })),
        });
      }

      const modelMatch = pathname.match(/^\/v1\/models\/(.+)$/);
      if (req.method === 'GET' && modelMatch) {
        const id = decodeURIComponent(modelMatch[1]);
        const c = await modelCatalog();
        const m = c.models.find((x) => x.id === id);
        if (!m) return sendJson(res, 404, { error: { message: `model not found: ${id}`, type: 'invalid_request_error' } });
        return sendJson(res, 200, {
          id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.provider,
          antigravity: { display_name: m.displayName, context_window: m.contextWindow, thinking: m.thinking, thinking_levels: levelsFor(m.id) },
        });
      }

      if (req.method === 'GET' && (pathname === '/v1/quota' || pathname === '/quota')) {
        try { return sendJson(res, 200, await quota()); } catch (e) { return sendJson(res, e.status || 502, { error: { message: e.message } }); }
      }

      if (req.method === 'GET' && pathname === '/v1/tier') {
        try {
          const t = await loadCodeAssist();
          return sendJson(res, 200, {
            current_tier: t?.currentTier?.id ?? null,
            allowed_tiers: (t?.allowedTiers || []).map((x) => x.id),
            paid_tier: t?.paidTier?.id ?? null,
            project: t?.cloudaicompanionProject ?? null,
          });
        } catch (e) { return sendJson(res, e.status || 502, { error: { message: e.message } }); }
      }

      if (req.method === 'POST' && pathname === '/v1/messages') return await claudeMessages(req, res);
      if (req.method === 'POST' && pathname === '/v1/chat/completions') return await openaiChat(req, res);
      if (req.method === 'POST' && pathname === '/v1/completions') return await openaiChat(req, res, { legacyText: true });
      return sendJson(res, 404, { error: { message: `not found: ${pathname}`, type: 'invalid_request_error' } });
    }

    if (req.method === 'GET') return serveStatic(req, res);
    return sendText(res, 405, 'method not allowed');
  } catch (e) {
    if (!res.headersSent) return sendJson(res, e.status || 500, { error: { message: e.message || 'internal error' } });
    try { res.end(); } catch { /* gone */ }
  }
});

/* ─────────────────────────── boot ─────────────────────────── */

function openWindow() {
  if (process.env.AGY_APP_OPEN === '0') return;
  const url = `http://${HOST}:${PORT}/`;
  const edgePaths = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const edge = edgePaths.find((p) => p && fs.existsSync(p));
  const args = [`--app=${url}`, '--window-size=1440,940', '--no-first-run', '--no-default-browser-check'];
  try {
    if (edge) {
      spawn(edge, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  } catch { /* the browser is a convenience, not the app */ }
}

/* Keep a single bad request from taking the whole app down. */
process.on('uncaughtException', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`port ${PORT} already in use — another agy-app is running`);
    process.exit(1);
  }
  console.error(`uncaught: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
});
process.on('unhandledRejection', (e) => {
  console.error(`rejection: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
});

server.listen(PORT, HOST, () => {
  try { syncFromKeyring(); } catch { /* doctor reports it */ }
  try {
    const first = keys.ensureDefault();
    if (first) console.log("api key   " + keys.mask(first.key) + "   (manage in the app: API tab)");
  } catch (e) {
    console.error("keys      " + e.message);
  }
  console.log(`agy-app  http://${HOST}:${PORT}/`);
  console.log(`api      http://${HOST}:${PORT}/v1   key: required (${keys.list().length} stored)`);
  console.log(`state    ${paths.CACHE_DIR}`);
  ensureReady()
    .then((r) => console.log(`account  ${r.email || 'unknown'}  creds: ${r.client_source}`))
    .catch((e) => console.error(`creds    ${e.message}`));
  modelCatalog()
    .then((c) => console.log(`models   ${c.models.filter((m) => m.addressable).length} (${c.source})`))
    .catch((e) => console.error(`models   ${e.message}`));
  openWindow();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}