/**
 * Local `openai`-shaped client for machines where the real SDK is not installed.
 *
 *   import OpenAI from './sdk/openai.mjs';
 *   const client = new OpenAI({ baseURL: 'http://127.0.0.1:8790/v1', apiKey: 'agy_…' });
 *   const r = await client.chat.completions.create({ model: 'gemini-3.8-flash-low', messages: [...] });
 *
 * Surface mirrored: chat.completions.create (stream + non-stream), completions.create,
 * models.list, models.retrieve, plus `reasoning_content` / `reasoning_effort`
 * passthrough for thinking control and OpenAI tool calling.
 */

class APIError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.name = 'APIError';
    this.status = status;
    this.error = body?.error ?? body;
  }
}

export class OpenAI {
  constructor({ baseURL = 'http://127.0.0.1:8790/v1', apiKey = '', organization = null, timeout = 300_000, maxRetries = 1, defaultHeaders = {} } = {}) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.organization = organization;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.defaultHeaders = defaultHeaders;
    this.chat = { completions: { create: (params, options) => this.#create('/chat/completions', params, options) } };
    this.completions = { create: (params, options) => this.#create('/completions', params, options) };
    this.models = {
      list: async () => (await this.#request('GET', '/models')).json(),
      retrieve: async (id) => (await this.#request('GET', `/models/${encodeURIComponent(id)}`)).json(),
    };
  }

  headers(extra = {}) {
    const h = {
      'content-type': 'application/json',
      ...this.defaultHeaders,
      ...extra,
    };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    if (this.organization) h['openai-organization'] = this.organization;
    return h;
  }

  async #request(method, path, body, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeout);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let attempt = 0;
      while (true) {
        const res = await fetch(`${this.baseURL}${path}`, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
            attempt += 1;
            await new Promise((r) => setTimeout(r, 400 * attempt));
            continue;
          }
          let parsed = null;
          try { parsed = await res.json(); } catch { parsed = null; }
          throw new APIError(res.status, parsed);
        }
        return res;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #create(path, params, options = {}) {
    if (!params || !Array.isArray(params.messages) && path.endsWith('completions') && !Array.isArray(params.messages) && params.prompt === undefined) {
      throw new Error('create() needs messages or prompt');
    }
    if (params.stream) return this.#stream(path, params, options);
    const res = await this.#request('POST', path, params, options);
    return res.json();
  }

  async *#stream(path, params, options) {
    const res = await this.#request('POST', path, { ...params, stream: true }, options);
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
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try { yield JSON.parse(payload); } catch { /* partial */ }
        }
      }
    }
  }
}

export { APIError };
export default OpenAI;
