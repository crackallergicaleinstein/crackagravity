#!/usr/bin/env node
/**
 * Capture one real /api/chat stream into app/ui/demo-stream.json so the UI can
 * replay it instantly (headless screenshots cannot wait out a thinking model).
 *
 *   node tools/capture-demo.mjs [baseUrl]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'app', 'ui', 'demo-stream.json');
const BASE = process.argv[2] || 'http://127.0.0.1:8790';

const html = await (await fetch(`${BASE}/`)).text();
const session = /data-session="([^"]+)"/.exec(html)?.[1];
if (!session) throw new Error('no session token');

const question = 'In three short sentences: why does scanning a 400 MB Go binary for a client secret over-read into the next string constant, and how do you bound it?';

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-session': session },
  body: JSON.stringify({
    model: 'gemini-4-hydrogen-high',
    thinking: 'HIGH',
    messages: [{ role: 'user', content: question }],
  }),
});

if (!res.ok) throw new Error(`chat ${res.status}`);

const text = await res.text();
const events = [];
for (const frame of text.split('\n\n')) {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* partial */ }
  }
}
const done = events.find((e) => e.type === 'done');
if (!done) throw new Error('stream had no done event');

fs.writeFileSync(OUT, JSON.stringify({ question, events }, null, 2));
const thoughts = events.filter((e) => e.type === 'thought').length;
const texts = events.filter((e) => e.type === 'text').length;
console.log(`wrote ${OUT}`);
console.log(`events: ${events.length} (thought ${thoughts}, text ${texts}) tokens: ${done.usage?.total_tokens} reasoning: ${done.usage?.completion_tokens_details?.reasoning_tokens} elapsed: ${done.elapsedMs}ms`);
