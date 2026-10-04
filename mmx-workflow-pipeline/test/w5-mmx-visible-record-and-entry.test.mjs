// test/w5-mmx-visible-record-and-entry.test.mjs — 1004.md §4 W5, MMX half: F08 + F03.
//
//   F08 (低) 可见记录读取损坏被静默丢弃。`mmxdwf-visible-runs` 读/JSON/Set 失败时清空集合
//            且不设 persistWarning，终态 run 离开卡片池而无提示。
//            The three shapes 1004.md names: a non-array payload, invalid JSON, and a
//            storage whose single key throws. All three must be VISIBLE; only a MISSING
//            key is a genuine absence and must stay a silent empty set.
//            Guards kept: 缺 key 仍为空集合、不伪造旧记录；写失败路径未改动。
//
//   F03 (中) MMX 首页没有首次打开全局历史的入口。home/unknown 路由禁止 conversation 卡片
//            的同时移除了承载两个 history 按钮的 CARD_ID；`historyEntries=0,
//            modalVisible=false`，且不依赖 current 是否存在。
//            Guards kept: 不自动挂终态卡（home/unknown 上仍不得出现任何运行卡片）、
//            关闭 modal 后须有重开入口、入口不依赖 current 会话。
//
// The shared harness (test/lib/w2-client-harness.mjs) owns the DOM/fetch doubles and the fake
// clock. No third-party dependency, no host, no fixed Temp name, no real engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run } from './lib/w2-client-harness.mjs';

const P = 'mmxdwf';
const VISIBLE = 'mmxdwf-visible-runs';
const MODAL = P + '-modal';
const HOME = 'mavis-home-content';

// ------------------------------------------------------------------ F08
// A storage double that fails exactly one key: the read must not be able to distinguish it
// from "absent", which is precisely the case that used to be dropped in silence.
const throwingStorage = (badKey, others = new Map()) => {
  const store = new Map(others);
  return {
    get size() { return store.size; },
    get: (k) => { if (k === badKey) throw new Error('storage unavailable for ' + k); return store.get(k) ?? null; },
    set: (k, v) => { store.set(k, v); return store; },
    has: (k) => store.has(k),
    delete: (k) => store.delete(k),
    keys: () => store.keys(),
    entries: () => store.entries(),
  };
};

for (const [label, value] of [
  ['a non-array payload', '{"a":1}'],
  ['a JSON string', '"ab"'],
  ['invalid JSON', '[not json'],
  ['a JSON null', 'null'],
]) {
  test(`F08 MMX: a corrupt ${label} in ${VISIBLE} is reported, not silently dropped`, async () => {
    const f = await boot('mmx', {
      runs: [run('f08-' + encodeURIComponent(label), 'running')],
      storage: new Map([[VISIBLE, value]]),
    });
    try {
      assert.ok(f.doc.querySelector(`.${P}-error`), 'a corrupt visible-runs record must surface a warning to the user');
      assert.match(f.doc.querySelector(`.${P}-error`).textContent, /显示记录/);
    } finally { f.stop(); }
  });
}

test('F08 MMX: a visible-runs read that throws on the single key is reported, not silently dropped', async () => {
  const f = await boot('mmx', {
    runs: [run('f08-throw', 'running')],
    storage: throwingStorage(VISIBLE),
  });
  try {
    assert.ok(f.doc.querySelector(`.${P}-error`), 'an unreadable storage key must surface a warning, exactly like a parse failure');
    assert.match(f.doc.querySelector(`.${P}-error`).textContent, /显示记录/);
  } finally { f.stop(); }
});

test('F08 MMX: a MISSING key is a genuine absence — empty set, no warning, no fabricated records', async () => {
  const f = await boot('mmx', { runs: [run('f08-absent', 'running')], storage: new Map() });
  try {
    assert.equal(f.doc.querySelector(`.${P}-error`), null, 'a first-ever visit has nothing to warn about');
    // The guard: no old records are invented out of a failed read.
    assert.equal(JSON.parse(f.storage.get(VISIBLE) || '[]').length, 1, 'only the live run the client itself wrote is recorded');
  } finally { f.stop(); }
});

test('F08 MMX: a VALID array is still read, and the warning never replaces a real record', async () => {
  const f = await boot('mmx', {
    runs: [run('f08-ok-live', 'running')],
    storage: new Map([[VISIBLE, JSON.stringify(['f08-ok-fin'])]]),
  });
  try {
    assert.equal(f.doc.querySelector(`.${P}-error`), null, 'a well-formed record is not a corruption');
  } finally { f.stop(); }
});

