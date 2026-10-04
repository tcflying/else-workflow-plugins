// test/w5-dsh-global-history-entry.test.mjs — 1004.md §4 W5, DSH half, F12 (中).
//
//   F12 (中) 卡片池为空且没有可核实的 current 会话时，全局历史入口整个消失。
//        The global history entry lives INSIDE the card host, and the host was torn down
//        whenever the pool was empty and no current session was provable. With a viewArea
//        present, online, and no persistence warning, a host that only has UNWATCHED FINISHED
//        runs produced `historyEntryCount === 0` — and stayed 0 on the next poll, so the only
//        route to a finished run was gone and could not be recovered without a reload.
//
//   The document's minimal fix: 「viewArea 内全局历史入口不依赖 current 或 pick 数」.
//   This test drives the TERMINAL-ONLY shape the document asks for (no live run is mixed in,
//   so a live card could never have kept the host alive) and pins the two guards:
//
//     * 保留无身份禁绑定        — with no provable current, binding is still refused: the
//                                 history modal's 绑定当前会话 button stays disabled and no
//                                 card appears, so nothing is ever attributed to a session we
//                                 cannot name.
//     * 【不恢复】自动认领最新 finished run 的全局卡片回退 — the finished run itself must NOT
//                                 acquire a card. Fixing the ENTRY must not resurrect the old
//                                 global fallback, so `[data-dwf-card]` count stays 0.
//
// The host still disappears when there is genuinely nothing to point at (no run at all), and
// the offline / persistence-warning banners keep their existing behaviour.
//
// Fake clock only, own fetch double, no host, no third-party dependency, no fixed Temp name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run } from './lib/w2-client-harness.mjs';
import { bootWithCurrent } from './w5-dsh-with-session-boot.mjs';

const P = 'dwf';
const bannerOf = (f) => f.doc.querySelector(`[data-${P}-banner]`);
// Only the card-OUTSIDE entry counts here: a card's own 历史 foot button is per-run and exists
// only when that run is in the pool, so it is not the global entry F12 is about.
const bannerHistoryEntries = (f) => (bannerOf(f) ? bannerOf(f).querySelectorAll('[data-act="history"]') : []);
const historyEntries = (f) => f.doc.querySelectorAll('[data-act="history"]');
const cardCount = (f) => f.doc.querySelectorAll(`[data-${P}-card]`).length;

// A finished run the user was NOT watching live: sessionPool() keeps only bound runs, live
// runs and already-watched ones, so this run is outside the pool by design. `watched: false`
// stops the harness from seeding the visible-runs record the client itself would have written.
const terminal = () => [run('f12-term', 'completed')];

test('F12 DSH: an unwatched finished run alone still leaves a global history entry in the viewArea', async () => {
  const f = await boot('dsh', { runs: terminal(), options: { watched: false } });
  assert.equal(f.storage.get('dwf-pipeline-visible-runs'), undefined, 'precondition: the run was never watched');
  assert.equal(cardCount(f), 0, 'precondition: a finished run that was never watched is not in the card pool');
  assert.ok(f.area, 'precondition: a viewArea exists to host the entry');

  const entries = historyEntries(f);
  assert.equal(entries.length, 1, 'the global history entry must exist even with an empty pool and no current session');
  const banner = bannerOf(f);
  assert.ok(banner, 'the entry must live in the viewArea banner, not only inside a card');
  assert.ok(
    banner.querySelectorAll('[data-act="history"]').length === 1,
    'the entry must be reachable from the card-outside banner',
  );
});

test('F12 DSH: the global history entry does not depend on the current session', async () => {
  // The harness boots the client with NO ctx.sessions at all (the same host shape the pre-fix
  // report used), so currentSessionId() is ''. The entry must not care — and the session-scoped
  // wording, which renders only when a current session IS provable, must not appear.
  const f = await boot('dsh', { runs: terminal(), options: { watched: false } });
  assert.equal(bannerHistoryEntries(f).length, 1, 'no provable current session must not remove the entry');
  assert.doesNotMatch(
    bannerOf(f).textContent,
    /当前会话暂无绑定的运行/,
    'with no current session the entry must not claim a session context',
  );
});

test('F12 DSH: the global history entry does not depend on the pick count', async () => {
  // Same run shape, but the pick count differs between the two boots (0 here). The
  // card-outside entry must be present in both, which is what 「不依赖 pick 数」 means.
  const f0 = await boot('dsh', { runs: terminal(), options: { watched: false } });
  const f1 = await boot('dsh', {
    runs: [run('f12-live', 'running')],
    options: { watched: false },
  });
  assert.equal(cardCount(f0), 0, 'precondition: empty pool');
  assert.ok(cardCount(f1) >= 1, 'precondition: this boot really does have a card in the pool');
  assert.equal(bannerHistoryEntries(f0).length, 1, 'an empty pool still offers the global entry');
  assert.equal(bannerHistoryEntries(f1).length, 1, 'a non-empty pool offers the same global entry');
});

