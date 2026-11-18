/* agy app — UI logic. No framework, no build step. */

const SESSION = document.body.dataset.session || '';
const demoMode = new URLSearchParams(location.search).get('demo');
const $ = (id) => document.getElementById(id);

/* A blank window is worse than a message: surface any UI failure. */
function crashbar(message) {
  const bar = $('crash');
  if (!bar) return;
  bar.hidden = false;
  bar.textContent = `ui error: ${message}`;
}
window.addEventListener('error', (e) => crashbar(e.message || String(e.error || e)));
window.addEventListener('unhandledrejection', (e) => crashbar(String((e.reason && e.reason.message) || e.reason)));

const state = {
  models: [],
  model: '',
  thinking: '',
  budget: 0,
  levels: [],
  busy: false,
  history: [],
  controller: null,
  email: '',
  showEmail: false,
  source: '',
};

/* ─────────────────────────── plumbing ─────────────────────────── */

async function api(path, options = {}) {
  const headers = { 'x-session': SESSION, ...(options.headers || {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* not json */ }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res;
}

/** JSON endpoints: parse for the caller. Streaming endpoints use api() raw. */
async function apiJson(path, options = {}) {
  const res = await api(path, options);
  return res.json();
}

const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);
const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
const fmtCtx = (n) => (!n ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

/** Word presets are convenience; the token budget is what ships upstream. */
const PRESETS = { minimal: 512, low: 1024, medium: 4096, high: 12288, xhigh: 32768 };

function labelForBudget(budget) {
  const n = Number(budget) || 0;
  if (n <= 0) return '';
  let label = 'minimal';
  for (const [word, value] of Object.entries(PRESETS)) if (n >= value) label = word;
  return label;
}

/* ─────────────────────────── render: rail ─────────────────────────── */

function maskEmail(email) {
  if (!email) return 'not signed in';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return local.slice(0, 2) + '\u2022'.repeat(Math.max(3, Math.min(6, local.length - 2))) + '@' + domain;
}

function renderAccount() {
  const el = $('account-email');
  if (!el) return;
  el.textContent = state.showEmail ? (state.email || 'not signed in') : maskEmail(state.email);
  el.title = state.showEmail ? 'click to hide' : 'click to show';
  el.classList.toggle('revealed', Boolean(state.showEmail));
}

async function loadState() {
  const s = await apiJson('/api/state');
  state.email = s.account.email || '';
  renderAccount();
  const tierBits = [];
  if (s.tier.current) tierBits.push(s.tier.current);
  if (s.tier.paid) tierBits.push(`paid: ${s.tier.paid}`);
  $('account-tier').textContent = tierBits.join(' · ') || 'tier unknown';

  $('b-path').textContent = s.backend.binary ? `${s.backend.binary.via} · ${s.backend.binary.mb} MB` : 'not found';
  $('b-creds').textContent = s.backend.clientSource || '—';
  $('b-alias').textContent = s.tier.project || '—';

  $('endpoint').textContent = `${s.app.host}:${s.app.port}`;
  $('api-base').textContent = `http://${s.app.host}:${s.app.port}/v1`;
  $('key-state').textContent = s.settings.apiKey ? 'key required · bearer / x-api-key' : 'key open · loopback only';

  if (!state.model) state.model = s.settings.model;
  if (!state.thinking && s.settings.thinking) state.thinking = s.settings.thinking;
  if (!state.budget && s.settings.thinking_budget) state.budget = Number(s.settings.thinking_budget) || 0;
  return s;
}

async function loadModels() {
  const data = await apiJson('/api/models?quota=1');
  state.models = data.models;
  state.source = data.source;
  $('model-source').textContent = data.source;

  const groups = new Map();
  for (const m of state.models) {
    const group = (m.groups && m.groups[0]) || m.provider;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(m);
  }

  const select = $('model-select');
  select.innerHTML = '';
  for (const [group, items] of groups) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const m of items) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const quota = m.quota === null ? '' : ` · ${(m.quota * 100).toFixed(0)}%`;
      opt.textContent = `${m.id}${quota}`;
      if (m.id === state.model) opt.selected = true;
      og.appendChild(opt);
    }
    select.appendChild(og);
  }

  if (!state.models.some((m) => m.id === state.model)) {
    state.model = state.models[0]?.id || '';
    select.value = state.model;
  }
  renderModelMeta();
  renderThinking();
}

function currentModel() {
  return state.models.find((m) => m.id === state.model) || null;
}

