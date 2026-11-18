import fs from 'node:fs';

const file = process.argv[2];
const pats = process.argv.slice(3);
const s = fs.readFileSync(file, 'latin1');
for (const p of pats) {
  let i = 0;
  let n = 0;
  while ((i = s.indexOf(p, i)) !== -1 && n < 3) {
    console.log(`\n--- [${p}] @${i} ---\n` + s.slice(Math.max(0, i - 180), i + 220).replace(/[^\x20-\x7E]/g, '.'));
    i += p.length;
    n += 1;
  }
}
