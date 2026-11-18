#!/usr/bin/env node
/**
 * Client for the Antigravity hub (the local agent backend the IDE drives).
 *
 * The hub listens on loopback and trusts a CSRF token that it writes, in
 * clear text, to ~/.gemini/antigravity/daemon/hub_<port>.json. Any process
 * running as the same user can read that file and speak the same protocol.
 *
 * Usage:
 *   node hub.mjs info
 *   node hub.mjs models
 *   node hub.mjs read "C:\Windows\win.ini"
 *   node hub.mjs read-uri "file:///C:/Windows/win.ini"
 *   node hub.mjs rpc GetAuthStatus {}
 *   node hub.mjs terminal                 # create a shell, print ids
 *   node hub.mjs close <terminalId>
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
const SERVICE = '/exa.language_server_pb.LanguageServerService/';

function portOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function discover() {
  if (!fs.existsSync(DAEMON_DIR)) throw new Error(`no daemon dir: ${DAEMON_DIR}`);
  const files = fs.readdirSync(DAEMON_DIR)
    .filter((f) => /^hub_\d+\.json$/.test(f))
    .map((f) => {
      const full = path.join(DAEMON_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const { full } of files) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    if (!meta?.httpPort || !meta?.csrfToken) continue;
    if (meta.pid && !pidAlive(meta.pid)) continue;
    if (!(await portOpen(meta.httpPort))) continue;
    return { ...meta, source: full };
  }
  throw new Error('no live hub found (is Antigravity running?)');
}

export async function call(method, body = {}, hub = null) {
  const h = hub || await discover();
  const res = await fetch(`http://127.0.0.1:${h.httpPort}${SERVICE}${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': h.csrfToken },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const message = json?.message || String(json || res.statusText);
    throw Object.assign(new Error(`${res.status}: ${message}`), { status: res.status, body: json });
  }
  return json;
}

function toFileUri(input) {
  if (/^file:\/\//i.test(input)) return input;
  const abs = path.resolve(input).replace(/\\/g, '/');
  return `file:///${abs}`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'info') {
    const hub = await discover();
    console.log(JSON.stringify(hub, null, 2));
    const auth = await call('GetAuthStatus', {}, hub);
    console.log(JSON.stringify(auth, null, 2));
    return;
  }

  if (cmd === 'models') {
    const res = await call('GetAvailableModels', {});
    for (const [key, v] of Object.entries(res?.response?.models || {})) {
      const q = v?.quotaInfo?.remainingFraction;
      console.log(`${key}\t${v?.displayName || ''}\t${v?.model || ''}\tquota=${q ?? '-'}`);
    }
    return;
  }

  if (cmd === 'read' || cmd === 'read-uri') {
    const target = rest.join(' ');
    if (!target) throw new Error('usage: read <path|uri>');
    const res = await call('ReadFile', { uri: cmd === 'read-uri' ? target : toFileUri(target) });
    const content = Buffer.from(res.content || '', 'base64');
    process.stdout.write(content);
    return;
  }

  if (cmd === 'rpc') {
    const [method, json] = rest;
    if (!method) throw new Error('usage: rpc <Method> [jsonBody]');
    const body = json ? JSON.parse(json) : {};
    console.log(JSON.stringify(await call(method, body), null, 2));
    return;
  }

  if (cmd === 'terminal') {
    const res = await call('CreateTerminal', {});
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'close') {
    const [id] = rest;
    if (!id) throw new Error('usage: close <terminalId>');
    console.log(JSON.stringify(await call('CloseTerminal', { terminalId: id }), null, 2));
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

if (process.argv[1] && process.argv[1].endsWith('hub.mjs')) {
  main().catch((e) => {
    console.error(`hub: ${e.message}`);
    process.exit(1);
  });
}
