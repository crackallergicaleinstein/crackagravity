/**
 * Direct Antigravity backend client.
 *
 * Talks to `v1internal:streamGenerateContent` over the account's own Google
 * OAuth quota. Nothing from the installed agent harness is sent: no
 * systemInstruction, no tool declarations, no Proctor/agent_monitoring rater
 * request. The request body is only what the caller asked for.
 */

import { getAccessToken } from './token.mjs';
import { accounts } from './pool.mjs';

/**
 * Endpoints that serve the same protocol. `daily` answers for free-tier
 * accounts while `production` rates-limits them (429), and `sandbox` is a third
 * independent bucket — verified 2026-11-18. The list is a fallback chain, not a
 * load balancer: we only move on before the first byte reaches the caller.
 */
const BASE_CANDIDATES = (process.env.AGY_BASE_URL
  ? [process.env.AGY_BASE_URL]
  : [
    'https://daily-cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://cloudcode-pa.googleapis.com',
  ]).map((url) => url.replace(/\/+$/, ''));

const BASE = BASE_CANDIDATES[0];
const PROJECT = process.env.AGY_PROJECT || 'aicode-consumers';
const USER_AGENT = process.env.AGY_USER_AGENT
  || 'antigravity/cli/1.5.11 (aidev_client; os_type=windows; arch=amd64; cl=1024248524; auth_method=consumer)';

const HEADERS = (token, accept = 'text/event-stream') => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'user-agent': USER_AGENT,
  'x-goog-api-client': 'gl-node/antigravity-direct',
  'accept-encoding': 'identity',
  accept,
});

export { PROJECT, BASE_CANDIDATES };

/** OpenAI `tools` → Gemini `functionDeclarations`, dropping anything malformed. */
export function toFunctionDeclarations(tools) {
  if (!Array.isArray(tools)) return [];
  const declarations = [];
  for (const tool of tools) {
    const fn = tool?.type === 'function' ? tool.function : null;
    if (!fn?.name) continue;
    const declaration = { name: fn.name };
    if (fn.description) declaration.description = String(fn.description).slice(0, 2048);
    if (fn.parameters && typeof fn.parameters === 'object') {
      declaration.parameters = sanitizeSchema(fn.parameters);
    }
    declarations.push(declaration);
  }
  return declarations;
}

/** Gemini rejects unknown JSON-Schema keywords; keep the subset it understands. */
function sanitizeSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 6) return { type: 'STRING' };
  const out = {};
  const type = String(schema.type || 'object').toUpperCase();
  out.type = ['OBJECT', 'ARRAY', 'STRING', 'NUMBER', 'INTEGER', 'BOOLEAN'].includes(type) ? type : 'STRING';
  if (schema.description) out.description = String(schema.description).slice(0, 1024);
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map(String);
  if (out.type === 'OBJECT') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const mapped = {};
    for (const [key, value] of Object.entries(props)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      mapped[key] = sanitizeSchema(value, depth + 1);
    }
    if (Object.keys(mapped).length > 0) out.properties = mapped;
    if (Array.isArray(schema.required)) {
      out.required = schema.required.filter((r) => typeof r === 'string' && mapped[r]);
    }
  }
  if (out.type === 'ARRAY') {
    out.items = sanitizeSchema(schema.items || { type: 'string' }, depth + 1);
  }
  return out;
}

/** OpenAI `tool_choice` → Gemini `toolConfig`. */
export function toToolConfig(toolChoice) {
  if (!toolChoice) return null;
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.function.name] } };
  }
  return null;
}

