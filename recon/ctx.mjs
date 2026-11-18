import fs from 'node:fs';

const files = process.argv.slice(2);
const pats = [
  'v1internal', 'loadCodeAssist', 'onboardUser', 'LoadCodeAssist', 'OnboardUser',
  'fetchAvailableModels', 'FetchAvailableModels', 'cloudcode-pa', 'userTier',
  'cloudaicompanion', 'authorization', 'Authorization', 'Bearer', 'x-goog-api-key',
  'X-Goog-Api-Key', 'quota', 'Quota', 'tier', 'Tier', 'machineId', 'machineid',
  'proxy', 'Proxy', 'telemetry', 'Telemetry', 'unleash', 'statsig',
  'checkpoint', 'Checkpoint', 'chat', 'streamGenerateContent',
];

for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  console.error(`\n########## ${f} (${s.length} bytes) ##########`);
  for (const p of pats) {
    let idx = 0, hits = 0;
    while ((idx = s.indexOf(p, idx)) !== -1 && hits < 6) {
      const a = Math.max(0, idx - 140);
      const b = Math.min(s.length, idx + 260);
      console.log(`\n--- [${p}] @${idx} ---\n` + s.slice(a, b).replace(/\n/g, '\\n'));
      idx += p.length;
      hits++;
    }
  }
}
