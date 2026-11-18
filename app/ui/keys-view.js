/* API view: keys, snippets, view switching. Plain DOM, no framework. */

const API = {
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
  return `${API.activeKey.slice(0, 8)}…${API.activeKey.slice(-4)}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

function apiBase() {
  return $('api-url')?.textContent || 'http://127.0.0.1:8790/v1';
}

function renderSnippet() {
  const base = apiBase();
  const key = snippetKey();
  const model = state.model || 'gemini-3.8-flash-low';

  const bodies = {
    curl: `curl ${base}/chat/completions \\
  -H "content-type: application/json" \\
  -H "Authorization: Bearer ${key}" \\
  -d '{
    "model": "${model}",
    "thinking_budget": 8192,
    "messages": [{"role": "user", "content": "hi"}]
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${key}",
)

r = client.chat.completions.create(
    model="${model}",
    thinking_budget=8192,          # token budget: 512 … 32768, 0 = off
    messages=[{"role": "user", "content": "hi"}],
)
print(r.choices[0].message.content)`,
    node: `import OpenAI from './app/sdk/openai.mjs';

const client = new OpenAI({ baseURL: '${base}', apiKey: '${key}' });

const r = await client.chat.completions.create({
  model: '${model}',
  thinking_budget: 8192,
  messages: [{ role: 'user', content: 'hi' }],
});
console.log(r.choices[0].message.content);`,
  };

  $('snippet').textContent = bodies[API.snippet] || bodies.curl;
}

function renderKeys(payload) {
  const tbody = $('keys-table').querySelector('tbody');
  tbody.innerHTML = '';

  const list = payload?.keys || API.keys;
  API.keys = list;
  if (payload?.file) API.file = payload.file;

  $('keys-count').textContent = `${list.length} key${list.length === 1 ? '' : 's'}${payload?.legacy ? ' + legacy env/config key' : ''}`;
  $('keys-file').textContent = API.file ? `stored in ${API.file}` : '';

  if (list.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" style="color:#55534c">no keys yet — create one above</td>';
    tbody.appendChild(tr);
    return;
  }

  for (const key of list) {
    const tr = document.createElement('tr');
    if (key.enabled === false) tr.className = 'disabled';
    tr.innerHTML = `
      <td class="name">${escapeHtml(key.name || 'key')}</td>
      <td>${escapeHtml(key.masked)}</td>
      <td>${fmtDate(key.created_at)}</td>
      <td>${key.last_used_at ? fmtDate(key.last_used_at) : 'never'}</td>
      <td>${key.requests ?? 0}</td>
      <td class="actions">
        <button class="key-act" data-act="copy" data-id="${key.id}">copy</button>
        <button class="key-act" data-act="rotate" data-id="${key.id}">rotate</button>
        <button class="key-act" data-act="${key.enabled === false ? 'enable' : 'disable'}" data-id="${key.id}">${key.enabled === false ? 'enable' : 'disable'}</button>
        <button class="key-act danger" data-act="revoke" data-id="${key.id}">revoke</button>
      </td>`;
    tbody.appendChild(tr);
  }

  for (const button of tbody.querySelectorAll('.key-act')) {
    button.onclick = () => keyAction(button.dataset.act, button.dataset.id);
  }
}

async function loadKeys() {
  try {
    const payload = await apiJson('/api/keys');
    renderKeys(payload);
    if (!API.activeKey && payload.keys.length > 0) {
      const revealed = await apiJson(`/api/keys/${payload.keys[0].id}/reveal`, { method: 'POST' });
      API.activeKey = revealed.key;
    }
    renderSnippet();
  } catch (e) {
    $('keys-count').textContent = e.message;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

async function keyAction(action, id) {
  try {
    if (action === 'copy') {
      const revealed = await apiJson(`/api/keys/${id}/reveal`, { method: 'POST' });
      API.activeKey = revealed.key;
      API.revealSnippet = true;
      await copyText(revealed.key);
      renderSnippet();
      return;
    }
    if (action === 'rotate') {
      const payload = await apiJson(`/api/keys/${id}/rotate`, { method: 'POST' });
      API.activeKey = payload.key.key;
      API.revealSnippet = false;
      renderKeys(payload);
      renderSnippet();
      return;
    }
    if (action === 'revoke') {
      await apiJson(`/api/keys/${id}`, { method: 'DELETE' });
      await loadKeys();
      return;
    }
    if (action === 'disable' || action === 'enable') {
      await apiJson(`/api/keys/${id}/enable`, { method: 'POST', body: JSON.stringify({ enabled: action === 'enable' }) });
      await loadKeys();
    }
  } catch (e) {
    $('keys-count').textContent = e.message;
  }
}

async function createKey() {
  const input = $('key-name');
  const name = (input.value || '').trim() || 'key';
  const button = $('key-create');
  button.disabled = true;
  try {
    const payload = await apiJson('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    API.activeKey = payload.key.key;
    API.revealSnippet = true;
    input.value = '';
    renderKeys(payload);
    renderSnippet();
    await copyText(payload.key.key);
  } catch (e) {
    $('keys-count').textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

function showView(name) {
  const isApi = name === 'api';
  $('view-api').hidden = !isApi;
  $('view-chat').hidden = isApi;
  $('new-chat').hidden = isApi;
  $('stage-title').textContent = isApi ? 'api' : 'chat';
  $('stage-lede').textContent = isApi
    ? 'Keys for this app, then point any client at the endpoint. Chat is the same engine with a window around it.'
    : 'Direct line to the account’s own Gemini, Claude and GPT quota. No harness prompt, no spawn.';
  for (const tab of document.querySelectorAll('.tabs [data-view]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  }
  if (!isApi) setTimeout(() => $('input')?.focus(), 0);
}

function bindApiView() {
  for (const tab of document.querySelectorAll('.tabs [data-view]')) {
    tab.onclick = () => showView(tab.dataset.view === 'chat' ? 'chat' : 'api');
  }
  for (const tab of document.querySelectorAll('[data-snippet]')) {
    tab.onclick = () => {
      API.snippet = tab.dataset.snippet;
      for (const other of document.querySelectorAll('[data-snippet]')) {
        other.classList.toggle('active', other === tab);
      }
      renderSnippet();
    };
  }

  const reveal = $('snippet-reveal');
  if (reveal) {
    reveal.onclick = () => {
      API.revealSnippet = !API.revealSnippet;
      reveal.textContent = API.revealSnippet ? 'hide key' : 'show key';
      renderSnippet();
    };
  }

  $('key-create').onclick = createKey;
  $('key-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createKey(); }
  });
  $('copy-url').onclick = async () => {
    const ok = await copyText(apiBase());
    $('copy-url').textContent = ok ? 'copied' : 'failed';
    setTimeout(() => { $('copy-url').textContent = 'copy'; }, 1200);
  };

  loadKeys();
}
