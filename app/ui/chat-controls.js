/* Chat controls: model/budget toolbar, stop, regenerate, refresh, restore. */

const CHAT_HISTORY_KEY = 'crackagravity.history.v1';

let toastTimer = null;

function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function fillChatModels() {
  const select = document.getElementById('chat-model');
  if (!select) return;
  const groups = new Map();
  for (const m of state.models) {
    const group = (m.groups && m.groups[0]) || m.provider;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(m);
  }
  select.innerHTML = '';
  for (const [group, items] of groups) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const m of items) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const quota = m.quota == null ? '' : ` · ${(m.quota * 100).toFixed(0)}%`;
      opt.textContent = `${m.id}${quota}`;
      og.appendChild(opt);
    }
    select.appendChild(og);
  }
  select.value = state.model;
}

function syncChatBar() {
  const select = document.getElementById('chat-model');
  const budget = document.getElementById('chat-budget');
  if (select && select.options.length === 0) fillChatModels();
  if (select) select.value = state.model;
  if (budget) budget.value = state.budget || 0;
}

async function refreshAll() {
  const button = document.getElementById('btn-refresh');
  if (button) button.disabled = true;
  try {
    await loadState();
    await loadModels();
    await loadQuota();
    if (window.loadKeys) await window.loadKeys();
    if (window.renderThinking) renderThinking();
    syncChatBar();
    toast('refreshed');
  } catch (e) {
    toast(`refresh failed: ${e.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

function stopGeneration() {
  if (!state.controller) {
    toast('nothing running');
    return;
  }
  try { state.controller.abort(); } catch { /* already done */ }
}

async function regenerate() {
  if (state.busy) {
    toast('still running — stop first');
    return;
  }
  const history = state.history;
  if (history.length === 0) {
    toast('nothing to regenerate');
    return;
  }

  // Drop a trailing assistant answer and its DOM node, then replay the last
  // user message against the current model and budget.
  if (history[history.length - 1].role === 'assistant') history.pop();
  const lastUser = [...history].reverse().find((m) => m.role === 'user' && m.content);
  if (!lastUser) {
    toast('no user message to resend');
    return;
  }

  const turns = [...document.querySelectorAll('.turn.assistant')];
  const lastAssistant = turns[turns.length - 1];
  if (lastAssistant) lastAssistant.remove();

  const userIndex = history.lastIndexOf(lastUser);
  history.length = userIndex + 1;          // drop everything after the prompt
  state.history = history;

  const input = document.getElementById('input');
  if (input) input.value = '';
  await send(lastUser.content, { skipAppend: false, regenerate: true });
  syncChatBar();
}

function clearAll() {
  clearChat();
  try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch { /* private mode */ }
  toast('cleared');
  syncChatBar();
}

function restoreHistory() {
  const saved = loadHistory();
  if (saved.length === 0) return;
  state.history = saved;
  document.getElementById('empty')?.remove();
  for (const message of saved) {
    const turn = addTurn(message.role === 'assistant' ? 'assistant' : 'user', message.content);
    if (message.role === 'assistant') {
      turn.body.innerHTML = renderMarkdown(message.content);
      turn.foot.innerHTML = `<span>restored</span><span class="copy">copy</span>`;
      turn.foot.querySelector('.copy').onclick = async () => {
        try { await navigator.clipboard.writeText(message.content); } catch { /* blocked */ }
      };
    }
  }
  const transcript = document.getElementById('transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function scrollToBottom() {
  const transcript = document.getElementById('transcript');
  if (!transcript) return;
  transcript.scrollTop = transcript.scrollHeight;
}

function initChatControls() {
  const select = document.getElementById('chat-model');
  const budget = document.getElementById('chat-budget');

  if (select) {
    select.onchange = async () => {
      await setModel(select.value);
      syncChatBar();
    };
  }

  if (budget) {
    const apply = async () => {
      const value = Math.max(0, Math.min(32768, Number(budget.value) || 0));
      await setBudget(value, labelForBudget(value));
      syncChatBar();
    };
    budget.onchange = apply;
    budget.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } };
  }

  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };

  bind('btn-stop', stopGeneration);
  bind('btn-regen', regenerate);
  bind('btn-refresh', refreshAll);
  bind('btn-clear', clearAll);
  bind('btn-bottom', scrollToBottom);

  // The rail and the toolbar drive the same state; keep them in step.
  const railModel = document.getElementById('model-select');
  if (railModel) railModel.addEventListener('change', () => setTimeout(syncChatBar, 0));
  const railBudget = document.getElementById('thinking-budget');
  if (railBudget) railBudget.addEventListener('change', () => setTimeout(syncChatBar, 0));

  restoreHistory();
  syncChatBar();

  if (new URLSearchParams(location.search).get('tab') === 'chat') showView('chat');

  window.addEventListener('agy-state', syncChatBar);
}

if (window.__agyReady) {
  initChatControls();
} else {
  window.addEventListener('agy-ready', initChatControls, { once: true });
}

window.refreshAll = refreshAll;
window.stopGeneration = stopGeneration;
