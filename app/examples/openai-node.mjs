/**
 * Exactly the call pattern from the OpenAI docs, against the local app.
 *
 *   node app/examples/openai-node.mjs
 *   node app/examples/openai-node.mjs --stream
 *
 * If the real SDK is installed, swap the import for `import OpenAI from 'openai'`
 * and nothing else changes — the server speaks the same wire format.
 */

import OpenAI from '../sdk/openai.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = path.join(os.homedir(), '.gemini', 'antigravity-direct', 'config.json');
const apiKey = process.env.AGY_TOKEN || (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).api_key || ''; } catch { return ''; }
})();

const client = new OpenAI({
  baseURL: process.env.AGY_APP_URL || 'http://127.0.0.1:8790/v1',
  apiKey,
});

const stream = process.argv.includes('--stream');

console.log('models:', (await client.models.list()).data.slice(0, 3).map((m) => m.id).join(', '), '…');

const completion = await client.chat.completions.create({
  model: process.env.AGY_MODEL || 'gemini-3.8-flash-low',
  messages: [
    { role: 'system', content: 'Answer in one short paragraph.' },
    { role: 'user', content: 'What is the difference between a mutex and a semaphore?' },
  ],
  // thinking control, same knob the UI exposes
  ...(process.env.AGY_THINKING ? { reasoning_effort: process.env.AGY_THINKING.toLowerCase() } : {}),
  ...(stream ? { stream: true } : {}),
});

if (!stream) {
  console.log('\n' + completion.choices[0].message.content);
  console.log('\nusage:', completion.usage);
  console.log('thinking:', completion.thinking);
} else {
  for await (const chunk of completion) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning) process.stderr.write(delta.reasoning);
    if (delta?.content) process.stdout.write(delta.content);
  }
  process.stdout.write('\n');
}
