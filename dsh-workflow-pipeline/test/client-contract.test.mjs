// test/client-contract.test.mjs — single-slice contract tests for the N03 client.js changes and
// the dsh-workflow Skill's own frontmatter/body.
//
// Self-contained: its own temporary tree, its own fake DOM, no real host, no UI, no business
// API, no shared Temp runner, no model dispatch. The pinned areas are
//   (1) main-session identity under BOTH official snapshot shapes, including fail-closed refusals,
//   (2) sidebar row identity, where only `data-row-key="session:<id>"` may claim a line,
//   (3) activation generation: dispose/re-apply on ONE module instance must be a real restart,
//   (4) the cross-host/native binding guards, and
//   (5) the Skill's frontmatter, its `/` gesture, and its file-backend bridge contract.
//
// EVIDENCE SCOPE for the row-key contract. `data-row-key="session:<id>"` (with the
// `workspace:` / `overflow:` / `empty` siblings) was read out of
// @deepseek-ai/dsh-client-ui-workspace@0.2.0-rc.2, the official `next` line. The 0.1.5-rc.2 line
// this host actually runs emits NEITHER `data-row-key` NOR `data-session-id` anywhere in its
// official client packages — so on that line `rowSessionId()` resolves every row to '' and no row
// gets a line. The block under test is a forward-compatible adapter, deliberately kept because
// the 0.2.0-rc.2 contract is published; it is NOT a claim that any row is claimed today.
//
// Other host facts, all read from official sources:
//   0.1.5-rc.2  dsh-client-ui-session/lib/client.js  resolveCurrent() -> getSnapshot().current
//   0.2.0-rc.2  dsh-client-ui-session/lib/client.js  publishMain()   -> byId[id].retainedBy.mainView
//                ctx.sessions.retainInfo(id).subscribe() for seat moves
//   0.1.5-rc.2  dsh-skill/lib/index.js               SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
//   0.1.5-rc.2  dsh-skill-filesystem/lib/index.js    parseInvocationPolicy()
//   0.1.5-rc.2  dsh-tool-skill/lib/index.js          SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
//   0.8.1       plugins/dynamic-workflow/.../wf.mjs  confirmationFor(), callId minting, pending/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = readFileSync(join(ROOT, 'client.js'), 'utf8');
const SKILL_PATH = join(ROOT, 'skills', 'dsh-workflow', 'SKILL.md');

const cleanups = [];
after(() => { for (const fn of cleanups) { try { fn(); } catch {} } });

// ---------- fake DOM ----------

function makeRow({ key = null, sessionId = null, className = '' } = {}) {
  const attrs = new Map();
  if (key !== null) attrs.set('data-row-key', key);
  if (sessionId !== null) attrs.set('data-session-id', sessionId);
  const row = {
    className,
    style: {},
    _dwfStyleSaved: undefined,
    parentElement: null,
    lineNode: null,
    inserted: [],
    getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
    setAttribute: (n, v) => attrs.set(n, String(v)),
    removeAttribute: (n) => attrs.delete(n),
    hasAttribute: (n) => attrs.has(n),
    querySelector(sel) { return sel === '[data-dwf-line]' ? row.lineNode : null; },
    insertAdjacentHTML(_pos, html) {
      row.inserted.push(html);
      const node = { tag: 'line', parentElement: row, remove() { row.lineNode = null; } };
      row.lineNode = node;
    },
    hasLine: () => !!row.lineNode,
  };
  return row;
}

// A sessions service with the two official shapes behind one switchable snapshot.
function makeSessions(snapshot = {}) {
  const listeners = new Set();
  const retainListeners = new Map();
  const svc = {
    snapshot,
    retainCalls: 0,
    getSnapshot: () => svc.snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    retainInfo(id) {
      svc.retainCalls++;
      const store = {
        getSnapshot: () => ({ retainedBy: { mainView: (svc.snapshot.byId || {})[id] && svc.snapshot.byId[id].retainedBy ? svc.snapshot.byId[id].retainedBy.mainView || 0 : 0 } }),
        subscribe(fn) {
          if (!retainListeners.has(id)) retainListeners.set(id, new Set());
          retainListeners.get(id).add(fn);
          return () => retainListeners.get(id).delete(fn);
        },
      };
      return store;
    },
    emit() { for (const fn of [...listeners]) fn(); },
    emitRetain(id) { for (const fn of [...(retainListeners.get(id) || [])]) fn(); },
    listenerCount: () => listeners.size,
  };
  return svc;
}