// ------------------------------------------------------------------ F03
async function toHome(f) {
  f.area.setAttribute('data-testid', HOME);
  await f.tick();
}
async function toUnknown(f) {
  f.area.setAttribute('data-testid', 'settings-page');
  await f.tick();
}
// Every history entry the client can currently reach, counted the way 1004.md measures it
// (`historyEntries=0, modalVisible=false`): a clickable entry plus an openable modal.
function historyEntries(f) {
  return f.doc.querySelectorAll('[data-act="history"]');
}
const modalOpen = (f) => {
  const m = f.doc.getElementById(MODAL);
  return !!m && m.style.display === 'flex';
};

for (const [label, go] of [['home', toHome], ['unknown', toUnknown]]) {
  test(`F03 MMX: a fresh ${label} route with no current session still has a global-history entry`, async () => {
    // "fresh" = no run was ever watched, so the card pool is empty even before the route
    // guard removes the host, and there is no current session at all.
    const f = await boot('mmx', { runs: [], options: { watched: false } });
    try {
      await go(f);
      assert.equal(f.sandbox.__mmxDwfInternals.currentSessionId(), '', 'this case never had a current session');

      const entries = historyEntries(f);
      assert.ok(entries.length > 0, `the ${label} route must still expose the global-history entry`);
      entries[0].dispatch('click');
      await f.flush();
      assert.ok(modalOpen(f), 'the entry opens the existing history modal — no second modal is invented');
      await f.flush();
      assert.match(f.doc.querySelector('.mmxdwf-mbody').textContent, /还没有任何运行|全局历史/);
    } finally { f.stop(); }
  });

  test(`F03 MMX: the ${label} entry closes and reopens, and never auto-mounts a terminal card`, async () => {
    const f = await boot('mmx', {
      runs: [run('f03-' + label, 'completed')],
      options: { watched: false },
    });
    try {
      await go(f);
      assert.equal(f.doc.querySelector('[data-mmxdwf-card]'), null,
        'guard: a finished run is never auto-mounted as a card on a non-conversation route');
      assert.equal(f.doc.getElementById(P + '-run-card'), null, 'the card host itself stays gone');

      historyEntries(f)[0].dispatch('click');
      await f.flush();
      assert.ok(modalOpen(f));

      f.doc.querySelector('[data-act="mclose"]').dispatch('click');
      assert.equal(modalOpen(f), false, 'the modal closes');

      // guard: 关闭 modal 后须有重开入口
      const again = historyEntries(f);
      assert.ok(again.length > 0, 'after closing the modal there must still be a way back in');
      again[0].dispatch('click');
      await f.flush();
      assert.ok(modalOpen(f), 'and it reopens the same history modal');
      await f.flush();
      assert.ok(f.doc.querySelector('.mmxdwf-hrow'), 'the global list is reachable from the home route too');
    } finally { f.stop(); }
  });

  test(`F03 MMX: the ${label} entry button is the SAME node across polls (focus restore depends on it)`, async () => {
    // Regression guard for a real defect found in review: mountGlobalEntry() used to rebuild
    // `innerHTML` on every sweepCard(), so the 2s poll replaced the button node. The F07 focus
    // restore then focused a DETACHED opener and the restore silently degraded to <body>.
    const f = await boot('mmx', {
      runs: [run('f03-stable-' + label, 'completed')],
      options: { watched: false },
    });
    try {
      await go(f);
      const first = historyEntries(f)[0];
      assert.ok(first, 'the entry is mounted');
      assert.equal(first.isConnected, true, 'and attached to the document');

      // Several poll cycles, as the 2s interval really produces.
      for (let i = 0; i < 5; i++) await f.tick();
      const after = historyEntries(f)[0];
      assert.equal(after === first, true,
        'the button node must survive repeated polls — a rebuilt node would make closeModal()'
        + ' focus a detached opener, i.e. a no-op that drops focus on <body>');
      assert.equal(after.isConnected, true, 'and the surviving node is still connected');

      // The behaviour that actually broke: open from the entry, close, focus comes back.
      first.focus();
      first.dispatch('click');
      await f.flush();
      assert.ok(modalOpen(f));
      f.doc.querySelector('[data-act="mclose"]').dispatch('click');
      assert.equal(f.doc.activeElement === first, true,
        'F07 guard: closing the dialog returns focus to the very node the user clicked');
    } finally { f.stop(); }
  });
}

test('F03 MMX: the conversation route keeps its own entries and the home entry never leaks there', async () => {
  const f = await boot('mmx', { runs: [run('f03-conv', 'running')], options: { watched: false } });
  try {
    await f.tick();
    const before = historyEntries(f).length;
    assert.ok(before > 0, 'the conversation route already has its card-foot history pill');
    await toHome(f);
    const after = historyEntries(f).length;
    assert.ok(after > 0, 'and the home route has one of its own');
    // Returning to the conversation must not stack a duplicate of the home entry.
    f.area.setAttribute('data-testid', 'message-list');
    await f.tick();
    assert.equal(historyEntries(f).length, before, 'no duplicate entry is left behind on the conversation route');
  } finally { f.stop(); }
});