test('F12 DSH: the entry survives a second poll instead of being removed again', async () => {
  const f = await boot('dsh', { runs: terminal(), options: { watched: false } });
  assert.equal(historyEntries(f).length, 1);
  await f.tick();
  assert.equal(historyEntries(f).length, 1, 'a second poll must not tear the entry down again');
  await f.tick();
  assert.equal(historyEntries(f).length, 1, 'nor a third');
  assert.equal(historyEntries(f).length, cardCount(f) + 1, 'exactly one global entry, and it is not a card button');
});

test('F12 DSH: the entry opens the global history modal and lists the finished run', async () => {
  const f = await boot('dsh', { runs: terminal(), options: { watched: false } });
  historyEntries(f)[0].dispatch('click');
  await f.flush();
  const modal = f.doc.getElementById('dwf-modal');
  assert.ok(modal, 'the entry must open the existing history modal');
  const rows = f.doc.querySelectorAll('.dwf-hrow');
  assert.equal(rows.length, 1, 'the global history modal lists the finished run');
  assert.match(f.doc.querySelector('.dwf-hname').textContent, /f12-term/);
});

test('F12 DSH (guard): with no provable identity the finished run is not auto-claimed into a card', async () => {
  const f = await boot('dsh', { runs: terminal(), options: { watched: false } });
  // 【不恢复】自动认领最新 finished run 的全局卡片回退.
  assert.equal(cardCount(f), 0, 'fixing the entry must NOT give the finished run a global card');
  assert.equal(f.storage.get('dwf-pipeline-visible-runs'), undefined, 'and it must not be recorded as watched');
});

test('F12 DSH (guard): binding is still refused while no identity is provable', async () => {
  const f = await boot('dsh', { runs: terminal(), options: { watched: false } });
  historyEntries(f)[0].dispatch('click');
  await f.flush();
  const bind = f.doc.querySelector('[data-act="bindcurrent"]');
  assert.ok(bind, 'the history modal still offers the explicit bind action');
  assert.equal(bind.disabled, true, '无身份禁绑定: bind must stay disabled with no provable current session');
  // And no card ever appears carrying a bind pill, because no card is created at all.
  assert.equal(f.doc.querySelectorAll('[data-act="bind"]').length, 0);
});

test('F12 DSH: a host with no runs at all still renders nothing', async () => {
  // The fix must not turn the entry into permanent chrome. With nothing to point at there is
  // no entry, and the existing teardown (host removed, anchor position restored) still happens.
  const f = await boot('dsh', { runs: [], options: { watched: false } });
  assert.equal(f.doc.getElementById('dwf-run-card'), null, 'no card host is created when there is nothing to show');
  assert.equal(f.doc.querySelectorAll('[data-dwf-banner]').length, 0, 'and no empty banner is left behind');
  assert.equal(f.doc.querySelectorAll('[data-act="history"]').length, 0, 'and no history entry with nothing to point at');
});

test('F12 DSH: the offline banner still replaces the card pool and still carries its own entry', async () => {
  // The pre-existing behaviour must be intact: an offline host keeps the host alive even with
  // an empty pool. This is a regression pin, not a new requirement.
  const f = await boot('dsh', { runs: terminal(), options: { watched: false } });
  f.setRuns({ __spec: { status: 503, body: { ok: false, error: 'offline' } } });
  await f.tick();
  const offline = f.doc.querySelectorAll('.dwf-offline');
  assert.equal(offline.length, 1, 'an unreachable host still renders the offline banner');
  assert.equal(historyEntries(f).length, 1, 'and the global history entry is still there');
});

test('F12 DSH: the pre-existing current-session wording is unchanged', async () => {
  // A host that DOES expose ctx.sessions with an explicit `current`, and an empty pool: this is
  // the one shape that already worked, so the fix must not have altered it.
  const f = await bootWithCurrent('sess-1', [run('f12-cur', 'completed')]);
  const banner = bannerOf(f);
  assert.ok(banner, 'the banner still exists');
  assert.match(banner.textContent, /当前会话暂无绑定的运行/, 'the current-session wording is byte-identical to the pre-fix string');
  assert.match(banner.textContent, /打开全局历史绑定…/);
  assert.equal(banner.querySelectorAll('[data-act="history"]').length, 1, 'exactly one entry, no duplicate');
  assert.equal(f.doc.querySelectorAll('[data-dwf-card]').length, 0, 'and still no card for the unwatched finished run');
  f.stop();
});

test('F12 DSH: a provable current session alone never puts an unwatched finished run in the pool', async () => {
  // 保留无身份禁绑定 is the no-identity side; this is the other side of the same guard. A
  // current session is not a licence to auto-claim a finished run: the pool stays empty.
  const f = await bootWithCurrent('sess-1', [run('f12-claim', 'failed')]);
  assert.equal(f.doc.querySelectorAll('[data-dwf-card]').length, 0, 'no auto-claim of the newest finished run');
  assert.equal(f.storage.get('dwf-pipeline-visible-runs'), undefined, 'and it is never recorded as watched');
  assert.equal(bannerHistoryEntries(f).length, 1, 'the entry is the only thing that appeared');
  f.stop();
});