function renderModelMeta() {
  const m = currentModel();
  if (!m) { $('model-meta').textContent = '—'; $('pill-model').textContent = '—'; return; }
  $('model-meta').innerHTML = `<b>${m.provider}</b> · ctx ${fmtCtx(m.ctx)} · ${m.thinking ? 'thinking' : 'no thinking'}`;
  $('pill-model').textContent = m.id;
}

function renderThinking() {
  const m = currentModel();
  state.levels = (m?.levels || []).slice();
  const wrap = $('thinking-chips');
  wrap.innerHTML = '';

  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'chip auto';
  auto.textContent = 'auto';
  auto.setAttribute('aria-pressed', String(!state.budget));
  auto.onclick = () => setBudget(0, '');
  wrap.appendChild(auto);

  for (const level of state.levels) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = level;
    chip.setAttribute('aria-pressed', String(state.budget === PRESETS[level]));
    chip.title = `${PRESETS[level]} tokens`;
    chip.onclick = () => setBudget(PRESETS[level], level);
    wrap.appendChild(chip);
  }

  const input = $('thinking-budget');
  input.value = state.budget || 0;
  input.max = '32768';

  const label = labelForBudget(state.budget);
  $('thinking-note').textContent = state.budget ? `${state.budget} tok` : 'default';
  $('thinking-help').textContent = state.budget
    ? `sends thinkingConfig.thinkingBudget=${state.budget}${label ? ` (${label})` : ''}`
    : 'model default — includeThoughts only';
  $('hint').textContent = `thinking: ${state.budget ? `${state.budget} tokens` : 'model default'}`;
}

async function setBudget(budget, word) {
  state.budget = Math.max(0, Math.min(32768, Number(budget) || 0));
  state.thinking = word || labelForBudget(state.budget);
  renderThinking();
  try {
    await apiJson('/api/settings', { method: 'POST', body: JSON.stringify({ thinking: word || '', thinking_budget: state.budget }) });
  } catch { /* non-fatal */ }
}
async function setModel(id) {
  state.model = id;
  state.thinking = '';
  state.budget = 0;
  renderModelMeta();
  renderThinking();
  try { await apiJson('/api/settings', { method: 'POST', body: JSON.stringify({ model: id, thinking: '' }) }); } catch { /* non-fatal */ }
}

async function loadQuota() {
  const box = $('quota');
  try {
    const q = await apiJson('/api/quota');
    box.innerHTML = '';
    for (const group of q.groups || []) {
      const name = document.createElement('div');
      name.className = 'qgroup-name';
      name.textContent = group.displayName || '';
      box.appendChild(name);

      for (const b of group.buckets || []) {
        const fraction = Math.max(0, Math.min(1, Number(b.remainingFraction ?? 0)));
        const row = document.createElement('div');
        row.className = 'qrow';
        row.innerHTML = `
          <div class="qhead"><span>${b.bucketId}</span><span>${(fraction * 100).toFixed(1)}%</span></div>
          <div class="qbar"><div class="qfill ${fraction > 0.5 ? '' : fraction > 0.15 ? 'warn' : 'low'}" style="width:${(fraction * 100).toFixed(1)}%"></div></div>`;
        row.title = b.description || '';
        box.appendChild(row);
      }
    }
    if (!box.children.length) box.textContent = 'no buckets reported';
  } catch (e) {
    box.textContent = e.message;
  }
}

