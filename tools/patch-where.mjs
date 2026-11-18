import fs from 'node:fs';

const p = 'core/cli.mjs';
let c = fs.readFileSync(p, 'utf8');

if (c.includes("flag('where')")) {
  console.log('skip: --where exists');
} else {
  const anchor = "  if (flag('doctor')) {";
  if (!c.includes(anchor)) throw new Error('anchor missing');

  const block = `  if (flag('where')) {
    // Where things came from, in the order discovery tries them — the first
    // thing to run on a machine that behaves unlike the one this was built on.
    const config = loadConfig();
    const binary = findBinary({ thorough: true });
    const creds = loadCache();
    let who = {};
    try { who = identity(); } catch { who = {}; }
    console.log('binary candidates, in order:');
    console.log(\`  AGY_BIN              \${process.env.AGY_BIN || '(unset)'}\`);
    console.log(\`  config.binary_path   \${config.binary_path || '(unset)'}\`);
    console.log(\`  known dirs           ~/.gemini/bin/agy.exe, ~/.gemini/antigravity/bin/agy.exe, LOCALAPPDATA\\\\Programs\\\\...\`);
    console.log(\`  registry             HKCU/HKLM Uninstall entries matching antigravity|gemini\`);
    console.log(\`  running process      any agy.exe / language_server process\`);
    console.log(\`  PATH                 where.exe agy.exe\`);
    console.log(\`  bounded scan         ~/.gemini, LOCALAPPDATA\\\\Programs, Program Files\`);
    console.log(\`  winner               \${binary ? binary.path + ' via ' + binary.via : '(none)'}\`);
    console.log('');
    console.log(\`keyring target         \${who.keyring_target || '(none)'}\`);
    console.log(\`account                \${who.email || '(unknown)'}\`);
    console.log(\`refresh token source   \${who.token_source || '(none)'}\`);
    console.log(\`client pair source     \${creds?.source || '(none)'}\`);
    console.log(\`state dir              \${paths.CACHE_DIR}\`);
    return;
  }

`;
  c = c.replace(anchor, block + anchor);
  fs.writeFileSync(p, c);
  console.log('ok: --where added');
}
