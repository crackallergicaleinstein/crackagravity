import fs from 'node:fs';

const p = 'README.md';
let r = fs.readFileSync(p, 'utf8');

if (r.includes('## Any PC, any folder, any install path')) {
  console.log('skip: section exists');
  process.exit(0);
}

const anchor = '## Plug it into whatever you\'re running';
const section = `## Any PC, any folder, any install path

"Does it work on another machine?" is a fair question and most repos answer it
with vibes. Here is what was actually run, on this box, on purpose:

| scenario | how it was tested | result |
|---|---|---|
| repo in a different folder | copied the whole tree to \`C:\\Users\\usr\\crackagravity-located-elsewhere\` and ran it from there | \`--doctor\` all OK, **14/14 selftest** |
| run from a different working directory | \`cd C:\\\` then absolute path to the CLI | works, resolves its own paths |
| Antigravity in a nonstandard place, with spaces | copied \`agy.exe\` to \`C:\\Users\\usr\\weird install location\\Antigravity Stuff\\bin\\\`, set \`AGY_BIN\` | found \`via env\`, real answer \`elsewhere-ok\` |
| client not installed at all | \`AGY_NO_BINARY=1\` + cached pair | **14/14 selftest** — binary is not needed once the pair is cached |
| keyring entry renamed | pointed the cache at \`bogus:gone\` | full credential scan adopted \`gemini:antigravity\` again |
| no keyring entry | \`AGY_REFRESH_TOKEN\` seed | supported, tested in isolation |
| binary discovery | known path and running-process branches hit; registry / \`PATH\` / bounded scan are the same code path | \`--where\` prints exactly which branch won |

Run this on a machine that misbehaves before you file a bug:

\`\`\`powershell
node core\\cli.mjs --where
\`\`\`

It prints every candidate in order, the winner, the keyring target, the token
source, the client-pair source and the state directory. No guesswork, no
"works on my machine".

**What "any PC" does not mean.** Three honest limits:

- **Windows.** The credential store is wincred and the discovery shell is
  PowerShell. On Linux/macOS the core client runs fine, but you supply the token:
  \`AGY_REFRESH_TOKEN=...\`, then \`node core/cli.mjs\`.
- **Node 20+.** No bundled runtime, no 8 MB mystery binary. Install Node or get
  nothing.
- **A Google account that signed into Antigravity once** — the quota belongs to
  that account, not to the machine.

Everything else is discovered at runtime, and re-discovered when a vendor update
moves it. That is the whole point.

`;
r = r.replace(anchor, section + anchor);
fs.writeFileSync(p, r);
console.log('ok: portability section added');
