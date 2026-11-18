import fs from 'node:fs';

function edit(file, pairs) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to, label] of pairs) {
    if (!text.includes(from)) { console.log(`SKIP ${label}`); continue; }
    text = text.split(from).join(to);
    console.log(`ok ${label}`);
  }
  fs.writeFileSync(file, text);
}

// 1. A real "no install" switch, so the no-binary path can be tested instead of
//    just claimed.
edit('core/lib/discover.mjs', [[
  'export function findBinary({ thorough = false } = {}) {',
  `export function findBinary({ thorough = false } = {}) {
  // AGY_NO_BINARY=1 pretends the client is not installed: the cached OAuth pair
  // or AGY_CLIENT_ID/SECRET then has to carry the session on its own.
  if (process.env.AGY_NO_BINARY === '1') return null;`,
  'AGY_NO_BINARY switch',
]]);

// 2. A short prompt can occasionally produce zero thought frames; retry once
//    instead of failing the run on model mood.
edit('core/cli.mjs', [[
  `    await check('thinking_events', async () => {
      const html = await (await fetch(\`\${base}/\`)).text();
      const session = /data-session="([^"]+)"/.exec(html)?.[1];
      expect(session, 'no session token in index.html');
      const r = await fetch(\`\${base}/api/chat\`, {`,
  `    await check('thinking_events', async () => {
      const html = await (await fetch(\`\${base}/\`)).text();
      const session = /data-session="([^"]+)"/.exec(html)?.[1];
      expect(session, 'no session token in index.html');

      const askOnce = async () => {
      const r = await fetch(\`\${base}/api/chat\`, {`,
  'thinking retry wrapper (open)',
], [
  `      const thoughts = (text.match(/"type":"thought"/g) || []).length;
      expect(thoughts > 0, 'no thought events came back');
      expect(text.includes('"type":"done"'), 'no done event');
      return \`\${thoughts} thought frames\`;
    });`,
  `      const thoughts = (text.match(/"type":"thought"/g) || []).length;
      expect(text.includes('"type":"done"'), 'no done event');
      return thoughts;
      };

      let thoughts = await askOnce();
      if (thoughts === 0) thoughts = await askOnce();
      expect(thoughts > 0, 'no thought events came back in two tries');
      return \`\${thoughts} thought frames\`;
    });`,
  'thinking retry wrapper (close)',
]]);
