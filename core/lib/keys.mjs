/**
 * Local API keys for the app's own /v1 surface.
 *
 * Keys are created and revoked from the UI, and used by clients as
 * `Authorization: Bearer agy_…`. They are a gate for this app only — the Google
 * credentials that reach the backend live in the credential store, not here.
 *
 * File: ~/.gemini/antigravity-direct/apikeys.json (0700 dir, 0600 file)
 *   [{ id, name, key, created_at, last_used_at, requests, enabled }]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.env.AGY_TOKEN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-direct');
const FILE = path.join(DIR, 'apikeys.json');

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const text = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    cache = Array.isArray(parsed) ? parsed : parsed.keys || [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list) {
  cache = list;
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

function mintKey() {
  return `agy_${crypto.randomBytes(16).toString('hex')}`;
}

export function mask(key) {
  if (!key) return '';
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}

/** All keys, masked by default. `reveal` is for the UI's copy button. */
export function list({ reveal = false } = {}) {
  return read()
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      masked: mask(entry.key),
      key: reveal ? entry.key : undefined,
      created_at: entry.created_at,
      last_used_at: entry.last_used_at || null,
      requests: entry.requests || 0,
      enabled: entry.enabled !== false,
    }));
}

export function create({ name = 'default' } = {}) {
  const entry = {
    id: crypto.randomUUID(),
    name: String(name || 'default').slice(0, 40),
    key: mintKey(),
    created_at: new Date().toISOString(),
    last_used_at: null,
    requests: 0,
    enabled: true,
  };
  write([...read(), entry]);
  return { ...entry, masked: mask(entry.key) };
}

/** Replace the secret in place, keeping the name and history. */
export function rotate(id) {
  const listNow = read();
  const entry = listNow.find((e) => e.id === id);
  if (!entry) throw Object.assign(new Error('key not found'), { status: 404 });
  entry.key = mintKey();
  entry.created_at = new Date().toISOString();
  entry.last_used_at = null;
  entry.requests = 0;
  write(listNow);
  return { ...entry, masked: mask(entry.key) };
}

export function revoke(id) {
  const listNow = read();
  const next = listNow.filter((e) => e.id !== id);
  if (next.length === listNow.length) throw Object.assign(new Error('key not found'), { status: 404 });
  write(next);
  return { ok: true, id };
}

export function setEnabled(id, enabled) {
  const listNow = read();
  const entry = listNow.find((e) => e.id === id);
  if (!entry) throw Object.assign(new Error('key not found'), { status: 404 });
  entry.enabled = Boolean(enabled);
  write(listNow);
  return { ok: true, id, enabled: entry.enabled };
}

export function reveal(id) {
  const entry = read().find((e) => e.id === id);
  if (!entry) throw Object.assign(new Error('key not found'), { status: 404 });
  return { id, key: entry.key };
}

/** Constant-time compare that tolerates different lengths. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Resolve a presented key. `extra` holds legacy sources (env token, the key in
 * config.json) so an existing setup keeps working after the store exists.
 */
export function verify(presented, extra = []) {
  if (!presented) return null;

  for (const candidate of extra) {
    if (candidate && safeEqual(presented, candidate)) return { id: 'legacy', name: 'legacy', legacy: true };
  }

  for (const entry of read()) {
    if (entry.enabled === false) continue;
    if (!safeEqual(presented, entry.key)) continue;
    entry.last_used_at = new Date().toISOString();
    entry.requests = (entry.requests || 0) + 1;
    // Best-effort write: a read-only profile must not break the request.
    try { write(read()); } catch { /* ignore */ }
    return { id: entry.id, name: entry.name };
  }
  return null;
}

/** Keys to seed on first boot: one default key so the API is usable at once. */
export function ensureDefault() {
  const existing = read();
  if (existing.length > 0) return existing[0];
  return create({ name: 'default' });
}

export const file = FILE;
