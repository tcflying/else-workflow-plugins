// test/lib/w2-client-harness.mjs — 1004.md §4 W2 (F18/F19/F05) client harness.
//
// A minimal DOM + fetch double, just enough to boot the two real client bundles
// (mmx-workflow-pipeline/client-inject.js and dsh-workflow-pipeline/client.js) inside
// node:vm and drive their card controls.
//
// What makes this different from a plain happy-path fetch stub:
//   * a response can be a TRUNCATED body, a NON-JSON body, a 200 with a missing field,
//     a non-2xx, a socket drop (request received, response lost) or a body that never
//     settles and only settles when the request's AbortSignal aborts (a real browser's
//     `fetch(url,{signal})` + `res.json()` behaviour);
//   * every POST is counted at the RECEIVER, which is what F19's postsReceived === 1 is
//     actually about: not "the second click was ignored" but "a second request could not
//     even be emitted".
//
// No third-party dependency, no host, no production port, no fixed Temp name.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SIDES = {
  mmx: { name: 'MMX', prefix: 'mmxdwf', path: join(HERE, '..', '..', 'client-inject.js') },
  dsh: { name: 'DSH', prefix: 'dwf', path: join(HERE, '..', '..', '..', 'dsh-workflow-pipeline', 'client.js') },
};

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.attributes = {};
    this.style = {}; this.listeners = {}; this.value = ''; this.clientHeight = 600;
    this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none';
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (c) => { if (!this.classList.contains(c)) this.className = (this.className + ' ' + c).trim(); },
      remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle: (c) => { const on = !this.classList.contains(c); this.classList[on ? 'add' : 'remove'](c); return on; },
    };
  }
  set id(v) { this.setAttribute('id', v); } get id() { return this.getAttribute('id') || ''; }
  set className(v) { this.setAttribute('class', v); } get className() { return this.getAttribute('class') || ''; }
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.children[0] || null; }
  get previousElementSibling() { const a = this.parentNode?.children || []; return a[a.indexOf(this) - 1] || null; }
  get isConnected() { return this === this.doc.documentElement || !!this.parentNode?.isConnected; }
  get childElementCount() { return this.children.length; }
  get textContent() { return (this._text || '') + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => c.remove()); this._text = String(v ?? ''); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get disabled() { return this.getAttribute('disabled') !== null; }
  set placeholder(v) { this.setAttribute('placeholder', v); }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  get innerHTML() {
    const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return escape(this._text || '') + this.children.map((c) => {
      const attrs = Object.entries(c.attributes).map(([k, v]) => ` ${k}="${escape(v)}"`).join('');
      const tag = c.tagName.toLowerCase();
      return `<${tag}${attrs}>` + (['input', 'br', 'hr'].includes(tag) ? '' : c.innerHTML + `</${tag}>`);
    }).join('');
  }
  set innerHTML(html) {
    this.children.slice().forEach((c) => c.remove()); this._html = html; this._text = '';
    const stack = [this];
    for (const m of String(html).matchAll(/<\/(\w+)>|<(\w+)([^>]*)>|([^<]+)/g)) {
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      if (m[2]) {
        const el = new Element(m[2], this.doc);
        for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] || ''));
        el.value = el.getAttribute('value') || '';
        stack.at(-1).appendChild(el);
        if (!['input', 'br', 'hr'].includes(m[2]) && !m[3].endsWith('/')) stack.push(el);
      } else if (m[4]) stack.at(-1)._text = (stack.at(-1)._text || '') + decode(m[4]);
    }
  }
  insertAdjacentHTML(where, html) { const tmp = this.doc.createElement('div'); tmp.innerHTML = html; tmp.children.slice().forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  cloneNode(deep) {
    const el = new Element(this.tagName, this.doc);
    for (const [k, v] of Object.entries(this.attributes)) el.attributes[k] = v;
    el._text = this._text || '';
    if (deep !== false) this.children.forEach((c) => el.appendChild(c.cloneNode(true)));
    return el;
  }
  removeAttribute(k) { delete this.attributes[k]; }
  appendChild(el) { el.remove(); el.parentNode = this; this.children.push(el); return el; }
  insertBefore(el, before) { el.remove(); el.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, el); return el; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; } }
  matches(sel) {
    return sel.split(',').some((s) => {
      s = s.trim();
      if (s === '*') return true;
      const id = s.match(/^#([\w-]+)/); if (id && this.id !== id[1]) return false;
      const tag = s.match(/^[a-z]+/i); if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      for (const c of s.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(c[1])) return false;
      for (const a of s.matchAll(/\[([\w-]+)(\*=|=)?["']?([^\]"']*)["']?\]/g)) {
        const v = this.getAttribute(a[1]);
        if (v === null || (a[2] === '=' && v !== a[3]) || (a[2] === '*=' && !v.includes(a[3]))) return false;
      }
      return true;
    });
  }
  querySelectorAll(sel) { return this.children.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { return this.matches(sel) ? this : this.parentNode?.closest(sel) || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, extras = {}) { const ev = { target: this, ...extras }; for (let e = this; e; e = e.parentNode) for (const fn of e.listeners[type] || []) fn(ev); }
  focus() { this.doc.activeElement = this; }
  click() { this.dispatch('click'); }
  get nextSibling() { const a = this.parentNode?.children || []; return a[a.indexOf(this) + 1] || null; }
  setSelectionRange(a, b, d = 'none') { this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = d; }
}

// --- response shapes ------------------------------------------------------------
// Every spec is turned into a Response-like object. `json()` behaves like the browser's:
// invalid JSON rejects with a SyntaxError, and a body that never settles only settles when
// the request's AbortSignal aborts.
export function respond(spec) {
  const status = spec.status == null ? 200 : spec.status;
  const ok = status >= 200 && status < 300;
  if (spec.hang) {
    return new Promise(() => {}); // headers never arrive
  }
  const res = {
    ok, status,
    headers: { get: () => 'application/json' },
    json: () => {
      if (spec.hangBody) {
        return new Promise((resolve, reject) => {
          const sig = spec.signal;
          if (!sig) return; // no signal: never settles, exactly like a stuck socket
          if (sig.aborted) return reject(abortError());
          sig.addEventListener('abort', () => reject(abortError()));
        });
      }
      if (spec.truncated !== undefined) return Promise.reject(new SyntaxError('Unexpected end of JSON input'));
      if (spec.text !== undefined) return Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0'));
      return Promise.resolve(structuredClone(spec.body));
    },
    text: async () => (spec.text !== undefined ? spec.text : JSON.stringify(spec.body ?? {})),
  };
  return Promise.resolve(res);
}
function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}
export function socketDrop() { const e = new Error('network error: socket closed before response'); e.name = 'TypeError'; return Promise.reject(e); }

