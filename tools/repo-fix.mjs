/**
 * Housekeeping for the published repos: rename/archive the accidental one and
 * drop a stale branch. Token comes from the same credential the push used.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const publishSource = fs.readFileSync('tools/publish.mjs', 'utf8');
const start = publishSource.indexOf('const PS = `') + 'const PS = `'.length;
const end = publishSource.indexOf('`;', start);
const ps = publishSource.slice(start, end);

const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
  encoding: 'utf8',
  windowsHide: true,
}).replace(/\0/g, '').trim();

const headers = {
  authorization: `token ${raw}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'agy-housekeeping',
  'content-type': 'application/json',
};

const login = 'crackallergicaleinstein';

let res = await fetch(`https://api.github.com/repos/${login}/--drop`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ name: 'agy-scratch', private: true, archived: true }),
});
console.log(`rename --drop -> agy-scratch (private, archived): ${res.status} ${res.ok ? 'ok' : (await res.text()).slice(0, 140)}`);

res = await fetch(`https://api.github.com/repos/${login}/agy/git/refs/heads/master`, { method: 'DELETE', headers });
console.log(`delete stale branch master: ${res.status} ${res.status === 204 ? 'gone' : ''}`);

const repo = await (await fetch(`https://api.github.com/repos/${login}/agy`, { headers })).json();
console.log(`agy: default=${repo.default_branch} private=${repo.private} branch=${repo.default_branch}`);
