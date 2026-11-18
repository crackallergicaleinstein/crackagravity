import fs from 'node:fs';

let r = fs.readFileSync('README.md', 'utf8');

const oldLine = `Claude Opus, Sonnet, Gemini Pro through an API cost real money per million
tokens. Meanwhile the Antigravity subscription already sitting on your machine
covers those same models — $20/mo tier, free tier, or Ultra — and you're supposed
to use it through one specific IDE window like a fucking peasant. Want it from
Cline, aider, your own script? Buy API credits, or upgrade the "big plan".`;

const newLine = `Claude Opus, Sonnet, Gemini Pro through an API cost real money per million
tokens. Meanwhile the Antigravity subscription already sitting on your machine
covers those same models — and depending on region, student plans and whatever
promo is running, that subscription is **free, a couple of bucks, or bundled with
a carrier**. Want to use it from Cline, aider or your own script? Buy API credits,
or upgrade the "big plan". Like a fucking peasant.

And the part nobody says out loud: the quota is **per account, per month**. Fresh
signup, fresh promo, all the modern models again for another thirty days. Whether
that is against Google's terms is between you and Google; accounts get flagged,
that's the cost of doing business. The repo doesn't do account rotation for you —
it just stops wasting the quota you got.`;

if (!r.includes(oldLine)) {
  console.log('SKIP: README cost paragraph not found');
} else {
  r = r.replace(oldLine, newLine);
  fs.writeFileSync('README.md', r);
  console.log('ok: README monthly-quota angle');
}

// Card lede: same idea in one line.
let html = fs.readFileSync('launch/card.html', 'utf8');
const oldLede = `Same models, same endpoint, the quota you already pay for — exposed as a local
    OpenAI / Claude API. The stock client was burning it on 21,830 tokens of its own scaffolding per
    turn; strip that and one request costs 6–38.`;
const newLede = `Same models, same endpoint, the quota you already pay for — free tier, a couple
    of bucks, or a promo account. Exposed as a local OpenAI / Claude API. The IDE was burning that
    quota on 21,830 tokens of scaffolding per turn; strip it and one request costs 6–38.`;
if (html.includes(oldLede)) {
  html = html.replace(oldLede, newLede);
  fs.writeFileSync('launch/card.html', html);
  console.log('ok: card lede');
} else {
  console.log('SKIP: card lede');
}
