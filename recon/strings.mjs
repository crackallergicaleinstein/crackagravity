import fs from 'node:fs';

const f = process.argv[2];
const s = fs.readFileSync(f, 'utf8');

const grabs = {
  rpcPaths: /["'`][^"'`]{0,40}v1[a-zA-Z]*:[a-zA-Z]+[^"'`]{0,40}["'`]/g,
  apiPaths: /["'`]\/v1[a-zA-Z0-9_\/:.\-]{2,80}["'`]/g,
  hdrs: /["'`](x-goog[a-z0-9\-]*|X-Goog-[A-Za-z0-9\-]+|user-agent|User-Agent|x-antigravity[a-z\-]*|x-codeium[a-z\-]*)["'`]/g,
  oauth: /[a-zA-Z0-9_\-]{20,}\.apps\.googleusercontent\.com/g,
  keys: /AIza[0-9A-Za-z_\-]{20,}/g,
  tiers: /["'`](free-tier|standard-tier|legacy-tier|enterprise-tier|FREE|STANDARD|LEGACY|ENTERPRISE)[^"'`]{0,30}["'`]/g,
  quotaNames: /["'`][a-zA-Z]*(quota|Quota)[a-zA-Z]*["'`]/g,
  grpc: /["'`]google\.internal\.cloud\.code\.[a-zA-Z0-9_.]+["'`]/g,
  env: /["'`](ANTIGRAVITY|AGY|JETSKI)_[A-Z0-9_]{2,40}["'`]/g,
};

for (const [k, re] of Object.entries(grabs)) {
  const out = [...new Set([...s.matchAll(re)].map(m => m[0]))].slice(0, 60);
  console.log(`\n### ${k} (${out.length})`);
  for (const o of out) console.log('  ' + o);
}
