import fs from 'node:fs';

const edits = [
  // window title + brand
  ['app/ui/index.html', [
    ['<title>agy — antigravity workspace</title>', '<title>crackagravity — antigravity limits, for other work</title>'],
    ['<div class="wordmark">agy</div>', '<div class="wordmark">crackagravity</div>'],
    ['<div class="wordmark-sub">antigravity workspace</div>', '<div class="wordmark-sub">antigravity limits · for other work</div>'],
  ]],
  // chat role label + storage key
  ['app/ui/app.js', [
    ["const label = role === 'user' ? 'you' : 'agy';", "const label = role === 'user' ? 'you' : 'cracka';"],
    ["const HISTORY_KEY = 'agy.history.v1';", "const HISTORY_KEY = 'crackagravity.history.v1';"],
  ]],
  ['app/ui/chat-controls.js', [
    ["const CHAT_HISTORY_KEY = 'agy.history.v1';", "const CHAT_HISTORY_KEY = 'crackagravity.history.v1';"],
  ]],
  // server banner
  ['app/server.mjs', [
    ['console.log(`agy-app  http://${HOST}:${PORT}/`);', 'console.log(`crackagravity  http://${HOST}:${PORT}/`);'],
    ["app: 'agy-app',", "app: 'crackagravity',"],
  ]],
];

for (const [file, pairs] of edits) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.log(`SKIP ${file}: ${from.slice(0, 40)}`);
      continue;
    }
    text = text.split(from).join(to);
    console.log(`ok ${file}: ${to.slice(0, 46)}`);
  }
  fs.writeFileSync(file, text);
}
