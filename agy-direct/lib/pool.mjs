/**
 * Account pool.
 *
 * One machine usually has one Antigravity account in the credential store, and
 * that is the default path. When an `accounts.json` exists with more than one
 * entry, requests rotate across them instead: healthy accounts in round-robin,
 * and any account that answers 429/403 gets a cooldown instead of being hammered.
 *
 * File format (`~/.gemini/antigravity-direct/accounts.json`, or AGY_ACCOUNTS_FILE):
 *   [{ "refresh_token": "1//…", "email": "a@example.com", "enabled": true }, …]
 *
 * Access tokens are cached in `accounts-tokens.json` next to it. Refresh tokens
 * stay in that file only; nothing else is written.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClient } from './discover.mjs';

const DIR = process.env.AGY_TOKEN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-direct');
const ACCOUNTS_FILE = process.env.AGY_ACCOUNTS_FILE || path.join(DIR, 'accounts.json');
const TOKENS_FILE = path.join(DIR, 'accounts-tokens.json');

const MAX_COOLDOWN_MS = 15 * 60_000;
const BASE_COOLDOWN_MS = 60_000;

/** In-memory account records, keyed by refresh_token (stable across restarts). */
const records = new Map();
let order = [];
let cursor = 0;
let loaded = false;

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveTokens() {
  const out = {};
  for (const [key, rec] of records) {
    out[key] = { access_token: rec.accessToken, expiry: rec.expiry, email: rec.email };
  }
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
  } catch { /* cache is best-effort */ }
}

function load() {
  if (loaded) return;
  loaded = true;

  let entries = [];
  try {
    // PowerShell's `Set-Content -Encoding utf8` writes a BOM; strip it.
    const text = fs.readFileSync(ACCOUNTS_FILE, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    entries = (Array.isArray(raw) ? raw : raw.accounts || []).filter((e) => e && e.refresh_token);
  } catch {
    entries = [];
  }

  const cached = loadTokens();
  for (const entry of entries) {
    const key = entry.refresh_token;
    if (records.has(key)) continue;
    const c = cached[key] || {};
    records.set(key, {
      id: key.slice(-8),
      refreshToken: key,
      email: entry.email || c.email || '',
      enabled: entry.enabled !== false,
      accessToken: c.access_token || '',
      expiry: Number(c.expiry) || 0,
      failures: 0,
      cooldownUntil: 0,
      lastStatus: null,
      lastUsed: 0,
    });
  }
  order = [...records.keys()];
}

/** True when the file provides more than one usable account. */
function isMulti() {
  load();
  return order.length > 1;
}

function healthyAt(now) {
  return order.filter((key) => {
    const rec = records.get(key);
    return rec && rec.enabled && (!rec.cooldownUntil || rec.cooldownUntil <= now);
  });
}

/** Pick the next account and make sure its access token is fresh. */
async function acquire({ model = '' } = {}) {
  load();
  if (order.length === 0) {
    return { entry: null, token: null, reason: 'no-accounts-file' };
  }

  const now = Date.now();
  let candidates = healthyAt(now);
  if (candidates.length === 0) {
    // Everything is cooling down: take the one that recovers first rather than
    // failing the request outright.
    candidates = [...order].filter((key) => records.get(key)?.enabled);
    candidates.sort((a, b) => (records.get(a).cooldownUntil || 0) - (records.get(b).cooldownUntil || 0));
    candidates = candidates.slice(0, 1);
  }
  if (candidates.length === 0) return { entry: null, token: null, reason: 'all-disabled' };

  cursor = (cursor + 1) % candidates.length;
  const key = candidates[cursor % candidates.length];
  const rec = records.get(key);

  try {
    const token = await ensureToken(rec);
    rec.lastUsed = Date.now();
    return { entry: rec, token, reason: '' };
  } catch (e) {
    rec.cooldownUntil = Date.now() + BASE_COOLDOWN_MS;
    rec.lastStatus = e.status || 'refresh-failed';
    return { entry: rec, token: null, reason: e.message };
  }
}

async function ensureToken(rec) {
  if (rec.accessToken && rec.expiry - Date.now() > 60_000) return rec.accessToken;

  const client = await resolveClient({ refreshToken: rec.refreshToken });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      grant_type: 'refresh_token',
      refresh_token: rec.refreshToken,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const err = Object.assign(
      new Error(`account refresh failed (${res.status}): ${body.error_description || body.error || 'unknown'}`),
      { status: res.status, reason: body.error || '' },
    );
    if (body.error === 'invalid_grant') {
      rec.enabled = false;
      rec.lastStatus = 'invalid_grant';
    }
    throw err;
  }

  rec.accessToken = body.access_token;
  rec.expiry = Date.now() + Number(body.expires_in || 3599) * 1000;
  rec.failures = 0;
  rec.lastStatus = 'ok';
  saveTokens();
  return rec.accessToken;
}

/** Record the outcome of a request so the next one avoids a bad account. */
function report(entry, { ok, status = 0 } = {}) {
  if (!entry || !records.has(entry.refreshToken)) return;
  const rec = records.get(entry.refreshToken);

  if (ok) {
    rec.failures = 0;
    rec.cooldownUntil = 0;
    rec.lastStatus = 'ok';
    return;
  }

  rec.lastStatus = status || 'error';
  if (status === 429) {
    rec.failures += 1;
    rec.cooldownUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (rec.failures - 1));
    return;
  }
  if (status === 401) {
    rec.accessToken = '';
    rec.expiry = 0;
    return;
  }
  if (status === 403) {
    rec.failures += 1;
    rec.cooldownUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, 10 * BASE_COOLDOWN_MS);
    if (rec.failures >= 3) rec.enabled = false;
    return;
  }
  rec.cooldownUntil = Date.now() + BASE_COOLDOWN_MS;
}

/** Read-only view for the UI and doctor. */
function snapshot() {
  load();
  return {
    multi: order.length > 1,
    file: ACCOUNTS_FILE,
    hasFile: order.length > 0,
    accounts: order.map((key) => {
      const rec = records.get(key);
      return {
        id: rec.id,
        email: rec.email,
        enabled: rec.enabled,
        cooling: rec.cooldownUntil > Date.now(),
        cooldownSeconds: rec.cooldownUntil > Date.now() ? Math.ceil((rec.cooldownUntil - Date.now()) / 1000) : 0,
        failures: rec.failures,
        lastStatus: rec.lastStatus,
      };
    }),
  };
}

/** Forget cached access tokens so the next acquire re-refreshes. */
function reset() {
  for (const rec of records.values()) {
    rec.accessToken = '';
    rec.expiry = 0;
    rec.cooldownUntil = 0;
    rec.failures = 0;
  }
  saveTokens();
}

export const accounts = {
  isMulti, acquire, report, snapshot, reset, ensureToken,
  file: ACCOUNTS_FILE,
};
