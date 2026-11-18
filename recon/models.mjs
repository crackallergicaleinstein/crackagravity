import fs from 'node:fs';

const files = process.argv.slice(2);
const pats = [
  'antigravity-releases', 'binaryPath', 'app_data_dir', 'storage.googleapis.com',
  'systemInstruction', 'system_instruction', 'systemPrompt', 'SYSTEM_PROMPT',
  'You are', 'agent_api', 'GEMINI', 'harness', 'jetski',
];
const models = /["'`](gemini[0-9a-z.\-]{2,28}|claude[0-9a-z.\-]{2,28}|gpt-oss[0-9a-z.\-]{0,12}|gpt-[0-9][0-9a-z.\-]{0,20})["'`]/gi;

for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  console.log(`\n########## ${f} ##########`);
  const ms = new Set();
  for (const m of s.matchAll(models)) ms.add(m[1].toLowerCase());
  console.log('MODELS: ' + [...ms].sort().join(', '));
  for (const p of pats) {
    let i = 0, n = 0;
    while ((i = s.indexOf(p, i)) !== -1 && n < 2) {
      console.log(`\n--- [${p}] @${i} ---\n` + s.slice(Math.max(0, i - 180), i + 220).replace(/\n/g, '\\n'));
      i += p.length; n++;
    }
  }
}