function makeHarness({ sessions = null, rows = [] } = {}) {
  const timers = { timeouts: [], intervals: 0, cleared: 0 };
  const fetchCalls = [];
  const pendingPolls = [];
  const byId = new Map();

  const document = {
    visibilityState: 'visible',
    body: { appendChild() {} },
    head: { appendChild(el) { byId.set(el.id, el); } },
    documentElement: { setAttribute() {}, style: {}, classList: { add() {}, remove() {}, contains: () => false } },
    createElement(tag) {
      return { tag, id: '', textContent: '', style: {}, classList: { add() {}, remove() {}, contains: () => false }, innerHTML: '', children: [], appendChild() {}, remove() {}, insertBefore() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [] };
    },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll(sel) {
      // The card anchor is deliberately never found, so the conversation card path stays
      // inert and these tests only observe the sidebar and the session adapter.
      if (typeof sel === 'string' && sel.includes('viewArea')) return [];
      if (typeof sel === 'string' && (sel.includes('data-row-key') || sel.includes('sessionRow'))) return rows.slice();
      return [];
    },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };

  const win = {
    setInterval() { timers.intervals++; return { id: timers.intervals }; },
    clearInterval() { timers.cleared++; },
    setTimeout(fn) { timers.timeouts.push(fn); return { timeout: true }; },
    clearTimeout() {},
    matchMedia: () => ({ matches: true }),
  };

  const sandbox = {
    window: Object.assign(win, {
      __ModuleLoader__: {
        load(spec) { sandbox.__loaded = spec.factory(() => ({})); },
      },
    }),
    document,
    localStorage: {
      store: new Map(),
      getItem(k) { return this.store.has(k) ? this.store.get(k) : null; },
      setItem(k, v) { this.store.set(k, String(v)); },
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(0, 0, 0)', position: 'static' }),
    fetch(url) {
      fetchCalls.push(url);
      if (String(url).includes('/api/runs')) {
        return new Promise((resolvePromise, rejectPromise) => {
          pendingPolls.push({ resolve: resolvePromise, reject: rejectPromise, url });
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false }) });
    },
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    console,
    Promise, Map, Set, JSON, Object, Array, Number, String, Boolean, Date, Math, isFinite, encodeURIComponent, decodeURIComponent, RegExp, Error, TypeError,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'client.js' });

  const exportsObj = sandbox.__loaded;
  // The client closure lives in its own realm, so anything it hands back is a foreign
  // Array/Object. Compare through JSON so the assertions test values, not prototypes.
  const plain = (v) => JSON.parse(JSON.stringify(v));

  // ctx.sessions is the host service: the list store plus (0.2.0-rc.2) retainInfo.
  const hRef = { lastDisposer: null, plain };
  const ctxFor = (store) => ({
    sessions: store ? { list: store, retainInfo: (id) => store.retainInfo(id) } : undefined,
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') { disposersAll.push(d); hRef.lastDisposer = d; }
      return d;
    },
  });

  function apply(store) {
    exportsObj.apply(ctxFor(store));
  }
  function fireTimeouts() {
    const queued = timers.timeouts.splice(0, timers.timeouts.length);
    for (const fn of queued) fn();
  }
  function pollResponse(runs, opts = {}) {
    const body = { ok: true, runs };
    const p = pendingPolls.shift();
    assert.ok(p, 'a poll was in flight');
    if (opts.fail) p.reject(new Error(opts.fail));
    else p.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    return flush();
  }
  // Drain the microtask queue so promise chains settle.
  function flush() { return new Promise((r) => setImmediate(r)); }

  const h2 = Object.assign(hRef, {
    exports: exportsObj,
    internals: exportsObj.__clientInternals,
    sessions,
    rows,
    fetchCalls,
    pendingPolls,
    timers,
    apply,
    fireTimeouts,
    pollResponse,
    flush,
  });
  // Activation 1 is created here; every later apply() appends to the same disposer list.
  const disposersAll = [];
  h2.disposeAll = () => { for (const d of disposersAll.splice(0)) { try { d(); } catch {} } };
  cleanups.push(() => { for (const d of disposersAll.splice(0)) { try { d(); } catch {} } });
  h2.apply(sessions);
  return h2;
}

