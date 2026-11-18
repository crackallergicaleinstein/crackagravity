import fs from 'node:fs';

const htmlPath = 'app/ui/index.html';
let s = fs.readFileSync(htmlPath, 'utf8');

const start = s.indexOf('<main class="stage">');
const end = s.indexOf('</main>') + '</main>'.length;
if (start < 0 || end < '</main>'.length) throw new Error('stage markers missing');

const viewApi = `
  <section class="view" id="view-api">
    <div class="view-scroll">
      <div class="card">
        <div class="card-head">
          <div class="label">base url</div>
          <div class="micro">openai + claude shapes</div>
        </div>
        <div class="endpoint-line">
          <code id="api-url">http://127.0.0.1:8790/v1</code>
          <button class="btn ghost small" id="copy-url" type="button">copy</button>
        </div>
        <p class="micro">The key gates this app. The Google OAuth pair that reaches the backend stays in the credential store — never here.</p>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="label">keys</div>
          <div class="micro" id="keys-count">—</div>
        </div>
        <div class="key-new">
          <input id="key-name" class="text-input" placeholder="name — e.g. cline, laptop, ci" maxlength="40" />
          <button class="btn" id="key-create" type="button">create key</button>
        </div>
        <table class="keys" id="keys-table">
          <thead>
            <tr><th>name</th><th>key</th><th>created</th><th>last used</th><th>req</th><th>actions</th></tr>
          </thead>
          <tbody></tbody>
        </table>
        <p class="micro" id="keys-file">—</p>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="label">quickstart</div>
          <div class="tabs small" id="snippet-tabs">
            <button class="tab active" data-snippet="curl" type="button">curl</button>
            <button class="tab" data-snippet="python" type="button">python</button>
            <button class="tab" data-snippet="node" type="button">node</button>
          </div>
        </div>
        <pre class="snippet" id="snippet"></pre>
        <p class="micro">Copy on a key fills it into these snippets.</p>
      </div>
    </div>
  </section>

  <section class="view" id="view-chat" hidden>
    <div class="transcript" id="transcript">
      <div class="empty" id="empty">
        <div class="empty-rule"></div>
        <p class="empty-title">Nothing on the bench yet.</p>
        <p class="empty-body">Type below, or take one of these:</p>
        <div class="seeds" id="seeds">
          <button type="button" data-seed="Explain the difference between a read-write lock and a mutex in three sentences.">rwlock vs mutex</button>
          <button type="button" data-seed="Write a PowerShell one-liner that lists the ten largest files under the current directory.">powershell: big files</button>
          <button type="button" data-seed="I have a 400 MB Go binary. Explain what a Go string constant is and why scanning it for credentials can over-read into the next string.">go string constants</button>
        </div>
      </div>
    </div>

    <form class="composer" id="composer">
      <textarea id="input" rows="1" placeholder="Ask anything. Enter sends, Shift+Enter breaks the line."></textarea>
      <div class="composer-actions">
        <span class="hint" id="hint">thinking: model default</span>
        <button class="btn send" id="send" type="submit">send</button>
      </div>
    </form>
  </section>
`;

const head = `
  <header class="stage-head">
    <div class="head-left">
      <div class="tabs" role="tablist" aria-label="view">
        <button class="tab active" data-view="api" role="tab" aria-selected="true">api</button>
        <button class="tab" data-view="chat" role="tab" aria-selected="false">chat</button>
      </div>
      <h1 id="stage-title">api</h1>
      <p class="lede" id="stage-lede">Keys for this app, then point any client at the endpoint. Chat is the same engine with a window around it.</p>
    </div>
    <div class="head-right">
      <div class="pill" id="pill-model">—</div>
      <button class="btn ghost" id="new-chat" type="button" hidden>clear</button>
    </div>
  </header>
`;

const stage = `<main class="stage">${head}${viewApi}</main>`;
s = s.slice(0, start) + stage + s.slice(end);
s = s.replace('app.js?v=8', 'app.js?v=9').replace('styles.css?v=6', 'styles.css?v=9');
fs.writeFileSync(htmlPath, s);
console.log('stage rewritten, view-api:', s.includes('view-api'), 'view-chat:', s.includes('view-chat'));
