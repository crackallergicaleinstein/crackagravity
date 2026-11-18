import fs from 'node:fs';

const p = 'app/ui/app.js';
let c = fs.readFileSync(p, 'utf8');
const before = c.length;

function replace(from, to, label) {
  if (!c.includes(from)) {
    console.log(`SKIP (not found): ${label}`);
    return;
  }
  c = c.replace(from, to);
  console.log(`ok: ${label}`);
}

replace(
  '  busy: false,\n  history: [],',
  '  busy: false,\n  history: [],\n  controller: null,',
  'state.controller',
);

replace(
  `  input.value = '';
  autosize();
  state.busy = true;
  $('send').disabled = true;

  addTurn('user', prompt);
  state.history.push({ role: 'user', content: prompt });

  const turn = addTurn('assistant', '');
  turn.body.classList.add('cursor');
`,
  `  input.value = '';
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
`,
  'send preamble',
);

replace(
  `        body: JSON.stringify({ model: state.model, thinking: state.thinking, thinking_budget: state.budget, messages: state.history }),
      });`,
  `        body: JSON.stringify({ model: state.model, thinking: state.thinking, thinking_budget: state.budget, messages: state.history }),
        signal: controller.signal,
      });`,
  'fetch signal',
);

replace(
  `    if (answer) state.history.push({ role: 'assistant', content: answer });
    setLive('idle', 'idle');`,
  `    if (answer) state.history.push({ role: 'assistant', content: answer });
    persistHistory();
    setLive('idle', 'idle');`,
  'persist on success',
);

replace(
  `  } catch (e) {
    turn.body.innerHTML = \`<p style="color:#b3462f">\${escapeHtml(e.message)}</p>\`;
    setLive('idle', 'error');
  } finally {`,
  `  } catch (e) {
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
      turn.body.innerHTML = \`<p style="color:#b3462f">\${escapeHtml(e.message)}</p>\`;
      setLive('idle', 'error');
    }
  } finally {`,
  'abort handling',
);

replace(
  `    state.busy = false;
    $('send').disabled = false;
    input.focus();`,
  `    state.busy = false;
    state.controller = null;
    $('send').disabled = false;
    if ($('btn-stop')) $('btn-stop').hidden = true;
    input.focus();`,
  'finally reset',
);

replace(
  `/* ─────────────────────────── chat ─────────────────────────── */`,
  `/* ─────────────────────────── chat ─────────────────────────── */

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
}`,
  'history helpers',
);

fs.writeFileSync(p, c);
console.log(`done, ${before} -> ${c.length} bytes`);
