#!/usr/bin/env node
/**
 * agy-direct CLI.
 *
 *   node agy-direct/cli.mjs "prompt" [--model id] [--thinking HIGH] [--stream]
 *   node agy-direct/cli.mjs --models [--all] [--json] [--refresh] [--quota]
 *   node agy-direct/cli.mjs --pick
 *   node agy-direct/cli.mjs --probe [--model id] [--all]
 *   node agy-direct/cli.mjs --doctor
 *   node agy-direct/cli.mjs --key-gen
 *   node agy-direct/cli.mjs --selftest [--key <token>]
 *   node agy-direct/cli.mjs --quota | --tier | --who | --recheck
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  generate, streamGenerate, quota, modelQuota, loadCodeAssist, userInfo,
} from './lib/client.mjs';
import { catalog, DEFAULT_MODEL, clearModelCache } from './lib/models.mjs';
import { identity, syncFromKeyring, seedRefreshToken, resetDiscovery, ensureReady, config } from './lib/token.mjs';
import { findBinary, loadCache, saveConfig, loadConfig, paths } from './lib/discover.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function pct(v) {
  return v === null || v === undefined ? '     -' : `${(Number(v) * 100).toFixed(1).padStart(5)}%`;
}

function humanTokens(n) {
  if (!n) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function readPrompt() {
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  if (positional.length > 0) return positional.join(' ');
  const f = flag('file');
  if (typeof f === 'string') return fs.readFileSync(f, 'utf8');
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  return '';
}

async function apiKey({ create = false } = {}) {
  if (process.env.AGY_TOKEN) return process.env.AGY_TOKEN;
  const cfg = loadConfig();
  if (cfg.api_key) return cfg.api_key;
  if (!create) return '';
  const key = `agy_${crypto.randomUUID().replace(/-/g, '')}`;
  saveConfig({ api_key: key });
  return key;
}

/* ───────────────────────────── model listing ───────────────────────────── */

function filterModels(models, { all = false, provider = '' } = {}) {
  let out = models;
  if (!all) out = out.filter((m) => m.addressable);
  if (provider) out = out.filter((m) => m.provider === provider);
  return out;
}

async function printModels({ all, json, refresh, withQuota, provider }) {
  const c = await catalog({ refresh, withQuota });
  const list = filterModels(c.models, { all, provider });

  if (json) {
    console.log(JSON.stringify({ source: c.source, default: c.defaultModelId, models: list }, null, 2));
    return;
  }

  console.log(`source: ${c.source}   default: ${c.defaultModelId || DEFAULT_MODEL}   shown: ${list.length}\n`);
  const groups = new Map();
  for (const m of list) {
    const group = m.sortGroups[0] || m.provider;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(m);
  }
  for (const [group, items] of groups) {
    console.log(`${group}`);
    console.log(`  ${'id'.padEnd(34)} ${'provider'.padEnd(10)} ${'ctx'.padEnd(6)} ${'thinking'.padEnd(9)} quota`);
    for (const m of items) {
      console.log(`  ${m.id.padEnd(34)} ${m.provider.padEnd(10)} ${humanTokens(m.contextWindow).padEnd(6)} ${(m.thinking ? 'yes' : '-').padEnd(9)} ${pct(m.quotaRemaining)}${m.recommended ? '  *' : ''}`);
    }
    console.log('');
  }
  console.log('* recommended by the backend');
}

/** Numbered picker; falls back to a plain list when there is no TTY. */
async function pick({ all }) {
  const c = await catalog({ withQuota: true });
  const list = filterModels(c.models, { all });
  if (list.length === 0) throw new Error('no models returned by the backend');

  console.log('models:');
  list.forEach((m, i) => {
    console.log(`  ${String(i + 1).padStart(2)}) ${m.id.padEnd(34)} ${m.provider.padEnd(10)} ${humanTokens(m.contextWindow).padEnd(6)} ${pct(m.quotaRemaining)}`);
  });
  if (!process.stdin.isTTY) {
    console.log('\n(no TTY: pass --model <id> with one of the ids above)');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('\nmodel number or id: ', resolve));
  rl.close();

  const trimmed = String(answer).trim();
  const byIndex = Number(trimmed);
  const chosen = Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= list.length
    ? list[byIndex - 1].id
    : trimmed;
  const valid = list.some((m) => m.id === chosen);
  saveConfig({ default_model: chosen });
  console.log(`\nselected: ${chosen}${valid ? '' : '  (not in the list — saved anyway)'}`);
  console.log('saved as default in config.json');
}

