#!/usr/bin/env node
/**
 * OpenAI-compatible facade over the local Antigravity backend (agy.exe).
 *
 * Transport: one `agy -p` process per request, JSON output, isolated cwd.
 * The agent harness still owns the upstream system prompt; this shim owns
 * the request/response contract only.
 *
 * Env:
 *   AGY_BIN        path to agy.exe
 *   AGY_MODEL      default model id
 *   AGY_PORT       listen port (default 8787)
 *   AGY_TOKEN      optional bearer token required from clients
 *   AGY_CONCURRENCY max in-flight agy processes (default 2)
 *   AGY_TIMEOUT_MS per-request limit (default 300000)
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const AGY_BIN = process.env.AGY_BIN
  || path.join(os.homedir(), '.gemini', 'bin', 'agy.exe');
const DEFAULT_MODEL = process.env.AGY_MODEL || 'gemini-3.8-flash-low';
const PORT = Number(process.env.AGY_PORT || 8787);
const TOKEN = process.env.AGY_TOKEN || '';
const CONCURRENCY = Math.max(1, Number(process.env.AGY_CONCURRENCY || 2));
const TIMEOUT_MS = Math.max(1000, Number(process.env.AGY_TIMEOUT_MS || 300000));

const MODELS = [
  'gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low',
  'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
  'gemini-pro-orchestrator-g1-pro',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.1-flash-lite', 'gemini-3-flash',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-thinking',
  'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low',
  'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low',
  'gpt-oss-120b-medium',
];

if (!fs.existsSync(AGY_BIN)) {
  console.error(`agy binary not found: ${AGY_BIN}`);
  process.exit(1);
}

/** Serialize requests so the 230 MB backend does not fan out unbounded. */
const queue = [];
let active = 0;
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
    task().then(resolve, reject).finally(() => { active -= 1; pump(); });
  }
}

/** Flatten OpenAI chat messages into a single prompt for a one-shot agent turn. */
function flatten(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  return messages.map((m) => {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('\n')
        : '';
    if (!text) return '';
    const role = m.role === 'system' ? 'SYSTEM' : m.role === 'assistant' ? 'ASSISTANT' : 'USER';
    return `[${role}]\n${text}`;
  }).filter(Boolean).join('\n\n');
}

function runAgy(prompt, model, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'json',
      '--disable-slash-commands',
    ];
    const child = spawn(AGY_BIN, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(Object.assign(new Error('upstream timeout'), { status: 504 }));
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < 8_000_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 200_000) err += d; });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`spawn failed: ${e.message}`), { status: 502 }));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const payload = parseResult(out);
      if (payload && payload.status) {
        resolve(payload);
        return;
      }
      reject(Object.assign(
        new Error(`backend failed (exit ${code}): ${(err || out).trim().slice(0, 800)}`),
        { status: 502 },
      ));
    });
  });
}

/** The backend may print warnings before the JSON result; take the last object line. */
function parseResult(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj && typeof obj === 'object' && 'status' in obj) return obj;
    } catch {
      /* try the previous line */
    }
  }
  return null;
}

function toOpenAI(payload, model) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: String(payload.response ?? '') },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: payload.usage?.input_tokens ?? 0,
      completion_tokens: payload.usage?.output_tokens ?? 0,
      total_tokens: payload.usage?.total_tokens ?? 0,
    },
  };
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4_000_000) {
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

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${TOKEN}`) return sendJson(res, 401, { error: { message: 'unauthorized' } });
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'antigravity-backend' })),
      });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON' } }); }

      const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
      let prompt;
      try { prompt = flatten(body.messages); } catch (e) {
        return sendJson(res, 400, { error: { message: e.message } });
      }

      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-shim-'));
      try {
        const payload = await schedule(() => runAgy(prompt, model, cwd));
        const result = toOpenAI(payload, model);

        if (body.stream === true) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const chunk = {
            id: result.id, object: 'chat.completion.chunk', created: result.created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: result.choices[0].message.content }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        return sendJson(res, 200, result);
      } finally {
        fs.rm(cwd, { recursive: true, force: true }, () => {});
      }
    }

    return sendJson(res, 404, { error: { message: 'not found' } });
  } catch (e) {
    const status = e.status || 500;
    return sendJson(res, status, { error: { message: e.message || 'internal error' } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`agy-shim listening on http://127.0.0.1:${PORT}`);
  console.log(`binary: ${AGY_BIN}`);
  console.log(`models: ${MODELS.length}, concurrency: ${CONCURRENCY}`);
});
