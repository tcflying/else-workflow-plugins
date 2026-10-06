// test/w4-session-source-attribution.test.mjs — 1004.md §4 W4 / F01 (MMX).
//
// F01: "local 持久会话 ID 被当成 cloud 当前会话，手动归属错写".
//
// Re-verified against the CURRENT Desktop build (G:/MiniMax/MiniMax Code/resources/app.asar,
// `__MAVIS_VERSION__:"3.1.0"`, read-only) before implementing, because the item is marked
// "历史审查快照，实施前重核":
//
//   out/_next/static/chunks/90321-b899277594fb8c24.js
//     module 47956 : `Y(key)` -> localStorage accessor, `f(key)` -> sessionStorage accessor.
//     module 67575  : `let d = (0, s.f)("mavis:activeSessionId")`  — ONE sessionStorage key,
//                     while the session store is a PER-SOURCE factory:
//                       activeSessionId : (0, o.Vw)(i) ? d.load() : null
//                       setActiveSession: (0, o.Vw)(i) && d.save(a)
//                       clearActiveSession:(0, o.Vw)(i) && d.clear()
//     module 81775  : the source predicate and the persisted source
//                       let n = "mavis.conversationSource"   (localStorage, 'local' | 'cloud')
//                       function s() { return !r.d && (r.$L || r.tY) ? "cloud" : "local" }
//                       function f(e) { return !r.d || "local" === e }        // Vw
//                     with the desktop build constant `d = true` (module 58291), i.e. Vw is
//                     true ONLY for the "local" source.
//     out/_next/static/chunks/24831-c0e9097d889e130e.js
//                     the key is cleared in exactly one place: `logout()`.
//                     Switching the source only writes `mavis.conversationSource`.
//
//   => Contract, on the current build: `mavis:activeSessionId` is the LOCAL source's persisted
//      current session. It is never written for the cloud source and never cleared when the user
//      leaves the local source, so under cloud it is a leftover LOCAL id, not the cloud current
//      session. F01's root cause therefore HOLDS — with the storage corrected: the carrier is
//      sessionStorage (not localStorage), and "local store" means the local conversation SOURCE.
//
// These tests keep F01's guards, quoted from 1004.md §4 W4:
//   "cloud 身份不明确时 fail-closed"  -> cases 2 and 3: no one-click bind surface appears and
//      nothing is guessed from titles or cwd. The explicit session picker that used to sit behind
//      that guard is gone with the host session list, so the guard is now absolute: with no
//      verifiable current session there is no bind control at all and nothing is written.
//   "不猜标题/cwd"  -> the cloud id only ever comes from the host's own DOM marker; no fallback
//      in this file (or in the client) reads a title, a cwd or a row order.
//   "不无条件把所有 DOM marker 提到最高优先级"  -> case 4: with the local source the host state
//      still wins over a disagreeing marker, exactly as before.
//   "不覆盖非空 native 归属"  -> case 3: a run that already carries native hostSession metadata
//      keeps it and gets no manual record, in cloud mode and under a stale stored key.
//
// No third-party dependency, no host, no fixed Temp name, no real clock: the shared client harness
// (test/lib/w2-client-harness.mjs) already fakes timers and owns the DOM/fetch doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run } from './lib/w2-client-harness.mjs';

const SOURCE_KEY = 'mavis.conversationSource';
const SESSION_STATE_KEY = 'mavis:activeSessionId';
const mvsId = (c) => 'mvs_' + c.repeat(32);
const LOCAL_A = mvsId('a');
const CLOUD_B = mvsId('b');