/** Build the request envelope the backend expects. */
export function buildEnvelope({
  model, contents, system, thinkingLevel, thinkingBudget, maxOutputTokens,
  tools, toolConfig, requestType = 'chat', extra, includeThoughts = true,
}) {
  const request = { contents };

  if (system) request.systemInstruction = { role: 'user', parts: [{ text: system }] };

  const generationConfig = {};
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    generationConfig.maxOutputTokens = Math.min(Math.trunc(maxOutputTokens), 65_536);
  }
  // Thoughts only come back when asked for; asking is what fills the app's
  // reasoning panel and the `reasoning` deltas other clients expect.
  //
  // Control is numeric: the backend honours `thinkingBudget` (token budget) and
  // rejects word levels that a model does not carry ("Thinking level MINIMAL is
  // not supported for this model"). A word is therefore translated to a budget,
  // and the raw level is only sent when AGY_SEND_LEVEL=1.
  const budget = resolveBudget(thinkingBudget, thinkingLevel);
  if (includeThoughts || budget) {
    const thinkingConfig = { includeThoughts: Boolean(includeThoughts) };
    if (budget) thinkingConfig.thinkingBudget = budget;
    if (process.env.AGY_SEND_LEVEL === '1' && thinkingLevel !== undefined && thinkingLevel !== null && thinkingLevel !== '') {
      thinkingConfig.thinkingLevel = normalizeLevel(thinkingLevel);
    }
    generationConfig.thinkingConfig = thinkingConfig;
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

  const declarations = toFunctionDeclarations(tools);
  if (declarations.length > 0) {
    request.tools = [{ functionDeclarations: declarations }];
    const config = toToolConfig(toolConfig);
    if (config) request.toolConfig = config;
  }

  if (extra && typeof extra === 'object') Object.assign(request, extra);

  return {
    project: PROJECT,
    requestId: `${requestType}/${crypto.randomUUID()}`,
    request,
    model,
    userAgent: 'antigravity',
    requestType,
    enabledCreditTypes: ['GOOGLE_ONE_AI'],
  };
}

/** Canonical token budgets for the five words. Numbers pass through unchanged. */
export const THINKING_BUDGETS = {
  MINIMAL: 512,
  LOW: 1024,
  MEDIUM: 4096,
  HIGH: 12288,
  XHIGH: 32768,
};

const BUDGET_MIN = 0;
const BUDGET_MAX = 32_768;

/** Any accepted input shape → a token budget, or 0 when thinking is off. */
export function resolveBudget(budget, level) {
  const numeric = Number(budget);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, Math.trunc(numeric)));
  }
  if (level === undefined || level === null || level === '') return 0;
  if (typeof level === 'number') {
    const mapped = { 1: 'MINIMAL', 2: 'MEDIUM', 3: 'HIGH', 100: 'XHIGH' }[level];
    return THINKING_BUDGETS[mapped] || Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, Math.trunc(level)));
  }
  const word = String(level).toUpperCase();
  return THINKING_BUDGETS[word] || 0;
}

/** Inverse, for reporting what a budget means. */
export function budgetToLevel(budget) {
  const n = Number(budget) || 0;
  if (n <= 0) return '';
  const entries = Object.entries(THINKING_BUDGETS).sort((a, b) => a[1] - b[1]);
  let label = entries[0][0];
  for (const [name, value] of entries) if (n >= value) label = name;
  return label;
}

function normalizeLevel(level) {
  if (typeof level === 'number') {
    if (level >= 100) return 'XHIGH';
    if (level >= 3) return 'HIGH';
    if (level === 2) return 'MEDIUM';
    return 'MINIMAL';
  }
  return String(level).toUpperCase();
}

/** Flatten a Gemini `contents` array into plain text, for callers that only speak text. */
export function textFromContents(contents) {
  return (contents || [])
    .flatMap((c) => (c.parts || []).map((p) => (typeof p.text === 'string' ? p.text : '')))
    .join('\n')
    .trim();
}