// One row bound to a native DSH session, with a live run.
function makeRun(over = {}) {
  return Object.assign({
    runKey: 'k1', runId: 'r1', name: 'demo', status: 'running',
    startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    currentPhase: 'Phase A', phases: [{ name: 'Phase A' }], calls: [],
    hostSession: { host: 'dsh', source: 'native-shell', sessionId: 'sess-1' },
  }, over);
}

// ---------- 1. main-session identity ----------

test('0.1.5-rc.2: an explicit snapshot `current` is the seat and outranks a retain count', async () => {
  const sessions = makeSessions({ ids: ['a', 'b'], phase: 'ready', current: 'a',
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), 'a');
  assert.equal(h.internals.mainViewNote(), '');
});

test('0.1.5-rc.2: no `current` means no seat — never fall back to a count on that shape', async () => {
  const sessions = makeSessions({ ids: [], phase: 'ready', current: '',
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), '');
  assert.match(h.internals.mainViewNote(), /current/);
});

test('0.2.0-rc.2: the single retainedBy.mainView row is the seat', async () => {
  const sessions = makeSessions({ ids: ['b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), 'b');
});

test('0.2.0-rc.2: no retained row yields no seat', async () => {
  const sessions = makeSessions({ ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 0 } } } });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), '');
});

test('0.2.0-rc.2: two retained rows and no sticky seat are AMBIGUOUS and refused, not opened', async () => {
  const sessions = makeSessions({ ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), '');
  assert.match(h.internals.mainViewNote(), /2/);
});

test('0.2.0-rc.2: a seat that becomes ambiguous keeps the sticky winner (official publishMain)', async () => {
  const sessions = makeSessions({ ids: ['a'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), 'a');
  sessions.snapshot = { ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } };
  assert.equal(h.internals.currentSessionId(), 'a', 'sticky seat survives a second retainer');
});

test('0.2.0-rc.2: a vetoed sticky seat hands over to the confirmed holder, never back to the vetoed id', async () => {
  const sessions = makeSessions({ ids: ['a'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), 'a');
  // The list still counts A, but the authoritative store says the seat moved to B.
  sessions.snapshot = { ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } };
  sessions.retainInfo = (id) => ({
    getSnapshot: () => ({ retainedBy: { mainView: id === 'a' ? 0 : 1 } }),
    subscribe: () => () => {},
  });
  assert.equal(h.internals.currentSessionId(), 'b', 'the vetoed id is never returned again');
});

test('0.2.0-rc.2: a SINGLE projected row the authoritative store no longer retains is refused', async () => {
  // Minimal repro of the stale single-row projection. byId still projects A as the only
  // main-view retainer; retainInfo(A) says 0 because the seat already moved on. Taking the
  // single row here would resurrect the session that just lost the seat, so the seat is ''.
  const sessions = makeSessions({ ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: { mainView: 0 } } } });
  sessions.retainInfo = (id) => ({
    getSnapshot: () => ({ retainedBy: { mainView: id === 'a' ? 0 : 1 } }),
    subscribe: () => () => {},
  });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), '', 'a single unconfirmed row must not become the seat');
  assert.match(h.internals.mainViewNote(), /权威/);
  // Positive control on the same shape: with the store confirming it, the single row IS the seat.
  sessions.retainInfo = (id) => ({
    getSnapshot: () => ({ retainedBy: { mainView: id === 'a' ? 1 : 0 } }),
    subscribe: () => () => {},
  });
  assert.equal(h.internals.currentSessionId(), 'a', 'a single CONFIRMED row is the seat');
});

