/**
 * Google OAuth for the Antigravity backend.
 *
 * Credentials are never assumed stable: the refresh token is read from whatever
 * Windows Credential Manager entry actually holds one, and the OAuth client
 * id/secret are re-derived from the installed binary when a refresh is rejected.
 * A machine with no keyring entry can be seeded from AGY_REFRESH_TOKEN.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findAuthTarget, readCredential, scanCredentials, resolveClient, invalidateClient, loadCache,
} from './discover.mjs';

const CACHE_DIR = process.env.AGY_TOKEN_DIR
  || path.join(os.homedir(), '.gemini', 'antigravity-direct');
const CACHE_FILE = path.join(CACHE_DIR, 'token.json');

let state = loadTokenCache();

function loadTokenCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return c && c.refresh_token ? c : null;
  } catch {
    return null;
  }
}

function saveTokenCache(next) {
  state = { ...(state || {}), ...next };
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}

/** Environment seed wins when set, so a machine without a keyring still works. */
function seedFromEnv() {
  const token = process.env.AGY_REFRESH_TOKEN;
  if (!token) return false;
  saveTokenCache({
    refresh_token: token,
    access_token: '',
    expiry: 0,
    email: process.env.AGY_EMAIL || '',
    auth_method: 'consumer',
    source: 'env',
    seeded_at: new Date().toISOString(),
  });
  return true;
}

/**
 * Read the token pair out of the installed client's credential store.
 * The target name is discovered, not assumed.
 */
export function syncFromKeyring({ force = false } = {}) {
  if (!state && seedFromEnv()) return state;

  const entries = scanCredentials();
  if (entries.length === 0) {
    throw Object.assign(
      new Error('no credential carrying a Google refresh token was found for this user'),
      { code: 'KEYRING' },
    );
  }
  const remembered = force ? null : loadCache()?.keyring_target;
  const ordered = [];
  if (remembered) ordered.push(remembered);
  const best = findAuthTarget({ all: entries });
  if (best && !ordered.includes(best)) ordered.push(best);
  for (const e of entries) if (!ordered.includes(e.target)) ordered.push(e.target);

  let lastError = null;
  for (const target of ordered) {
    let blob = null;
    try { blob = readCredential(target); } catch { blob = null; }
    if (!blob) continue;
    try {
      return adopt(target, blob, entries);
    } catch (e) {
      lastError = e;
    }
  }
  throw Object.assign(
    lastError || new Error('no readable credential carried a Google refresh token'),
    { code: 'KEYRING' },
  );
}

/** Parse a credential blob and store the session. */
function adopt(target, blob, entries) {
  const start = blob.indexOf('{');
  if (start < 0) throw Object.assign(new Error('credential blob is not JSON'), { code: 'KEYRING' });
  const parsed = JSON.parse(blob.slice(start));
  const token = parsed.token || parsed;
  if (!token.refresh_token) throw Object.assign(new Error('credential blob has no refresh_token'), { code: 'KEYRING' });

  const entry = entries.find((e) => e.target === target);
  saveTokenCache({
    access_token: token.access_token || '',
    refresh_token: token.refresh_token,
    expiry: token.expiry ? Date.parse(token.expiry) : 0,
    auth_method: parsed.auth_method || 'consumer',
    email: entry?.email || parsed.id_token_email || '',
    writer_id: parsed.writer_id || '',
    keyring_target: target,
    source: 'keyring',
    synced_at: new Date().toISOString(),
  });
  return state;
}

export function identity() {
  if (!state || !state.keyring_target) {
    try { syncFromKeyring(); } catch { /* report what we have */ }
  }
  return {
    email: state?.email || '',
    auth_method: state?.auth_method || '',
    keyring_target: state?.keyring_target || '',
    token_source: state?.source || '',
    token_expiry: state?.expiry ? new Date(state.expiry).toISOString() : null,
  };
}

/** Keyring read, then client credentials resolved and verified in one call. */
export async function ensureReady() {
  // Re-read the store: the remembered target may have been renamed or deleted
  // by an update, and that is exactly the state doctor must report honestly.
  syncFromKeyring({ force: true });
  const client = await resolveClient({ refreshToken: state.refresh_token });
  return { ...identity(), client_source: client.source, client_id: client.client_id };
}

export async function getAccessToken({ force = false } = {}) {
  if (!state) syncFromKeyring();
  if (!force && state.access_token && state.expiry && state.expiry - Date.now() > 60_000) {
    return state.access_token;
  }
  return refreshWithRecovery(state.refresh_token);
}

/**
 * Refresh, recovering from the ways an update shows up:
 *   token rotated by the installed client → re-read the credential store
 *   client pair re-signed by an update   → rescan the binary
 */
async function refreshWithRecovery(refreshToken) {
  try {
    return await refresh(refreshToken);
  } catch (e) {
    if (e.status !== 400 && e.status !== 401) throw e;

    const before = state?.refresh_token;
    try { syncFromKeyring({ force: true }); } catch { /* no keyring: try the pair */ }

    if (state?.refresh_token && state.refresh_token !== before) {
      return refresh(state.refresh_token);
    }
    invalidateClient();
    const creds = await resolveClient({ refreshToken: state.refresh_token, force: true });
    return refresh(state.refresh_token, creds);
  }
}

async function refresh(refreshToken, creds) {
  const client = creds || await resolveClient({ refreshToken });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw Object.assign(
      new Error(`token refresh failed (${res.status}): ${body.error_description || body.error || 'unknown'}`),
      { status: res.status, reason: body.error || '' },
    );
  }
  saveTokenCache({
    access_token: body.access_token,
    expiry: Date.now() + (Number(body.expires_in || 3599) * 1000),
    scope: body.scope || '',
    client_source: client.source,
    refreshed_at: new Date().toISOString(),
  });
  return state.access_token;
}

/** Seed the local cache from a refresh token obtained elsewhere. */
export function seedRefreshToken(refreshToken, { email = '' } = {}) {
  saveTokenCache({
    refresh_token: refreshToken,
    access_token: '',
    expiry: 0,
    email,
    auth_method: 'consumer',
    source: 'seeded',
    seeded_at: new Date().toISOString(),
  });
  return state;
}

/** Forget everything derived, forcing a full re-discovery on the next call. */
export function resetDiscovery() {
  state = null;
  invalidateClient();
  try { fs.rmSync(CACHE_FILE, { force: true }); } catch { /* nothing cached */ }
}

export const config = { CACHE_FILE, CACHE_DIR };
