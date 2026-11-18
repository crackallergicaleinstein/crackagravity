import fs from 'node:fs';

const f = process.argv[2];
const s = fs.readFileSync(f, 'latin1');

const pats = {
  rpc: /\/exa\.[A-Za-z0-9_.]+\/[A-Za-z0-9_]+/g,
  rpc2: /\/gemini_coder\.[A-Za-z0-9_.]+\/[A-Za-z0-9_]+/g,
  v1: /v1internal:[A-Za-z]+/g,
  host: /https:\/\/(?:[a-z0-9\-]+\.)+[a-z]{2,}(\/[A-Za-z0-9_\-\/]*)?/g,
};
for (const [k, re] of Object.entries(pats)) {
  const set = new Set();
  for (const m of s.matchAll(re)) set.add(m[0]);
  console.log(`\n### ${k} (${set.size})`);
  console.log([...set].sort().slice(0, 120).join('\n'));
}