test('0.2.0-rc.2: a retain event hands the seat over and the watch follows the new holder', async () => {
  const sessions = makeSessions({ ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } }, b: { id: 'b', retainedBy: { mainView: 0 } } } });
  // A holds the seat; B is not retained yet. The list projection lags the store by design.
  let counts = { a: 1, b: 0 };
  sessions._watch = {};
  sessions.retainInfo = (id) => ({
    getSnapshot: () => ({ retainedBy: { mainView: counts[id] || 0 } }),
    subscribe(fn) { sessions._watch[id] = fn; return () => { delete sessions._watch[id]; }; },
  });
  const h = makeHarness({ sessions });
  assert.equal(h.internals.currentSessionId(), 'a');
  assert.equal(h.internals.activationState().retainWatchId, 'a');

  // (1) Handover announced on A while the list projection still names only A. B is not a
  // candidate we can even enumerate yet, so the seat must fail closed and the watch on A
  // must be RELEASED rather than kept — keeping it is the bug this pins.
  counts = { a: 0, b: 1 };
  sessions._watch.a();
  assert.equal(h.internals.currentSessionId(), '', 'a seat the projection cannot corroborate is refused');
  assert.equal(h.internals.activationState().retainWatchId, null, 'the stale A watch was released');

  // (2) The list projection catches up and publishes B as the holder.
  sessions.snapshot = { ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } };
  sessions.emit();
  assert.equal(h.internals.currentSessionId(), 'b');
  assert.equal(h.internals.activationState().retainWatchId, 'b', 'the watch re-armed onto the new holder');

  // (3) B releases: the store denies it and the projection is cleared.
  counts = { a: 0, b: 0 };
  sessions.snapshot = { ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 0 } } } };
  sessions._watch.b();
  assert.equal(h.internals.currentSessionId(), '', 'a released seat is not resurrected');
  assert.equal(h.internals.activationState().retainWatchId, null, 'the watch was released too');

  // (4) A late/duplicate notification from the OLD holder must not re-point anything.
  counts = { a: 0, b: 1 };
  sessions._watch.a && sessions._watch.a();
  assert.equal(h.internals.activationState().retainWatchId, null, 'a released watch is not revived by a stale event');

  // (5) A duplicate for the CURRENT holder is a same-id no-op: no resubscribe churn.
  sessions.snapshot = { ids: ['a', 'b'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 1 } } } };
  sessions.emit();
  assert.equal(h.internals.currentSessionId(), 'b');
  const calls = sessions.retainCalls;
  sessions._watch.b(); sessions._watch.b();
  assert.equal(h.internals.currentSessionId(), 'b');
  assert.equal(sessions.retainCalls, calls, 'a same-id retain event does not resubscribe');
  assert.equal(h.internals.activationState().retainWatchId, 'b');
});

test('0.2.0-rc.2: a retain event on a dead activation changes nothing', async () => {
  const sessions = makeSessions({ ids: ['a'], phase: 'ready',
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions });
  const seen = sessions.listenerCount();
  assert.ok(seen >= 1);
  h.disposeAll();
  assert.equal(h.internals.activationState().stopped, true);
  // Disposal unsubscribed, so a later emit reaches nobody; the state must stay stopped.
  sessions.emit();
  assert.equal(h.internals.activationState().stopped, true);
  assert.equal(h.internals.currentSessionId(), '');
});

test('unknown snapshot shapes fail closed instead of guessing', async () => {
  const noById = makeSessions({ ids: ['a'], phase: 'ready' });
  const h1 = makeHarness({ sessions: noById });
  assert.equal(h1.internals.currentSessionId(), '');
  assert.match(h1.internals.mainViewNote(), /未知/);

  const badCurrent = makeSessions({ ids: ['a'], phase: 'ready', current: 123,
    byId: { a: { id: 'a', retainedBy: { mainView: 1 } } } });
  const h2 = makeHarness({ sessions: badCurrent });
  assert.equal(h2.internals.currentSessionId(), '');
});

test('a host without the sessions service keeps the global view', async () => {
  const h = makeHarness({ sessions: null });
  assert.equal(h.internals.currentSessionId(), '');
});

// ---------- 2. sidebar row identity ----------

