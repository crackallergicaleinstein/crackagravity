import fs from 'node:fs';

const p = 'app/ui/app.js';
let a = fs.readFileSync(p, 'utf8');

function rep(from, to, label) {
  if (!a.includes(from)) {
    console.log(`SKIP: ${label}`);
    return;
  }
  a = a.replace(from, to);
  console.log(`ok: ${label}`);
}

rep(
  `  busy: false,
  history: [],
  controller: null,`,
  `  busy: false,
  history: [],
  controller: null,
  email: '',
  showEmail: false,`,
  'state.email',
);

rep(
  `async function loadState() {`,
  `function maskEmail(email) {
  if (!email) return 'not signed in';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return local.slice(0, 2) + '\\u2022'.repeat(Math.max(3, Math.min(6, local.length - 2))) + '@' + domain;
}

function renderAccount() {
  const el = $('account-email');
  if (!el) return;
  el.textContent = state.showEmail ? (state.email || 'not signed in') : maskEmail(state.email);
  el.title = state.showEmail ? 'click to hide' : 'click to show';
  el.classList.toggle('revealed', Boolean(state.showEmail));
}

async function loadState() {`,
  'mask helpers',
);

rep(
  `  $('account-email').textContent = s.account.email || 'not signed in';`,
  `  state.email = s.account.email || '';
  renderAccount();`,
  'renderAccount in loadState',
);

rep(
  `  $('model-select').addEventListener('change', (e) => setModel(e.target.value));`,
  `  $('account-email').addEventListener('click', () => {
    state.showEmail = !state.showEmail;
    renderAccount();
  });
  $('model-select').addEventListener('change', (e) => setModel(e.target.value));`,
  'email toggle',
);

fs.writeFileSync(p, a);
console.log('saved');