function parseSseFrame(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function* partsToEvents(response, sink) {
  if (response.modelVersion) sink.modelVersion = response.modelVersion;
  if (response.responseId) sink.responseId = response.responseId;
  if (response.usageMetadata) sink.usage = response.usageMetadata;

  for (const candidate of response.candidates || []) {
    if (candidate.finishReason) sink.finishReason = candidate.finishReason;
    for (const part of candidate.content?.parts || []) {
      if (part.functionCall) {
        const call = part.functionCall;
        yield {
          kind: 'tool_call',
          id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
          name: call.name || '',
          args: call.args && typeof call.args === 'object' ? call.args : {},
          // Gemini 3+ rejects a replayed functionCall without its signature.
          thoughtSignature: part.thoughtSignature || '',
        };
        continue;
      }
      if (typeof part.text === 'string' && part.text.length > 0) {
        yield part.thought ? { kind: 'thought', text: part.text } : { kind: 'text', text: part.text };
      }
    }
  }
}

/**
 * Stream a completion.
 *
 * Yields `{kind:'text'|'thought'|'tool_call'}` events, then one
 * `{kind:'usage', usage, modelVersion, responseId, finishReason}`.
 *
 * Before the first event it may move to another endpoint or another account;
 * after the first event it never does, so the caller never sees duplicated text.
 */
export async function* streamGenerate(input, { signal, retryAuth = true, attempt = 0 } = {}) {
  const lease = await tokenLease();
  const envelope = buildEnvelope(input);

  let emittedAny = false;
  let lastError = null;

  for (let i = 0; i < BASE_CANDIDATES.length; i += 1) {
    const base = BASE_CANDIDATES[(attempt + i) % BASE_CANDIDATES.length];
    let res;
    try {
      res = await fetch(`${base}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: HEADERS(lease.token),
        body: JSON.stringify(envelope),
        signal,
      });
    } catch (e) {
      // Network-level failure: another endpoint is worth one shot.
      lastError = Object.assign(new Error(`network: ${e.message}`), { status: 0 });
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = Object.assign(
        new Error(`upstream ${res.status} @ ${new URL(base).host}: ${body.slice(0, 500)}`),
        { status: res.status },
      );
      accounts.report(lease.entry, { ok: false, status: res.status });

      // A bad account is not a bad endpoint: switch account first, then endpoint.
      if ((res.status === 401 || res.status === 403 || res.status === 429) && retryAuth) {
        yield* streamGenerate(input, { signal, retryAuth: false, attempt: attempt + 1 });
        return;
      }
      if (res.status >= 500) continue;
      throw lastError;
    }

    if (!res.body) throw Object.assign(new Error('upstream returned no body'), { status: 502 });

    const decoder = new TextDecoder();
    let buffer = '';
    const sink = { usage: null, modelVersion: '', responseId: '', finishReason: '' };

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          const parsed = parseSseFrame(line);
          if (!parsed) continue;
          for (const event of partsToEvents(parsed.response || parsed, sink)) {
            emittedAny = true;
            yield event;
          }
        }
      }
    }

    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        const parsed = parseSseFrame(line);
        if (!parsed) continue;
        for (const event of partsToEvents(parsed.response || parsed, sink)) {
          emittedAny = true;
          yield event;
        }
      }
    }

    accounts.report(lease.entry, { ok: true });
    yield { kind: 'usage', ...sink };
    return;
  }

  throw lastError || Object.assign(new Error('all upstream candidates failed'), { status: 502 });
}

/** Token for this request: pooled account when a pool exists, else the local one. */
async function tokenLease() {
  const pool = accounts.snapshot();
  if (!pool.hasFile) return { entry: null, token: await getAccessToken() };

  const lease = await accounts.acquire();
  if (lease.token) return lease;
  // The pool could not mint a token (all cooling or refresh failed): fall back to
  // the machine's own credential so a single broken entry never kills the app.
  return { entry: lease.entry, token: await getAccessToken() };
}

/** Collect a stream into one result. */
export async function generate(input, opts = {}) {
  let text = '';
  let thoughts = '';
  const toolCalls = [];
  let meta = { usage: null, modelVersion: '', responseId: '', finishReason: '' };
  for await (const event of streamGenerate(input, opts)) {
    if (event.kind === 'text') text += event.text;
    else if (event.kind === 'thought') thoughts += event.text;
    else if (event.kind === 'tool_call') toolCalls.push(event);
    else if (event.kind === 'usage') meta = event;
  }
  return { text, thoughts, toolCalls, ...meta };
}

/** Per-account quota buckets (weekly / 5-hour, per model group). */
export async function quota() {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1internal:retrieveUserQuotaSummary`, {
    method: 'POST',
    headers: HEADERS(token, 'application/json'),
    body: JSON.stringify({ project: PROJECT }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`quota ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
  }
  return res.json();
}

/** Raw per-model quota buckets (weekly / 5h token buckets, with reset times). */
export async function modelQuota() {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1internal:retrieveUserQuota`, {
    method: 'POST',
    headers: HEADERS(token, 'application/json'),
    body: JSON.stringify({ project: PROJECT }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`model quota ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
  }
  return res.json();
}

/**
 * The account's actual model catalog, straight from the backend.
 *
 * This is the authoritative list: it is what the server is willing to serve for
 * this account's tier, so a Google AI Pro / Ultra subscriber gets their models
 * without any code change here.
 */
export async function availableModels() {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: HEADERS(token, 'application/json'),
    body: JSON.stringify({ project: PROJECT }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`models ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
  }
  return res.json();
}

/** Region and user settings — cheap way to confirm the token is live. */
export async function userInfo() {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1internal:fetchUserInfo`, {
    method: 'POST',
    headers: HEADERS(token, 'application/json'),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`userInfo ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
  }
  return res.json();
}

/** Confirm the tier the account is on (free-tier / standard-tier / g1-pro). */
export async function loadCodeAssist() {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers: HEADERS(token, 'application/json'),
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`loadCodeAssist ${res.status}: ${(await res.text()).slice(0, 400)}`), { status: res.status });
  }
  return res.json();
}