test('only data-row-key="session:<id>" rows are eligible; workspace/overflow/empty never are', async () => {
  const sessionRow = makeRow({ key: 'session:sess-1', className: 'x_sessionRow' });
  const workspaceRow = makeRow({ key: 'workspace:w1', className: 'x_sessionRow' });
  const overflowRow = makeRow({ key: 'overflow:w1', className: 'x_sessionRow' });
  const emptyRow = makeRow({ key: 'empty', className: 'x_sessionRow' });
  const classOnlyRow = makeRow({ className: 'x_sessionRow' });
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1',
    byId: { 'sess-1': { id: 'sess-1', retainedBy: { mainView: 1 } } } });
  const h = makeHarness({ sessions, rows: [sessionRow, workspaceRow, overflowRow, emptyRow, classOnlyRow] });

  assert.equal(h.internals.rowSessionId(sessionRow), 'sess-1');
  for (const row of [workspaceRow, overflowRow, emptyRow, classOnlyRow]) {
    assert.equal(h.internals.rowSessionId(row), '', `${row.className} row must not resolve a session`);
  }
  assert.deepEqual(h.plain(h.internals.sessionRows().map((r) => r.rowKey || r.className)), [sessionRow.rowKey || sessionRow.className]);

  h.fireTimeouts();
  await h.pollResponse([makeRun()]);
  assert.equal(sessionRow.hasLine(), true, 'the session row gets the progress line');
  for (const row of [workspaceRow, overflowRow, emptyRow, classOnlyRow]) {
    assert.equal(row.hasLine(), false, 'a non-session row must never get a line');
  }
});

test('the legacy data-session-id attribute is still honoured as a row id', async () => {
  const legacy = makeRow({ sessionId: 'sess-1', className: 'x_sessionRow' });
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' });
  const h = makeHarness({ sessions, rows: [legacy] });
  assert.equal(h.internals.rowSessionId(legacy), 'sess-1');
  h.fireTimeouts();
  await h.pollResponse([makeRun()]);
  assert.equal(legacy.hasLine(), true);
});

test('a row that only matches the class selector and has no id gets no line', async () => {
  const classOnly = makeRow({ className: 'x_sessionRow' });
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' });
  const h = makeHarness({ sessions, rows: [classOnly] });
  h.fireTimeouts();
  await h.pollResponse([makeRun()]);
  assert.equal(classOnly.hasLine(), false);
  assert.deepEqual(h.plain(h.internals.sessionRows()), []);
});

// ---------- 3. cross-host / native guards (unchanged behaviour, pinned) ----------

test('a run bound to another host never claims a DSH row, even under the same session id', async () => {
  const row = makeRow({ key: 'session:sess-1', className: 'x_sessionRow' });
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' });
  const mmx = makeRun({ runKey: 'k2', hostSession: { host: 'mmx', source: 'native-hook', sessionId: 'sess-1' } });
  const h = makeHarness({ sessions, rows: [row] });
  assert.deepEqual(h.plain(h.internals.bindingOf(mmx)), { host: 'mmx', sessionId: 'sess-1', native: true });
  h.fireTimeouts();
  await h.pollResponse([mmx]);
  assert.equal(row.hasLine(), false, 'cross-host same-name session is not claimed');
});

test('an unrecognised native origin is refused instead of downgraded to a manual binding', async () => {
  const bogus = makeRun({ runKey: 'k3', hostSession: { host: 'dsh', source: 'made-up', sessionId: 'sess-1' } });
  const h = makeHarness({ sessions: makeSessions({ ids: [], phase: 'ready' }) });
  const b = h.internals.bindingOf(bogus);
  assert.equal(b.invalid, true);
  assert.equal(b.sessionId, '');
});

test('a natively-attributed run cannot be manually rebound or unbound', async () => {
  const row = makeRow({ key: 'session:sess-9', className: 'x_sessionRow' });
  const native = makeRun({ runKey: 'k4', hostSession: { host: 'dsh', source: 'native-shell', sessionId: 'sess-9' } });
  const h = makeHarness({ sessions: makeSessions({ ids: [], phase: 'ready' }), rows: [row] });
  h.internals.bindRunToSession(native, 'sess-other');
  assert.equal(h.internals.bindingOf(native).sessionId, 'sess-9');
  h.internals.unbindRun(native);
  assert.equal(h.internals.bindingOf(native).sessionId, 'sess-9');
});

// ---------- 4. activation generation (F11) ----------

