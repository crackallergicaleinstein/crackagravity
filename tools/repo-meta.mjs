/**
 * Rename the published repo and set its metadata.
 * Reads the same wincred token the publish helper uses.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const src = fs.readFileSync('tools/publish.mjs', 'utf8');
const start = src.indexOf('const PS = `') + 'const PS = `'.length;
const end = src.indexOf('`;', start);
const ps = src.slice(start, end);

const token = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  encoding: 'utf8',
  windowsHide: true,
}).replace(/\0/g, '').trim();

const headers = {
  authorization: `token ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'crackagravity-meta',
  'content-type': 'application/json',
};

const me = await (await fetch('https://api.github.com/user', { headers })).json();
const owner = me.login;

const rename = await fetch(`https://api.github.com/repos/${owner}/agy`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({
    name: 'crackagravity',
    description: 'Antigravity limits, for other work — OpenAI/Claude endpoint on the account\'s own quota. Harness prompt, tool roster, rater and spawn all deleted.',
    homepage: '',
  }),
});

if (rename.ok) {
  const body = await rename.json();
  console.log(`renamed: ${body.full_name}`);
} else {
  console.log(`rename status ${rename.status}: ${(await rename.text()).slice(0, 200)}`);
}

const topics = await fetch(`https://api.github.com/repos/${owner}/crackagravity/topics`, {
  method: 'PUT',
  headers: { ...headers, accept: 'application/vnd.github.mercy-preview+json' },
  body: JSON.stringify({ names: ['antigravity', 'openai-api', 'claude-api', 'gemini', 'api-proxy', 'nodejs', 'windows-app'] }),
});
console.log(`topics: ${topics.status} ${topics.ok ? 'ok' : (await topics.text()).slice(0, 120)}`);

const info = await (await fetch(`https://api.github.com/repos/${owner}/crackagravity`, { headers })).json();
console.log(`${info.html_url}  default=${info.default_branch} private=${info.private}`);
