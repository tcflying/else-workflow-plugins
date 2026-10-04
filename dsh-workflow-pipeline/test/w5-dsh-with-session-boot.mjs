// test/lib is shared W2/W5 infrastructure and is NOT modified here. This file is a small,
// purpose-built boot used only by test/w5-dsh-global-history-entry.test.mjs, because F12 must
// be pinned on BOTH sides of the new branch:
//
//   * no provable current session (the pre-fix failure shape), and
//   * a provable current session (the pre-existing behaviour that must not change).
//
// The shared W2 harness boots the client with a ctx that has no `sessions` service, so
// currentSessionId() is always '' there. The second shape needs the host's real
// `ctx.sessions.list.getSnapshot().current` seam, hence this local boot. It is deliberately
// tiny: just enough DOM for sweepCard()/bannersHtml(), no modal, no history fetch.
//
// Fake clock only, no real timers, no host, no network, no third-party dependency.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client.js');
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

class El {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.attrs = {};
    this.style = {}; this.listeners = {}; this.clientHeight = 600;
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add() {}, remove() {}, toggle() { return false; },
    };
  }
  set id(v) { this.attrs.id = String(v); } get id() { return this.attrs.id || ''; }
  set className(v) { this.attrs.class = String(v); } get className() { return this.attrs.class || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  get parentElement() { return this.parentNode; }
  get parentNode() { return this._parent || null; }
  set parentNode(v) { this._parent = v; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { return this === this.doc.documentElement || !!this.parentNode?.isConnected; }
  get childElementCount() { return this.children.length; }
  get textContent() { return (this._text || '') + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children.forEach((c) => c.remove()); this._text = String(v ?? ''); }
  get innerHTML() { return this.children.map((c) => '<' + c.tagName.toLowerCase() + '>').join(''); }
  set innerHTML(html) {
    this.children.forEach((c) => c.remove()); this._text = ''; this._html = html;
    const dec = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const stack = [this];
    for (const m of String(html).matchAll(/<\/(\w+)>|<(\w+)([^>]*)>|([^<]+)/g)) {
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      if (m[2]) {
        const el = new El(m[2], this.doc);
        for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], dec(a[2] || ''));
        stack.at(-1).appendChild(el);
        if (!['input', 'br', 'hr'].includes(m[2]) && !m[3].endsWith('/')) stack.push(el);
      } else if (m[4]) stack.at(-1)._text = (stack.at(-1)._text || '') + dec(m[4]);
    }
  }
  insertAdjacentHTML(_w, html) { const t = this.doc.createElement('div'); t.innerHTML = html; t.children.slice().forEach((c) => this.appendChild(c)); }
  appendChild(el) { el.remove(); el.parentNode = this; this.children.push(el); return el; }
  insertBefore(el, before) { el.remove(); el.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, el); return el; }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.children = p.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  matches(sel) {
    return sel.split(',').some((s) => {
      s = s.trim();
      for (const a of s.matchAll(/\[([\w-]+)(\*=|=)?["']?([^\]"']*)["']?\]/g)) {
        const v = this.getAttribute(a[1]);
        if (v === null || (a[2] === '=' && v !== a[3]) || (a[2] === '*=' && !v.includes(a[3]))) return false;
      }
      for (const c of s.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(c[1])) return false;
      return true;
    });
  }
  querySelectorAll(sel) { return this.children.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { return this.matches(sel) ? this : this.parentNode?.closest(sel) || null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, extras = {}) { const ev = { target: this, ...extras }; for (let e = this; e; e = e.parentNode) for (const fn of e.listeners[t] || []) fn(ev); }
  click() { this.dispatch('click'); }
  get nextSibling() { const a = this.parentNode?.children || []; return a[a.indexOf(this) + 1] || null; }
}

/**
 * Boot client.js with a host that DOES expose `ctx.sessions`, whose list snapshot carries an
 * explicit `current` (the 0.1.5-rc.2 official shape).
 */
export async function bootWithCurrent(current, runs) {
  const source = readFileSync(CLIENT, 'utf8');
  const doc = { readyState: 'complete', activeElement: null, visibilityState: 'visible' };
  doc.createElement = (t) => new El(t, doc);
  doc.documentElement = doc.createElement('html');
  doc.head = doc.createElement('head');
  doc.documentElement.appendChild(doc.head);
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.documentElement.querySelector('#' + id);
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.addEventListener = () => {}; doc.removeEventListener = () => {};
  const area = doc.createElement('div'); area.className = 'viewArea';
  doc.body.appendChild(area);

  const timers = [], intervals = [];
  const store = new Map();
  let teardown = null;
  const sessions = {
    list: { getSnapshot: () => ({ current }), subscribe: () => () => {} },
    retainInfo: () => null,
  };
  const fetchImpl = (url) => (url.includes('/runs')
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, runs: structuredClone(runs) }) })
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }));

  const sandbox = {
    document: doc, console, Set, Map, AbortController, Error, Promise, JSON, Object, Array,
    String, Number, Boolean, Math, RegExp, Date, isFinite, isNaN, URL,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
    getComputedStyle: () => ({ position: 'static', backgroundColor: 'rgb(255, 255, 255)' }),
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval: () => {},
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    fetch: fetchImpl,
    addEventListener: () => {}, removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.__ModuleLoader__ = { load: ({ factory }) => factory().apply({ effect: (f) => { teardown = f(); }, sessions }) };

  vm.runInNewContext(source, sandbox);
  const api = {
    doc, area, storage: store, sandbox, timers, intervals, flush,
    tick: async () => { intervals[0](); await flush(); },
    stop: () => { if (teardown) teardown(); },
  };
  await api.tick();
  timers.length = 0;
  return api;
}
