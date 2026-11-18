/**
 * Model catalog, live.
 *
 * The backend answers `fetchAvailableModels` per account, so the list is
 * whatever this tier is actually allowed to serve — free-tier, Google AI Pro
 * (standard-tier / g1-pro-tier) and Ultra all come back different without any
 * branch here. The response is cached briefly, with the on-disk capture and a
 * static list as progressively older fallbacks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableModels, modelQuota } from './client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.AGY_TOKEN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-direct');
const LIVE_CACHE = path.join(CACHE_DIR, 'models.json');
const CAPTURE = process.env.AGY_MODELS_JSON || path.join(HERE, '..', '..', 'recon', 'models.json');

const TTL_MS = Math.max(30_000, Number(process.env.AGY_MODELS_TTL_MS || 600_000));

export const DEFAULT_MODEL = process.env.AGY_MODEL || 'gemini-3.8-flash-low';

const FALLBACK_IDS = [
  'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
  'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
  'gemini-pro-orchestrator-g1-pro',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.1-flash-lite', 'gemini-3-flash', 'gemini-3.5-flash-lite',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-thinking',
  'gemini-3.1-flash-image',
  'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
  'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low',
  'gpt-oss-120b-medium',
];

const PROVIDER_LABEL = {
  MODEL_PROVIDER_GOOGLE: 'google',
  MODEL_PROVIDER_ANTHROPIC: 'anthropic',
  MODEL_PROVIDER_OPENAI: 'openai',
};

/** Non-addressable ids: internal slots, tab completion, image generation helpers. */
function isAddressable(id) {
  if (!id || typeof id !== 'string') return false;
  if (/^(chat_|tab_|MODEL_|gemini-flash-worker|codewhisper)/i.test(id)) return false;
  return /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(id);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeLive(payload) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(LIVE_CACHE, JSON.stringify({ fetched_at: Date.now(), payload }, null, 2), { mode: 0o600 });
  } catch { /* cache is best-effort */ }
}

/**
 * Normalise a `fetchAvailableModels` payload into a flat, sorted catalog.
 * `sorts` preserves the client's own grouping ("Recommended", …).
 */
export function normalize(payload, quotaByModel = {}) {
  const models = payload?.models ?? {};
  const sorts = (payload?.agentModelSorts || []).map((s) => ({
    displayName: s.displayName || '',
    modelIds: (s.groups || []).flatMap((g) => g.modelIds || []),
  }));

  const rank = new Map();
  let i = 0;
  for (const sort of sorts) {
    for (const id of sort.modelIds) {
      if (!rank.has(id)) rank.set(id, i++);
    }
  }

  const entries = Array.isArray(models) ? models.map((m, idx) => [m.modelId || m.id || String(idx), m]) : Object.entries(models);

  const list = [];
  for (const [id, m] of entries) {
    const quota = m?.quotaInfo?.remainingFraction ?? quotaByModel[id]?.remainingFraction ?? null;
    list.push({
      id,
      displayName: m?.displayName || id,
      provider: PROVIDER_LABEL[m?.modelProvider] || 'other',
      thinking: Boolean(m?.supportsThinking),
      images: Boolean(m?.supportsImages),
      video: Boolean(m?.supportsVideo),
      contextWindow: Number(m?.maxTokens) || null,
      maxOutput: Number(m?.maxOutputTokens) || null,
      quotaRemaining: quota === null ? null : Number(quota),
      resetTime: m?.quotaInfo?.resetTime || quotaByModel[id]?.resetTime || null,
      recommended: Boolean(m?.recommended),
      tiered: /-tiered(-|$)/.test(id),
      addressable: isAddressable(id),
      rank: rank.has(id) ? rank.get(id) : 10_000,
      sortGroups: sorts.filter((s) => s.modelIds.includes(id)).map((s) => s.displayName),
    });
  }

  list.sort((a, b) => {
    if (a.addressable !== b.addressable) return a.addressable ? -1 : 1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.id.localeCompare(b.id);
  });
  return { models: list, sorts, defaultModelId: payload?.defaultAgentModelId || null };
}

function fromFallback() {
  return normalize({
    models: Object.fromEntries(FALLBACK_IDS.map((id) => [id, {
      displayName: id, modelProvider: 'MODEL_PROVIDER_GOOGLE', supportsThinking: true,
    }])),
    agentModelSorts: [{ displayName: 'Fallback', groups: [{ modelIds: FALLBACK_IDS }] }],
  });
}

let memory = null;

/**
 * Catalog for this account.
 *   refresh  — ignore TTL and re-ask the backend
 *   withQuota — merge per-model `retrieveUserQuota` buckets
 */
export async function catalog({ refresh = false, withQuota = false } = {}) {
  const now = Date.now();
  if (!refresh && memory && now - memory.at < TTL_MS) return memory.value;

  let payload = null;
  let source = 'live';

  const cached = readJson(LIVE_CACHE);
  if (!refresh && cached?.payload && now - Number(cached.fetched_at || 0) < TTL_MS) {
    payload = cached.payload;
    source = 'live-cache';
  }

  if (!payload) {
    try {
      payload = await availableModels();
      writeLive(payload);
      source = 'live';
    } catch (e) {
      const old = readJson(LIVE_CACHE);
      if (old?.payload) {
        payload = old.payload;
        source = `stale-cache (${e.message})`;
      }
    }
  }

  if (!payload) {
    const capture = readJson(CAPTURE);
    if (capture?.response?.models) {
      payload = capture.response;
      source = 'capture';
    }
  }

  if (!payload) {
    const value = { ...fromFallback(), source: 'static' };
    memory = { at: now, value };
    return value;
  }

  let quotaByModel = {};
  if (withQuota) {
    try {
      const q = await modelQuota();
      for (const bucket of q.buckets || []) {
        if (bucket.modelId) quotaByModel[bucket.modelId] = bucket;
      }
    } catch { /* quota is informative, not required */ }
  }

  const value = { ...normalize(payload, quotaByModel), source };
  memory = { at: now, value };
  return value;
}

/** Addressable model ids only. */
export async function ids(opts) {
  const c = await catalog(opts);
  return c.models.filter((m) => m.addressable).map((m) => m.id);
}

export function clearModelCache() {
  memory = null;
  try { fs.rmSync(LIVE_CACHE, { force: true }); } catch { /* nothing cached */ }
}