/* ─────────────────────────── markdown-lite ─────────────────────────── */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(text) {
  const blocks = [];
  let src = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre data-lang="${lang || 'text'}"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${blocks.length - 1}\u0000`;
  });

  src = escapeHtml(src);

  const lines = src.split('\n');
  const out = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\u0000BLOCK(\d+)\u0000/g, (m) => m);
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }

    const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (block) { flushPara(); flushList(); out.push(blocks[Number(block[1])]); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara(); flushList();
      const level = Math.min(3, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(inline(bullet[1]));
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushPara();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(inline(ordered[1]));
      continue;
    }

    flushList();
    para.push(inline(line));
  }
  flushPara();
  flushList();
  return out.join('');
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1<em>$2</em>');
}

/* ─────────────────────────── transcript ─────────────────────────── */

function addTurn(role, text) {
  $('empty')?.remove();
  const el = document.createElement('article');
  el.className = `turn ${role}`;
  const label = role === 'user' ? 'you' : 'agy';
  el.innerHTML = `
    <div class="turn-head"><span class="turn-role">${label}</span><span class="turn-meta"></span></div>
    <div class="turn-body"></div>
    <div class="turn-foot"></div>`;
  const body = el.querySelector('.turn-body');
  if (role === 'user') body.textContent = text;
  else body.classList.add('md');
  $('transcript').appendChild(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return { el, body, meta: el.querySelector('.turn-meta'), foot: el.querySelector('.turn-foot') };
}

function setLive(mode, label) {
  const dot = $('live').querySelector('.dot');
  dot.className = `dot ${mode}`;
  $('live-text').textContent = label;
}

/* ─────────────────────────── chat ─────────────────────────── */

const HISTORY_KEY = 'agy.history.v1';

function persistHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(-40)));
  } catch { /* private mode */ }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((m) => m && m.role && typeof m.content === 'string') : [];
  } catch {
    return [];
  }
}

async function send(promptText, opts = {}) {
  const input = $('input');
  const prompt = (promptText ?? input.value).trim();
  if (!prompt || state.busy) return;

  input.value = '';
  autosize();
  state.busy = true;
  $('send').disabled = true;
  if ($('btn-stop')) $('btn-stop').hidden = false;

  if (!opts.skipAppend) {
    addTurn('user', prompt);
    state.history.push({ role: 'user', content: prompt });
  }

  const turn = addTurn('assistant', '');
  turn.body.classList.add('cursor');
  turn.meta.textContent = new Date().toLocaleTimeString('en-GB');
  const controller = new AbortController();
  state.controller = controller;

  $('think-stream').textContent = '';
  $('think-empty').style.display = 'none';
  setLive('busy', 'thinking');
  for (const id of ['m-ttft', 'm-elapsed', 'm-tokens', 'm-think']) $(id).textContent = '—';

  const started = performance.now();
  const ticker = setInterval(() => {
    $('m-elapsed').textContent = fmtMs(Math.round(performance.now() - started));
  }, 120);

  let answer = '';
  let thinking = '';
  let ttft = null;

  const handle = (payload) => {
      if (payload.type === 'meta') {
        turn.meta.textContent = `${payload.model} · ${payload.thinking?.budget ? `${payload.thinking.budget} tok` : 'default'}`;
      } else if (payload.type === 'thought') {
        thinking += payload.text;
        const stream = $('think-stream');
        stream.textContent = thinking;
        stream.scrollTop = stream.scrollHeight;
        setLive('busy', 'reasoning');
        if (!ttft) { ttft = Math.round(performance.now() - started); $('m-ttft').textContent = fmtMs(ttft); }
      } else if (payload.type === 'text') {
        answer += payload.text;
        turn.body.innerHTML = renderMarkdown(answer);
        turn.body.classList.add('cursor');
        turn.el.scrollIntoView({ block: 'end', behavior: 'smooth' });
        if (!ttft) { ttft = Math.round(performance.now() - started); $('m-ttft').textContent = fmtMs(ttft); }
        setLive('busy', 'writing');
      } else if (payload.type === 'tool') {
        const chip = document.createElement('div');
        chip.className = 'toolcall';
        chip.innerHTML = `<b>${payload.name}</b>(${escapeHtml(JSON.stringify(payload.args))})`;
        turn.el.querySelector('.turn-body').before(chip);
      } else if (payload.type === 'done') {
        const u = payload.usage || {};
        $('m-tokens').textContent = `${fmtNum(u.prompt_tokens)} → ${fmtNum(u.completion_tokens)}`;
        $('m-think').textContent = fmtNum(u.completion_tokens_details?.reasoning_tokens ?? 0);
        $('m-elapsed').textContent = fmtMs(payload.elapsedMs);
        if (payload.ttftMs) $('m-ttft').textContent = fmtMs(payload.ttftMs);
        turn.meta.textContent = `${payload.modelVersion || state.model} · ${fmtMs(payload.elapsedMs)}`;
        const foot = [];
        if (u.total_tokens) foot.push(`${fmtNum(u.total_tokens)} tokens`);
        if (u.completion_tokens_details?.reasoning_tokens) foot.push(`${fmtNum(u.completion_tokens_details.reasoning_tokens)} thoughts`);
        turn.foot.innerHTML = `<span>${foot.join(' · ')}</span><span class="copy">copy</span>`;
        turn.foot.querySelector('.copy').onclick = async () => {
          try { await navigator.clipboard.writeText(answer); turn.foot.querySelector('.copy').textContent = 'copied'; } catch { /* clipboard blocked */ }
        };
      } else if (payload.type === 'error') {
        turn.body.innerHTML = `<p style="color:#b3462f">${escapeHtml(payload.message)}</p>`;
      }
  };

  try {
    if (Array.isArray(opts.events)) {
      // Replay of a real captured stream (headless screenshots cannot wait out
      // a thinking model; the events themselves are unmodified).
      for (const event of opts.events) handle(event);
    } else {
      const res = await api('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ model: state.model, thinking: state.thinking, thinking_budget: state.budget, messages: state.history }),
        signal: controller.signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try { handle(JSON.parse(line.slice(5).trim())); } catch { /* partial frame */ }
          }
        }
      }
    }

    if (answer) state.history.push({ role: 'assistant', content: answer });
    persistHistory();
    setLive('idle', 'idle');
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    if (aborted) {
      if (answer) {
        state.history.push({ role: 'assistant', content: answer });
        turn.foot.innerHTML = '<span>stopped</span>';
      } else {
        turn.body.innerHTML = '<p style="color:#8d8b82">stopped</p>';
      }
      persistHistory();
      setLive('idle', 'stopped');
    } else {
      turn.body.innerHTML = `<p style="color:#b3462f">${escapeHtml(e.message)}</p>`;
      setLive('idle', 'error');
    }
  } finally {
    clearInterval(ticker);
    turn.body.classList.remove('cursor');
    state.busy = false;
    state.controller = null;
    $('send').disabled = false;
    if ($('btn-stop')) $('btn-stop').hidden = true;
    input.focus();
  }
}

/* ─────────────────────────── misc ─────────────────────────── */

function autosize() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
}

function clearChat() {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* private */ }
  if (state.controller) { try { state.controller.abort(); } catch { /* done */ } }
  state.history = [];
  state.history = [];
  const transcript = $('transcript');
  transcript.innerHTML = `
    <div class="empty" id="empty">
      <div class="empty-rule"></div>
      <p class="empty-title">Nothing on the bench yet.</p>
      <p class="empty-body">Type below, or take one of these:</p>
      <div class="seeds" id="seeds">
        <button type="button" data-seed="Explain the difference between a read-write lock and a mutex in three sentences.">rwlock vs mutex</button>
        <button type="button" data-seed="Write a PowerShell one-liner that lists the ten largest files under the current directory.">powershell: big files</button>
        <button type="button" data-seed="I have a 400 MB Go binary. Explain what a Go string constant is and why scanning it for credentials can over-read into the next string.">go string constants</button>
      </div>
    </div>`;
  bindSeeds();
  $('think-stream').textContent = '';
  $('think-empty').style.display = '';
  setLive('idle', 'idle');
}

function bindSeeds() {
  for (const b of document.querySelectorAll('[data-seed]')) {
    b.onclick = () => { $('input').value = b.dataset.seed; autosize(); $('input').focus(); };
  }
}

async function runDoctor() {
  const list = $('checks');
  list.innerHTML = '<li>running…</li>';
  try {
    const res = await apiJson('/api/doctor');
    list.innerHTML = '';
    for (const c of res.checks) {
      const li = document.createElement('li');
      li.innerHTML = `<b class="${c.ok ? 'ok' : 'fail'}">${c.ok ? 'ok' : 'fail'}</b><span>${escapeHtml(c.name)}</span><span style="color:#55534c">${escapeHtml(c.detail || '')}</span>`;
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = `<li><b class="fail">fail</b><span>${escapeHtml(e.message)}</span></li>`;
  }
}

/* ─────────────────────────── boot ─────────────────────────── */

async function boot() {
  bindSeeds();
  $('send').disabled = true;

  try {
    await loadState();
    await loadModels();
    loadQuota();
  } catch (e) {
    $('account-email').textContent = (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    $('send').disabled = false;
  }

  $('account-email').addEventListener('click', () => {
    state.showEmail = !state.showEmail;
    renderAccount();
  });
  $('model-select').addEventListener('change', (e) => setModel(e.target.value));
  $('new-chat').addEventListener('click', clearChat);
  $('doctor').addEventListener('click', runDoctor);

  // API view: keys, snippets, tab switching (keys-view.js)
  try {
    bindApiView();
    showView(demoMode ? 'chat' : 'api');
  } catch (e) {
    $('keys-count').textContent = e.message;
  }

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('input').addEventListener('input', autosize);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  setInterval(() => { if (!state.busy) loadQuota(); }, 60_000);

  window.__agyReady = true;
  window.dispatchEvent(new Event('agy-ready'));
}

boot();

const demo = demoMode;
if (demo === '1') {
  setTimeout(async () => {
    try {
      const captured = await (await fetch('demo-stream.json')).json();
      const input = $('input');
      input.value = captured.question;
      autosize();
      send(captured.question, { events: captured.events });
    } catch (e) {
      $('account-email').textContent = `demo: ${e.message}`;
    }
  }, 900);
} else if (demo) {
  setTimeout(() => {
    $('input').value = demo;
    autosize();
    send();
  }, 900);
}