// The three malformed-200 shapes F18 names, plus the two controls the document requires.
export const SHAPES = {
  truncated: { status: 200, truncated: '{"ok":true,"acce' },
  nonJson: { status: 200, text: '<html>502 Bad Gateway</html>' },
  missingField: { status: 200, body: { accepted: true, spawned: true } },   // no ok:true
  explicitFalse: { status: 200, body: { ok: false, error: 'run is not accepting answers' } },
  truncated502: { status: 502, truncated: '<html>502 Bad' },
  okTrue: { status: 200, body: { ok: true } },
  accepted: { status: 200, body: { ok: true, spawned: true, accepted: true, status: 'running' } },
  unconfirmed504: { status: 504, body: { ok: false, code: 'RESUME_UNCONFIRMED', error: '恢复进程已启动，但 8 秒内未确认新生命周期' } },
  drop: 'socket-drop',
};

/**
 * Boot one client bundle.
 *
 * `server` describes what the OTHER end does:
 *   { runs: () => [...] | spec, post: (url) => spec | 'socket-drop', onPost: (url) => void }
 * `postsReceived` counts POSTs at the receiver — incremented for every POST the client
 * actually emits, before any response (or lack of one) is produced.
 */
export async function boot(side, { runs = [], server = {}, storage, now, options = {} } = {}) {
  const meta = SIDES[side];
  const source = readFileSync(meta.path, 'utf8');
  const doc = { readyState: 'complete', activeElement: null, visibilityState: 'visible' };
  const docListeners = {}, winListeners = {};
  doc.createElement = (tag) => new Element(tag, doc);
  doc.documentElement = doc.createElement('html'); doc.head = doc.createElement('head');
  doc.documentElement.appendChild(doc.head);
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.documentElement.querySelector('#' + id);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.addEventListener = (type, fn) => { (docListeners[type] ||= []).push(fn); };
  doc.removeEventListener = (type, fn) => { docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn); };
  const area = doc.createElement('div'); area.className = 'viewArea'; area.setAttribute('data-testid', 'message-list');
  doc.body.appendChild(area);

  const intervals = [], timers = [], requestLog = [];
  const store = storage || new Map();
  // A terminal run (failed / cancelled / stale) is only in the card pool if the user was
  // already watching it — the resume/stop tests drive exactly those runs, so seed the same
  // visible-runs record the client itself would have written while the run was on screen.
  if (options.watched !== false) {
    const key = meta.prefix === 'dwf' ? 'dwf-pipeline-visible-runs' : 'mmxdwf-visible-runs';
    const watched = runs.filter((r) => !['running', 'cancelling'].includes(r.status)).map((r) => r.runKey || r.runId);
    if (watched.length) store.set(key, JSON.stringify([...new Set([...watched, ...JSON.parse(store.get(key) || '[]')])]));
  }
  const blobs = { created: [], revoked: [], values: [] };
  let data = runs;
  let postsReceived = 0;
  const getRuns = () => (typeof server.runs === 'function' ? server.runs() : (server.runs || data));

  const spec = (v) => (v === 'socket-drop' ? null : v);
  const fetchImpl = (url, opts = {}) => {
    requestLog.push({ url, opts, method: opts.method || 'GET' });
    if ((opts.method || 'GET') === 'POST') {
      postsReceived++;
      if (server.onPost) server.onPost(url, opts);
      let r;
      try { r = server.post ? server.post(url, opts) : { status: 200, body: { ok: true } }; }
      catch (e) { return Promise.reject(e); }   // a real fetch rejects; it never throws synchronously
      if (r === 'socket-drop') return socketDrop();
      return respond({ ...spec(r), signal: opts.signal });
    }
    if (url.includes('/artifact?')) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => 'application/octet-stream' },
        blob: async () => ({ size: 3, type: 'application/octet-stream' }),
        text: async () => 'artifact-text',
      });
    }
    if (url.includes('/runs')) {
      const r = getRuns();
      if (r && r.__spec) return respond({ ...spec(r.__spec), signal: opts.signal });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, runs: structuredClone(Array.isArray(r) ? r : []) }) });
    }
    if (url.includes('/result?')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, out: { result: 'x' } }) });
    if (url.includes('/script?')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, script: 'return 1;' }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  };

  const sandbox = {
    document: doc, console, Set, Map, AbortController, Error, Promise, JSON, Object, Array, String, Number, Boolean, Math, RegExp, Date, parseInt, parseFloat, isNaN, isFinite, URL, encodeURIComponent, decodeURIComponent,
    Date: now ? class extends Date { static now() { return now(); } } : Date,
    getComputedStyle: () => ({ position: 'static', backgroundColor: 'rgb(255, 255, 255)', colorScheme: 'light' }),
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval: () => {},
    // Timers are a fake clock: nothing runs until the test asks for it, and clearTimeout really
    // disarms, so a deadline that was already settled cannot be re-fired into a false failure.
    // A test never waits a real long timeout: it fires exactly the timers it wants.
    setTimeout: (f, ms) => { timers.push({ f, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    fetch: fetchImpl,
    addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn); },
  };
  sandbox.window = sandbox;
  sandbox.URL = class MockURL {
    static createObjectURL(blob) { const u = 'blob:mock-' + (blobs.created.length + 1); blobs.created.push(u); blobs.values.push(blob); return u; }
    static revokeObjectURL(u) { if (!blobs.revoked.includes(u)) blobs.revoked.push(u); }
  };
  sandbox.Blob = class MockBlob { constructor(parts, opts) { this._text = (parts || []).join(''); this.type = (opts && opts.type) || ''; } get size() { return this._text.length; } };
  let effectTeardown = null;
  sandbox.__ModuleLoader__ = { load: ({ factory }) => factory().apply({ effect: (f) => { effectTeardown = f(); } }) };

  vm.runInNewContext(source, sandbox);

  const api = {
    doc, sandbox, storage: store, requestLog, area, timers, intervals,
    get postsReceived() { return postsReceived; },
    posts: (needle) => requestLog.filter((r) => r.method === 'POST' && r.url.includes(needle)).length,
    setRuns: (v) => { data = v; },
    tick: async () => { intervals[0](); await flush(); },
    flush,
    // Fire every armed fake timer (an outstanding deadline aborts, the resume cooldown expires)
    // and settle. A disarmed timer is not fired — a deadline that already settled is not a test
    // event. No real long timeout is ever waited on.
    fireTimers: async () => { const list = timers.splice(0, timers.length); for (const t of list) if (!t.cleared) t.f(); await flush(); },
    stop: () => { const t = sandbox.__mmxDwfTeardown || effectTeardown; if (t) t(); },
  };
  // The card only exists after the client has seen /runs once, so every test starts mounted.
  await api.tick();
  // Boot timers (the 400ms first tick, the visibility trailing poll) are start-up artifacts, not
  // test events: drop them so a test that fires timers fires only the code under test.
  timers.length = 0;
  return api;
}

export const run = (id, status = 'running', extra = {}) => ({
  runId: id, name: id, status, cwd: 'G:/project',
  startedAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:01.000Z',
  phases: [], calls: [], logs: [], ...extra,
});
export const waiting = (qId = 'q1', question = '继续？') => ({ qId, question, state: 'waiting' });
