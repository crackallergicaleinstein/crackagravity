import fs from 'node:fs';

// 1) README: lead with the money argument, keep the token measurement as evidence.
let r = fs.readFileSync('README.md', 'utf8');
const marker = '## Read this before you touch anything, idiot';
const money = `## The actual point: you're paying twice

Nobody's problem here is "tokens are interesting". The problem is the invoice.

Claude Opus, Sonnet, Gemini Pro through an API cost real money per million
tokens. Meanwhile the Antigravity subscription already sitting on your machine
covers those same models — $20/mo tier, free tier, or Ultra — and you're supposed
to use it through one specific IDE window like a fucking peasant. Want it from
Cline, aider, your own script? Buy API credits, or upgrade the "big plan".

This repo says no. Same models, same endpoint, **your already-paid quota**,
exposed as a normal OpenAI + Claude compatible API on localhost. If you already
pay for the subscription, the marginal cost of a request is **zero**.

The 21,830-token number below is the *reason it felt broken*: the stock client
poured your quota into its own scaffolding, so even "free" ran out after a
handful of questions. Strip that and the same money covers a hundred times more
work.

`;
if (!r.includes('## The actual point: you')) {
  r = r.replace(marker, money + marker);
  fs.writeFileSync('README.md', r);
  console.log('ok: README cost section');
} else {
  console.log('skip: README already has it');
}

// 2) Social card: same repositioning, one glance.
let html = fs.readFileSync('launch/card.html', 'utf8');
html = html.replace(
  '<h1><span class="num">21,830</span> tokens of scaffolding,<br>deleted. <span class="small">6–38 left.</span></h1>',
  '<h1>You pay per token.<br>Your subscription <span class="num">already</span> covers it.</h1>',
);
html = html.replace(
  `<p class="lede">The stock client sends a 65,891-character system prompt, 14 tool declarations and a
    per-tool-call rater with every request. Same endpoint, same models, same quota — one fetch, no spawn.</p>`,
  `<p class="lede">Same models, same endpoint, the quota you already pay for — exposed as a local
    OpenAI / Claude API. The stock client was burning it on 21,830 tokens of its own scaffolding per
    turn; strip that and one request costs 6–38.</p>`,
);
fs.writeFileSync('launch/card.html', html);
console.log('ok: card repositioned');