// The host's own per-tab session state. The shared harness installs a getItem() that always
// returns null (every W2 fixture describes a host with no current session), so the value is
// installed onto the already-contextified sandbox — `storedSessionId()` reads it per call, so
// the same object also lets a test flip the host's state between renders.
function setHostSessionState(api, sessionId) {
  const store = new Map(sessionId == null ? [] : [[SESSION_STATE_KEY, sessionId]]);
  api.sandbox.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

function addActiveMarker(api, sid) {
  const el = api.doc.createElement('div');
  el.setAttribute('data-shortcut-session-active', 'true');
  el.setAttribute('data-shortcut-session-target', sid);
  api.doc.body.appendChild(el);
  return el;
}

const bindingOf = (api) => JSON.parse(api.storage.get('mmxdwf-session-bindings') || '{}');

// The harness DOM double supports single selectors only (no descendant combinator), so a card
// control is looked up inside the run's own card element.
function inCard(api, runId, act) {
  const card = api.doc.querySelector('[data-run="' + runId + '"]');
  return (card && card.querySelectorAll('[data-act="' + act + '"]')[0]) || null;
}

test('F01: under the cloud source the leftover local persisted id is not the current session', async () => {
  // local session A was active, then the user moved to a cloud conversation B. The host never
  // rewrites `mavis:activeSessionId` for the cloud source, so the key still says A.
  const api = await boot('mmx', {
    runs: [run('w4-cloud', 'running')],
    storage: new Map([[SOURCE_KEY, 'cloud']]),
  });
  try {
    setHostSessionState(api, LOCAL_A);
    addActiveMarker(api, CLOUD_B);
    await api.tick();

    const internals = api.sandbox.__mmxDwfInternals;
    assert.equal(internals.currentSessionId(), CLOUD_B,
      'the cloud current session comes from the host marker, not from the stale local key');

    const bind = inCard(api, 'w4-cloud', 'bind');
    assert.ok(bind, 'the marker is the host telling us the active cloud session, so the one-click bind exists');
    bind.dispatch('click');
    await api.tick();
    assert.equal(bindingOf(api)['w4-cloud'].sessionId, CLOUD_B,
      'the manual attribution is written for the cloud session, never for the leftover local id');
  } finally { api.stop(); }
});

test('F01: cloud identity unresolvable fails closed with no bind control at all', async () => {
  // Same leftover local key, but the active cloud session is not rendered (collapsed / virtualized):
  // there is no verifiable cloud current session, so nothing may be written and nothing may offer
  // to write it.
  const api = await boot('mmx', {
    runs: [run('w4-failclosed', 'running')],
    storage: new Map([[SOURCE_KEY, 'cloud']]),
  });
  try {
    setHostSessionState(api, LOCAL_A);
    await api.tick();

    const internals = api.sandbox.__mmxDwfInternals;
    assert.equal(internals.currentSessionId(), '',
      'an unresolvable cloud current session is reported as absent, never as the local leftover');
    assert.equal(inCard(api, 'w4-failclosed', 'bind'), null,
      'no one-click bind surface is offered: the fail-closed path writes no attribution');
    assert.equal(inCard(api, 'w4-failclosed', 'bindpick'), null,
      'and no alternative bind control replaces it — the guard is now absolute');
    assert.equal(bindingOf(api)['w4-failclosed'], undefined, 'nothing was written');
  } finally { api.stop(); }
});

test('F01: a non-empty native attribution is never overwritten under the cloud source', async () => {
  // Positive control for the guard F01 names: the manual path only ever fills in a run with no
  // native origin. hostSession is the engine-side record and must win untouched.
  const native = { host: 'mmx', sessionId: 'sess-native-1', source: 'native-hook' };
  const api = await boot('mmx', {
    runs: [run('w4-native', 'running', { hostSession: native })],
    storage: new Map([[SOURCE_KEY, 'cloud']]),
  });
  try {
    setHostSessionState(api, LOCAL_A);
    addActiveMarker(api, CLOUD_B);
    await api.tick();

    const bound = api.sandbox.__mmxDwfInternals.bindingOf(run('w4-native', 'running', { hostSession: native }));
    // The internals object is created inside the vm realm, so it is copied into this realm
    // before a strict deep comparison (the prototype has to be this one).
    assert.deepEqual({ ...bound }, { host: 'mmx', sessionId: 'sess-native-1', source: 'native-hook', native: true });
    assert.equal(inCard(api, 'w4-native', 'bind'), null,
      'a natively attributed run is not offered the one-click rebind');
    assert.equal(bindingOf(api)['w4-native'], undefined,
      'no manual record is written over a non-empty native attribution');
  } finally { api.stop(); }
});

test('F01: with the local source the host session state still outranks a disagreeing marker', async () => {
  // Guard: "不无条件把所有 DOM marker 提到最高优先级". The re-checked contract says the
  // persisted key IS the local source's current session, so in the local source the host state
  // keeps winning exactly as before; only the cloud source changes which source is applicable.
  const api = await boot('mmx', {
    runs: [run('w4-local', 'running')],
    storage: new Map([[SOURCE_KEY, 'local']]),
  });
  try {
    setHostSessionState(api, LOCAL_A);
    addActiveMarker(api, CLOUD_B);
    await api.tick();

    const internals = api.sandbox.__mmxDwfInternals;
    assert.equal(internals.currentSessionId(), LOCAL_A, 'local source: the persisted key stays authoritative');

    const bind = inCard(api, 'w4-local', 'bind');
    assert.ok(bind);
    bind.dispatch('click');
    await api.tick();
    assert.equal(bindingOf(api)['w4-local'].sessionId, LOCAL_A);
  } finally { api.stop(); }
});

test('F01: an absent conversationSource key keeps the pre-existing local-source behaviour', async () => {
  // The host only persists `mavis.conversationSource` once the source is switched; the desktop
  // build's own default is "local" (module 81775 `s()` with `d = true`), so an absent key must
  // not change any pre-existing verdict.
  const api = await boot('mmx', { runs: [run('w4-nosource', 'running')], storage: new Map() });
  try {
    setHostSessionState(api, LOCAL_A);
    addActiveMarker(api, CLOUD_B);
    await api.tick();
    assert.equal(api.sandbox.__mmxDwfInternals.currentSessionId(), LOCAL_A);
    assert.ok(inCard(api, 'w4-nosource', 'bind'));
  } finally { api.stop(); }
});

test('F01: the home route carries no card, so no cloud id is ever attributed there', async () => {
  // F01 names the home guard explicitly ("cloud→home 会保留错 ID，但 home guard 仍禁止卡片").
  const api = await boot('mmx', {
    runs: [run('w4-home', 'running')],
    storage: new Map([[SOURCE_KEY, 'cloud']]),
  });
  try {
    setHostSessionState(api, LOCAL_A);
    addActiveMarker(api, CLOUD_B);
    await api.tick();
    assert.ok(api.doc.querySelector('[data-run="w4-home"]'), 'the conversation route shows the card');

    api.area.remove();
    const home = api.doc.createElement('div');
    home.setAttribute('data-testid', 'mavis-home-content');
    api.doc.body.appendChild(home);
    await api.tick();

    assert.equal(api.doc.querySelector('[data-mmxdwf-card]'), null, 'the home route mounts no conversation card');
    assert.equal(api.doc.querySelector('[data-act="bind"]'), null, 'so there is no one-click bind surface to click');
    assert.equal(bindingOf(api)['w4-home'], undefined, 'and nothing was attributed on the home route');
  } finally { api.stop(); }
});