test('dispose then re-apply on the SAME module instance is a real restart', async () => {
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' });
  const h = makeHarness({ sessions });
  h.disposeAll();
  assert.equal(h.internals.activationState().stopped, true);

  const before = h.fetchCalls.length;
  h.apply(sessions);
  const st = h.internals.activationState();
  assert.equal(st.stopped, false, 'a restart must not inherit the previous stopped flag');
  assert.equal(st.sessions, true, 'the new activation re-reads the session service');
  h.fireTimeouts();
  assert.equal(h.fetchCalls.length, before + 1, 'the new activation polls again');
});

test('a straggler from a disposed activation cannot cancel or overwrite the new one', async () => {
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' });
  const h = makeHarness({ sessions });
  h.fireTimeouts();                                  // activation 1 poll, never answered
  const poll1 = h.pendingPolls[0];

  h.apply(sessions); // activation 2 is live
  h.fireTimeouts();
  const poll2 = h.pendingPolls[1];
  assert.ok(poll2, 'the new activation issued its own poll');
  assert.equal(h.internals.activationState().pollInFlight, true);

  // The old disposer bumped the old poll generation. That must not have touched
  // activation 2's in-flight state, so its own answer still lands.
  poll1.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, runs: [makeRun({ runKey: 'stale' })] }) });
  await h.flush();
  assert.equal(h.internals.activationState().pollInFlight, true, 'the straggler did not clear the new poll');
  assert.deepEqual(h.plain(h.internals.debugSnapshot().runs), [], 'the straggler was dropped, not applied');

  poll2.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, runs: [makeRun({ runKey: 'fresh' })] }) });
  await h.flush();
  assert.deepEqual(h.plain(h.internals.debugSnapshot().runs), ['fresh'], 'the live activation applied its own response');
  assert.equal(h.internals.debugSnapshot().offline, false);
});

test('a stale disposer tears down only its own activation', async () => {
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' });
  const h = makeHarness({ sessions });
  const first = h.lastDisposer;        // activation 1's OWN disposer, not disposeAll
  first();                             // the real dispose
  h.apply(sessions);                   // activation 2 is now live
  const st = h.internals.activationState();
  first();                            // double dispose: the OLD one, again
  assert.equal(h.internals.activationState().gen, st.gen, 'the live activation is unchanged');
  assert.equal(h.internals.activationState().stopped, false);
  assert.equal(h.internals.activationState().sessions, true);
  assert.equal(h.internals.currentSessionId(), 'sess-1');
});

