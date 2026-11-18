import fs from 'node:fs';

const BT = '`';
const DOLLAR = '$';

const cliFrom = [
  '  let binary = null;',
  '  try { binary = findBinary({ thorough: true }); } catch { binary = null; }',
  '  row(\'binary\', Boolean(binary), binary ? ' + BT + '${binary.path} (${(binary.size / 1e6).toFixed(0)} MB via ${binary.via})' + BT + ' : \'no agy.exe found — built-in client pair will be tried\');',
  '',
  '  let ready = {};',
  '  try { ready = await ensureReady(); } catch (e) { row(\'resolve\', false, e.message); }',
].join('\n');

const cliTo = [
  '  let binary = null;',
  '  try { binary = findBinary({ thorough: true }); } catch { binary = null; }',
  '',
  '  let ready = {};',
  '  let resolveError = \'\';',
  '  try { ready = await ensureReady(); } catch (e) { resolveError = e.message; }',
  '',
  '  // A missing binary is only a problem when nothing can supply the OAuth pair.',
  '  const binaryOk = Boolean(binary) || Boolean(ready.client_source);',
  '  row(\'binary\', binaryOk, binary',
  '    ? ' + BT + '${binary.path} (${(binary.size / 1e6).toFixed(0)} MB via ${binary.via})' + BT,
  '    : ' + BT + 'not found — not needed, creds from ${ready.client_source || \'nothing\'}${resolveError ? \' / \' + resolveError : \'\'}' + BT + ');',
  '  if (resolveError) row(\'resolve\', false, resolveError);',
].join('\n');

let cli = fs.readFileSync('core/cli.mjs', 'utf8');
if (cli.includes(cliFrom)) {
  cli = cli.replace(cliFrom, cliTo);
  fs.writeFileSync('core/cli.mjs', cli);
  console.log('ok: cli doctor');
} else {
  console.log('SKIP: cli doctor block not found');
}

const appFrom = [
  '  let binary = null;',
  '  try { binary = findBinary(); } catch { binary = null; }',
  '  add(\'binary\', Boolean(binary), binary ? ' + BT + '${binary.path} (${(binary.size / 1e6).toFixed(0)} MB)' + BT + ' : \'agy.exe not found\');',
  '',
  '  const creds = loadCache();',
].join('\n');

const appTo = [
  '  let binary = null;',
  '  try { binary = findBinary(); } catch { binary = null; }',
  '',
  '  const creds = loadCache();',
  '  add(\'binary\', Boolean(binary) || Boolean(creds?.client_id), binary',
  '    ? ' + BT + '${binary.path} (${(binary.size / 1e6).toFixed(0)} MB)' + BT,
  '    : ' + BT + 'not found — not needed, creds from ${creds?.source || \'nothing\'}' + BT + ');',
].join('\n');

let app = fs.readFileSync('app/server.mjs', 'utf8');
if (app.includes(appFrom)) {
  app = app.replace(appFrom, appTo);
  fs.writeFileSync('app/server.mjs', app);
  console.log('ok: app doctor');
} else {
  console.log('SKIP: app doctor block not found');
}
