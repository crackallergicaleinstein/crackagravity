#!/usr/bin/env node
/**
 * Real screenshot through the DevTools protocol: navigate, wait wall-clock time
 * (so a streaming reply can actually land), then capture.
 *
 *   node tools/shot.mjs <url> <out.png> [waitMs] [width] [height]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspect } from 'node:util';
process.on('uncaughtException', (e) => { console.error('uncaught:', inspect(e, { depth: 4 })); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('rejection:', inspect(e, { depth: 4 })); process.exit(1); });

const [url, out, waitMs = '60000', width = '1440', height = '940'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/shot.mjs <url> <out.png> [waitMs] [width] [height]');
  process.exit(2);
}

const EDGE = [
  path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((p) => p && fs.existsSync(p));
if (!EDGE) throw new Error('Edge not found');

const port = 9222 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shot-'));
const child = spawn(EDGE, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-allow-origins=*',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* browser not up yet */ }
    await sleep(300);
  }
  throw new Error('devtools endpoint did not come up');
}

const ws = new WebSocket(await targetWs());
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e?.message || e?.type || 'unknown'))), { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)[1](msg.result);
    pending.delete(msg.id);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, [resolve, reject]);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url });
await sleep(Number(waitMs));

const { data } = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(data, 'base64'));
console.log(`captured ${out} (${fs.statSync(out).size} bytes)`);

ws.close();
child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir */ }
process.exit(0);
