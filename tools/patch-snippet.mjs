import fs from 'node:fs';

const p = 'app/ui/keys-view.js';
let k = fs.readFileSync(p, 'utf8');

function rep(from, to, label) {
  if (!k.includes(from)) { console.log(`SKIP: ${label}`); return; }
  k = k.replace(from, to);
  console.log(`ok: ${label}`);
}

rep(
  `const API = {
  keys: [],
  activeKey: '',
  snippet: 'curl',
  file: '',
};`,
  `const API = {
  keys: [],
  activeKey: '',
  revealSnippet: false,
  snippet: 'curl',
  file: '',
};

/** Keys are masked in snippets until the user asks for them. */
function snippetKey() {
  if (!API.activeKey) return '<copy a key first>';
  if (API.revealSnippet) return API.activeKey;
  return \`\${API.activeKey.slice(0, 8)}…\${API.activeKey.slice(-4)}\`;
}`,
  'API state + snippetKey',
);

rep(`  const key = API.activeKey || '<press copy on a key>';`, `  const key = snippetKey();`, 'snippet uses masked key');

rep(
  `      const revealed = await apiJson(\`/api/keys/\${id}/reveal\`, { method: 'POST' });
      API.activeKey = revealed.key;
      await copyText(revealed.key);`,
  `      const revealed = await apiJson(\`/api/keys/\${id}/reveal\`, { method: 'POST' });
      API.activeKey = revealed.key;
      API.revealSnippet = true;
      await copyText(revealed.key);`,
  'copy reveals',
);

rep(
  `    API.activeKey = payload.key.key;
    input.value = '';
    renderKeys(payload);
    renderSnippet();
    await copyText(payload.key.key);`,
  `    API.activeKey = payload.key.key;
    API.revealSnippet = true;
    input.value = '';
    renderKeys(payload);
    renderSnippet();
    await copyText(payload.key.key);`,
  'create reveals',
);

rep(
  `      API.activeKey = payload.key.key;
      renderKeys(payload);
      renderSnippet();
      return;`,
  `      API.activeKey = payload.key.key;
      API.revealSnippet = false;
      renderKeys(payload);
      renderSnippet();
      return;`,
  'rotate hides again',
);

rep(
  `  $('key-create').onclick = createKey;`,
  `  const reveal = $('snippet-reveal');
  if (reveal) {
    reveal.onclick = () => {
      API.revealSnippet = !API.revealSnippet;
      reveal.textContent = API.revealSnippet ? 'hide key' : 'show key';
      renderSnippet();
    };
  }

  $('key-create').onclick = createKey;`,
  'reveal button',
);

fs.writeFileSync(p, k);
console.log('saved keys-view');

const h = 'app/ui/index.html';
let html = fs.readFileSync(h, 'utf8');
if (!html.includes('id="snippet-reveal"')) {
  html = html.replace(
    `<div class="tabs small" id="snippet-tabs">`,
    `<button class="btn ghost small" id="snippet-reveal" type="button">show key</button>
          <div class="tabs small" id="snippet-tabs">`,
  );
  fs.writeFileSync(h, html);
  console.log('ok: reveal button');
} else {
  console.log('skip: reveal button exists');
}