test('a second, freshly loaded module instance is unaffected by the first one disposal', async () => {
  const a = makeHarness({ sessions: makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' }) });
  const b = makeHarness({ sessions: makeSessions({ ids: ['sess-2'], phase: 'ready', current: 'sess-2' }) });
  a.disposeAll();
  assert.equal(a.internals.activationState().stopped, true);
  assert.equal(b.internals.activationState().stopped, false);
  assert.equal(b.internals.currentSessionId(), 'sess-2');
});

test('a failed poll marks offline on the live activation only', async () => {
  const sessions = makeSessions({ ids: ['sess-1'], phase: 'ready', current: 'sess-1' });
  const h = makeHarness({ sessions });
  h.fireTimeouts();
  await h.pollResponse(null, { fail: 'boom' });
  assert.equal(h.internals.debugSnapshot().offline, true);
  assert.equal(h.internals.debugSnapshot().lastHttpError, 'boom');
});

// ---------- 5. dsh-workflow Skill frontmatter contract ----------

test('the dsh-workflow Skill exists with the official frontmatter and the official gesture', async () => {
  assert.ok(existsSync(SKILL_PATH), 'skills/dsh-workflow/SKILL.md exists');
  const raw = readFileSync(SKILL_PATH, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  assert.ok(m, 'YAML frontmatter block');
  const fm = Object.fromEntries(m[1].split('\n').filter((l) => /^[a-z-]+:/.test(l))
    .map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));

  // dsh-skill: SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name), 'kebab-case skill name');
  assert.equal(fm.name, 'dsh-workflow', 'unique name, no collision with dynamic-workflow / workflow');
  assert.ok(fm.description && fm.description.length > 0, 'description is required');

  // dsh-skill-filesystem parseInvocationPolicy(): modelInvocable = !disable-model-invocation,
  // userInvocable = user-invocable !== false; legacy camelCase keys are rejected outright.
  assert.equal(fm['disable-model-invocation'], 'true', 'not model-invocable: no natural-language auto-claim');
  assert.equal(fm['user-invocable'], 'true', 'user-invocable: the / gesture stays available');
  for (const legacy of ['modelInvocable', 'userInvocable', 'disableModelInvocation']) {
    assert.equal(fm[legacy], undefined, `legacy frontmatter key ${legacy} must be absent`);
  }

  // dsh-tool-skill SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
  const GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/;
  assert.ok(GESTURE.test('/dsh-workflow review the auth layer'), 'leading gesture is recognised');
  assert.ok(GESTURE.test('please run /dsh-workflow now'), 'gesture after whitespace is recognised');
  assert.equal(GESTURE.test('x/dsh-workflow'), false, 'a mid-word slash is NOT a gesture');
  assert.equal(GESTURE.test('5/8 of the files'), false, 'fractions are not gestures');
  assert.equal(GESTURE.test('use /usr/bin/env'), false, 'paths are not gestures');
  assert.equal(GESTURE.test('see https://x/dsh-workflow'), false, 'a URL path is not a gesture');

  // The DSH model reaches subagents through `subagent` / `subagent_fork`; the Skill must name
  // the real tools and must not invent a `task`/`qodercli` path.
  const body = raw.slice(m[0].length);
  for (const tool of ['subagent', 'subagent_fork', 'send_message', 'list_agents']) {
    assert.ok(body.includes(tool), `Skill names the host tool ${tool}`);
  }
  assert.ok(/if \*\*none\*\* of those tools is present[\s\S]*stop/i.test(body), 'a conditional no-tool branch exists');
  assert.ok(!/\bAskUserQuestion\b/.test(body), 'no ZCode-only confirmation tool is referenced');
  assert.ok(!/qodercli/.test(body) || /never|do not switch|never run/i.test(body), 'qodercli is a prohibition, not a fallback');

  // Explicit-run authorization: the gesture is the authorization, and the run is started
  // without another confirmation round.
  assert.match(body, /Do not\*\* ask the user to confirm the run/, 'explicit no-confirmation directive');
  assert.ok(body.includes('--backend file --yes'), 'file backend, started with --yes');
  assert.ok(!/wf\.mjs trust(?! )/.test(body.replace(/Never run `wf\.mjs trust` and never set a trust wildcard/, '')), 'no global trust wildcard');

  // --yes is a flag, NOT a content-hash confirmation. wf.mjs confirmationFor() returns
  // { required: false, basis: 'flag' } as soon as it sees flags.yes || flags.trusted.
  assert.match(body, /`--yes` is a \*\*flag, not a check\*\*/, 'the skill must not call --yes a hash check');
  assert.match(body, /basis: 'flag'/, 'the real confirmation basis is named');
  assert.match(body, /does not compare the script's content hash/, 'the hash-check misconception is spelled out');
  assert.ok(!/one-off confirmation for the script's content hash only/.test(body), 'the old wrong claim is gone');

  // pending.json is a summary; the per-call file is the source of truth for the prompt and
  // the four `wants` fields, and the callId is validated before it is used in a path.
  assert.match(body, /`pending\.json` is a summary; it is not the source of truth/, 'summary vs source of truth is stated');
  assert.ok(body.includes('pending/<callId>.json'), 'the per-call file is named');
  assert.ok(body.includes('^c[0-9]{3,}-[0-9a-f]{8}$'), 'the callId grammar is pinned');
  assert.match(body, /containing `\.\.`,[\s\S]{0,80}\//, 'traversal and separators are refused');
  assert.match(body, /Never fabricate an answer/, 'no fabricated answers');
  assert.match(body, /read `<dir>\/out\.json` and report the real\s+value/, 'full out.json, not the preview');
  // Engine version must be checked before launch; the file-backend handshake is 0.8.1.
  assert.match(body, /ENGINE_VERSION/, 'the engine version is checked');
  assert.match(body, /0\.8\.1/, 'the expected engine version is stated');
  // A business ask still waits for a real user answer.
  assert.match(body, /`ask\(\)`[\s\S]{0,500}Never invent an answer/, 'business ask still waits for a real user answer');
});