/* ───────────────────────────── model probe ───────────────────────────── */

/** Send a real one-line request to each model and report what came back. */
async function probe({ all, model, provider = 'google' }) {
  const c = await catalog({ refresh: false, withQuota: true });
  let targets;
  if (typeof model === 'string') {
    targets = [c.models.find((m) => m.id === model) || { id: model, provider: 'manual' }];
  } else {
    targets = filterModels(c.models, { all, provider });
    if (!all) targets = targets.filter((m) => m.provider === provider || provider === '');
  }
  if (targets.length === 0) throw new Error('nothing to probe');

  console.log(`probing ${targets.length} model(s)…\n`);
  console.log(`  ${'model'.padEnd(34)} ${'result'.padEnd(8)} ${'ms'.padStart(6)}  detail`);
  const rows = [];
  for (const m of targets) {
    const started = Date.now();
    try {
      // Thinking models spend output budget on thoughts first; 32 tokens is not
      // enough to reach the answer and makes a healthy model look empty.
      const r = await generate({
        model: m.id,
        contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
        maxOutputTokens: 512,
      }, {});
      const ms = Date.now() - started;
      const text = (r.text || '').replace(/\s+/g, ' ').trim();
      const thoughts = Number(r.usage?.thoughtsTokenCount ?? 0);
      const detail = text ? text.slice(0, 40) : (thoughts > 0 ? '(thinking only)' : '(empty)');
      const usage = r.usage ? `in=${r.usage.promptTokenCount ?? 0} out=${r.usage.candidatesTokenCount ?? 0} think=${thoughts}` : '';
      rows.push({ id: m.id, ok: true, ms, detail, usage, modelVersion: r.modelVersion });
      console.log(`  ${m.id.padEnd(34)} ${'OK'.padEnd(8)} ${String(ms).padStart(6)}  ${detail.padEnd(17)} ${usage} ${r.modelVersion || ''}`);
    } catch (e) {
      const ms = Date.now() - started;
      const note = /404/.test(e.message) ? 'unavailable' : /503/.test(e.message) ? 'no capacity' : 'error';
      rows.push({ id: m.id, ok: false, ms, detail: e.message, note });
      console.log(`  ${m.id.padEnd(34)} ${'FAIL'.padEnd(8)} ${String(ms).padStart(6)}  ${note}  ${String(e.message).replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  const ok = rows.filter((r) => r.ok).length;
  console.log(`\n${ok}/${rows.length} answered`);
  return ok === rows.length;
}

/* ───────────────────────────── doctor ───────────────────────────── */

async function doctor() {
  const lines = [];
  let ok = true;
  const row = (name, good, detail) => {
    if (!good) ok = false;
    lines.push(`${good ? 'OK  ' : 'FAIL'}  ${name.padEnd(13)} ${detail}`);
  };

  let binary = null;
  try { binary = findBinary({ thorough: true }); } catch { binary = null; }
  row('binary', Boolean(binary), binary ? `${binary.path} (${(binary.size / 1e6).toFixed(0)} MB via ${binary.via})` : 'no agy.exe found — built-in client pair will be tried');

  let ready = {};
  try { ready = await ensureReady(); } catch (e) { row('resolve', false, e.message); }
  const creds = loadCache();
  const credSource = ready.client_source || creds?.source || '';
  row('client_creds', Boolean(creds?.client_id), creds ? `${credSource} · ${creds.client_id}` : 'none resolved');

  let who = {};
  try { who = identity(); } catch { who = {}; }
  row('keyring', Boolean(who.keyring_target || who.token_source === 'env'), who.keyring_target || who.token_source || 'no credential found');
  row('account', Boolean(who.email), who.email || 'unknown');

  try {
    const info = await userInfo();
    row('token', true, `live · region ${info?.regionCode || '?'}`);
  } catch (e) {
    row('token', false, e.message);
  }

  try {
    const t = await loadCodeAssist();
    row('tier', true, `${t?.currentTier?.id}${t?.paidTier?.id ? ` / paid ${t.paidTier.id}` : ''} · project ${t?.cloudaicompanionProject}`);
  } catch (e) {
    row('tier', false, e.message);
  }

  try {
    const q = await quota();
    const buckets = (q.groups || []).flatMap((g) => g.buckets || []);
    row('quota', buckets.length > 0, buckets.map((b) => `${b.bucketId}=${(b.remainingFraction * 100).toFixed(1)}%`).join(' '));
  } catch (e) {
    row('quota', false, e.message);
  }

  try {
    const c = await catalog({ refresh: true });
    const addr = c.models.filter((m) => m.addressable);
    row('catalog', addr.length > 0, `${addr.length} addressable / ${c.models.length} total (${c.source})`);
  } catch (e) {
    row('catalog', false, e.message);
  }

  const key = await apiKey({ create: false });
  row('api_key', Boolean(key), key ? `configured (${key.slice(0, 12)}…)` : 'not set — set AGY_TOKEN or run --key-gen');

  console.log(lines.join('\n'));
  console.log(`\nstate: ${paths.CACHE_DIR}`);
  console.log(ok ? 'all good' : 'needs attention');
  return ok;
}

/* ───────────────────────────── selftest ───────────────────────────── */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Boot the shim on a throwaway port and exercise the whole contract. */
async function selftest({ key }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const token = typeof key === 'string' ? key : await apiKey({ create: true });
  const child = spawn(process.execPath, [path.join(HERE, '..', 'app', 'server.mjs')], {
    env: { ...process.env, AGY_APP_PORT: String(port), AGY_APP_HOST: '127.0.0.1', AGY_APP_OPEN: '0', AGY_HEARTBEAT_MS: '2000', AGY_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let boot = '';
  child.stdout.on('data', (d) => { boot += d; });
  child.stderr.on('data', (d) => { boot += d; });

  const rows = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      rows.push({ name, ok: true, detail });
      console.log(`PASS  ${name.padEnd(22)} ${detail}`);
    } catch (e) {
      rows.push({ name, ok: false, detail: e.message });
      console.log(`FAIL  ${name.padEnd(22)} ${e.message}`);
    }
  };
  const expect = (cond, message) => { if (!cond) throw new Error(message); };

  try {
    const up = await waitFor(`${base}/health`);
    if (!up) throw new Error(`server did not start:\n${boot.slice(0, 800)}`);

    await check('health', async () => {
      const r = await fetch(`${base}/health`);
      const j = await r.json();
      expect(r.ok && j.ok, `health ${r.status}`);
      return `account=${j.account} models=${j.models}`;
    });

    await check('models_no_key_401', async () => {
      const r = await fetch(`${base}/v1/models`);
      expect(r.status === 401, `expected 401, got ${r.status}`);
      return 'rejected without key';
    });

    await check('models_with_key', async () => {
      const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
      const j = await r.json();
      expect(r.ok, `models ${r.status}`);
      expect(Array.isArray(j.data) && j.data.length > 0, 'empty model list');
      return `${j.data.length} models`;
    });

    await check('api_key_header', async () => {
      const r = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': token } });
      expect(r.ok, `x-api-key rejected: ${r.status}`);
      return 'x-api-key accepted';
    });

    await check('chat_no_key_401', async () => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r.status === 401, `expected 401, got ${r.status}`);
      return 'rejected without key';
    });

    await check('chat', async () => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: 'Reply with exactly: selftest-ok' }] }),
      });
      const j = await r.json();
      expect(r.ok, `chat ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const text = j.choices?.[0]?.message?.content || '';
      return `${JSON.stringify(text.slice(0, 40))} tokens=${j.usage?.total_tokens ?? '?'}`;
    });

    await check('chat_stream', async () => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: DEFAULT_MODEL, stream: true, messages: [{ role: 'user', content: 'Count to 3.' }] }),
      });
      expect(r.ok, `stream ${r.status}`);
      const text = await r.text();
      expect(text.includes('[DONE]'), 'no [DONE] frame');
      expect(text.includes('chat.completion.chunk'), 'no chunk frames');
      return `${text.split('\n\n').length} frames`;
    });

    await check('tool_call', async () => {
      const tools = [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      }];
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          tools,
          messages: [{ role: 'user', content: 'Read C:\\Windows\\win.ini with the tool.' }],
        }),
      });
      const j = await r.json();
      expect(r.ok, `tools ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const calls = j.choices?.[0]?.message?.tool_calls || [];
      expect(calls.length > 0, 'model returned no tool_calls');
      expect(j.choices[0].finish_reason === 'tool_calls', `finish_reason=${j.choices[0].finish_reason}`);
      return `${calls[0].function.name}(${calls[0].function.arguments})`;
    });

    await check('thinking_events', async () => {
      const html = await (await fetch(`${base}/`)).text();
      const session = /data-session="([^"]+)"/.exec(html)?.[1];
      expect(session, 'no session token in index.html');
      const r = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session': session },
        body: JSON.stringify({
          model: 'gemini-4-hydrogen-high',
          thinking: 'HIGH',
          messages: [{ role: 'user', content: 'In one sentence: why bound a buffer scan?' }],
        }),
      });
      expect(r.ok, `chat ${r.status}`);
      const text = await r.text();
      const thoughts = (text.match(/"type":"thought"/g) || []).length;
      expect(thoughts > 0, 'no thought events came back');
      expect(text.includes('"type":"done"'), 'no done event');
      return `${thoughts} thought frames`;
    });

    await check('claude_message', async () => {
      const r = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: 120, messages: [{ role: 'user', content: 'Reply with exactly: claude-ok' }] }),
      });
      const j = await r.json();
      expect(r.ok, `messages ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
      expect(j.type === 'message', `type=${j.type}`);
      expect(Array.isArray(j.content) && j.content[0]?.text, 'no text block');
      return `${JSON.stringify(j.content[0].text.slice(0, 24))} stop=${j.stop_reason}`;
    });

    await check('claude_stream', async () => {
      const r = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: DEFAULT_MODEL, max_tokens: 120, stream: true, messages: [{ role: 'user', content: 'Count to three.' }] }),
      });
      expect(r.ok, `messages stream ${r.status}`);
      const text = await r.text();
      expect(text.includes('message_start'), 'no message_start');
      expect(text.includes('content_block_delta'), 'no deltas');
      expect(text.includes('message_stop'), 'no message_stop');
      return `${text.split('\n\n').length} frames`;
    });

    await check('thinking_budget', async () => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: 'gemini-4-hydrogen-high',
          thinking_budget: 8192,
          messages: [{ role: 'user', content: 'In one sentence: why bound a loop over outside data?' }],
        }),
      });
      const j = await r.json();
      expect(r.ok, `budget ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
      expect(j.thinking?.budget === 8192, `resolved ${JSON.stringify(j.thinking)}`);
      const thoughts = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      expect(thoughts > 0, 'thinking_budget produced no thought tokens');
      return `budget=${j.thinking.budget} label=${j.thinking.label} thoughts=${thoughts}`;
    });

    await check('api_key_lifecycle', async () => {
      const html = await (await fetch(`${base}/`)).text();
      const session = /data-session="([^"]+)"/.exec(html)?.[1];
      expect(session, 'no session token');

      const created = await (await fetch(`${base}/api/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session': session },
        body: JSON.stringify({ name: 'selftest' }),
      })).json();
      const fresh = created.key?.key;
      expect(fresh, 'no key returned');

      const okRes = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${fresh}` } });
      expect(okRes.ok, `new key rejected: ${okRes.status}`);

      await fetch(`${base}/api/keys/${created.key.id}`, { method: 'DELETE', headers: { 'x-session': session } });
      const afterRes = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${fresh}` } });
      expect(afterRes.status === 401, `revoked key still works: ${afterRes.status}`);
      return 'create → use → revoke → 401';
    });

    await check('quota_endpoint', async () => {
      const r = await fetch(`${base}/v1/quota`, { headers: { authorization: `Bearer ${token}` } });
      const j = await r.json();
      expect(r.ok, `quota ${r.status}`);
      const buckets = (j.groups || []).flatMap((g) => g.buckets || []);
      expect(buckets.length > 0, 'no buckets');
      return `${buckets.length} buckets`;
    });
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} passed   key=${token.slice(0, 12)}…`);
  return failed === 0;
}

/* ───────────────────────────── main ───────────────────────────── */

async function main() {
  if (flag('selftest')) {
    process.exitCode = (await selftest({ key: flag('key') })) ? 0 : 1;
    return;
  }

  if (flag('key-gen')) {
    const key = await apiKey({ create: true });
    console.log(key);
    console.log(`\nstored in ${paths.CONFIG_FILE}`);
    console.log('clients send: Authorization: Bearer <key>   (or x-api-key / api-key)');
    return;
  }

  if (flag('doctor')) {
    process.exitCode = (await doctor()) ? 0 : 1;
    return;
  }

  if (flag('recheck')) {
    resetDiscovery();
    const who = syncFromKeyring({ force: true });
    clearModelCache();
    console.log(`rescan done: target=${who.keyring_target} account=${who.email || 'unknown'}`);
    console.log(`state: ${paths.CACHE_DIR}`);
    return;
  }

  if (flag('models')) {
    await printModels({
      all: Boolean(flag('all')),
      json: Boolean(flag('json')),
      refresh: Boolean(flag('refresh')),
      withQuota: Boolean(flag('quota')),
      provider: flag('provider') || (flag('google') ? 'google' : flag('claude') ? 'anthropic' : flag('gpt') ? 'openai' : ''),
    });
    return;
  }

  if (flag('pick')) {
    await pick({ all: Boolean(flag('all')) });
    return;
  }

  if (flag('probe')) {
    process.exitCode = (await probe({
      all: Boolean(flag('all')),
      model: typeof flag('model') === 'string' ? flag('model') : undefined,
      provider: flag('provider') || 'google',
    })) ? 0 : 1;
    return;
  }

  if (flag('quota')) {
    const q = await quota();
    for (const group of q.groups || []) {
      console.log(`\n${group.displayName}`);
      for (const b of group.buckets || []) {
        console.log(`  ${b.bucketId.padEnd(26)} ${(Number(b.remainingFraction) * 100).toFixed(1).padStart(5)}% left   resets ${b.resetTime}`);
      }
    }
    return;
  }

  if (flag('tier')) {
    const t = await loadCodeAssist();
    console.log(JSON.stringify({
      current_tier: t?.currentTier?.id,
      allowed_tiers: (t?.allowedTiers || []).map((x) => x.id),
      paid_tier: t?.paidTier?.id ?? null,
      project: t?.cloudaicompanionProject,
      upgrade: t?.upgradeSubscriptionText ?? null,
    }, null, 2));
    return;
  }

  if (typeof flag('login-token') === 'string') {
    seedRefreshToken(flag('login-token'));
    console.log(`seeded ${config.CACHE_FILE}`);
    return;
  }

  if (flag('who')) {
    syncFromKeyring({ force: true });
    console.log(JSON.stringify(identity(), null, 2));
    return;
  }

  const prompt = readPrompt().trim();
  if (!prompt) {
    console.error('no prompt. pass text, --file <path>, or pipe stdin. try --models / --pick / --doctor');
    process.exit(2);
  }

  const cfg = loadConfig();
  const model = flag('model') || cfg.default_model || DEFAULT_MODEL;
  const thinking = flag('thinking');
  const budget = flag('budget');
  const input = {
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    thinkingLevel: typeof thinking === 'string' && !/^[0-9]+$/.test(thinking) ? thinking : undefined,
    thinkingBudget: budget !== undefined ? Number(budget) : (typeof thinking === 'string' && /^[0-9]+$/.test(thinking) ? Number(thinking) : undefined),
  };

  if (flag('stream')) {
    for await (const event of streamGenerate(input)) {
      if (event.kind === 'text') process.stdout.write(event.text);
      else if (event.kind === 'tool_call') process.stdout.write(`\n[tool_call] ${event.name}(${JSON.stringify(event.args)})\n`);
      else if (event.kind === 'thought' && process.env.AGY_SHOW_THOUGHTS === '1') process.stderr.write(`[thought] ${event.text}\n`);
      else if (event.kind === 'usage') {
        process.stderr.write(`\n[usage] prompt=${event.usage?.promptTokenCount ?? 0} out=${event.usage?.candidatesTokenCount ?? 0} model=${event.modelVersion}\n`);
      }
    }
    return;
  }

  const result = await generate(input);
  if (process.env.AGY_JSON === '1') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.text);
  for (const call of result.toolCalls) {
    console.log(`[tool_call] ${call.name}(${JSON.stringify(call.args)}) id=${call.id}`);
  }
  if (process.env.AGY_SHOW_THOUGHTS === '1' && result.thoughts) {
    console.error(`\n[thoughts]\n${result.thoughts}`);
  }
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
