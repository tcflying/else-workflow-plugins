// test/w7-dsh-script-cache-eviction.test.mjs — 1004.md §4 W7, F14 (低, 可选优化).
//
//   F14 (低) DSH 脚本缓存没有 per-run/epoch 淘汰。
//        The module factory lives as long as the page. Every script the user actually read is
//        kept in `scriptCache` under `identity(run) + ':' + startedAt`, and NOTHING ever removed
//        an entry: `prunePerRunState()` — the existing per-run eviction that already drops
//        controls / log markers / result caches / visible ids — did not touch it. A run that
//        left the run list kept its text, and so did every epoch a run rotated through. The
//        document measured `runCount=0, entries=10, chars=81920` after ten epochs departed, and
//        showed a same-epoch remove-then-return still answering with only ONE GET — i.e. the
//        text outlived the run.
//
//        性质 (the document's own wording, kept here so the test cannot overclaim):
//        非持久内存缓存的低优先级优化。**字符长度不是堆内存字节数** — the fixture serves a short
//        fixed body, so these tests assert ENTRY CONVERGENCE (a cache hit is only possible while
//        an entry survives) and REUSE SEMANTICS, never a byte or heap-size claim.
//
//   最小改法 (the document's): 仅在现有 prune 按当前 identity+startedAt 淘汰离列表/轮换条目。
//   Guards pinned below:
//     * 有效 epoch 复用        — a run that STAYS in the list still answers a repeat open from
//                                cache (one GET), so the fix costs nothing on the happy path.
//     * 迟到响应 guard         — a /script response whose modal view was superseded is still
//                                dropped, and still writes no entry.
//     * 不加 TTL 框架/定时器   — the eviction rides the existing poll; no timer is armed.
//     * 不删持久用户状态       — bindings / dismissed survive the prune untouched.
//   「新 epoch 会重新 GET」 is pre-existing behaviour, kept as an explicit control so a
//   regression in the reuse path cannot hide behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run } from './lib/w2-client-harness.mjs';

const ID = 'f14-run';
const EPOCH = (i) => new Date(Date.UTC(2026, 9, 5, 0, 0, 0) + i * 1000).toISOString();
const live = (id, startedAt) => run(id, 'running', { startedAt });

// The script cell is the only writer/reader of the cache, and it only exists on a card, so
// the card is also the proof that the run is in the list the prune reads.
const cardOf = (f, id) => f.doc.getElementById('dwf-run-card')?.querySelector(`[data-run="${id}"]`) || null;
const scriptGets = (f) => f.requestLog.filter((r) => r.url.includes('/script?')).length;

async function openScriptOf(f, id) {
  const card = cardOf(f, id);
  assert.ok(card, `precondition: the run card for ${id} is in the card pool`);
  const btn = card.querySelector('[data-act="script"]');
  assert.ok(btn, `precondition: the card for ${id} exposes a 脚本 button`);
  btn.dispatch('click');
  await f.flush();
  return f;
}
// Move the host to exactly this run list, through one real poll (the prune's only trigger).
async function setList(f, runs) {
  f.setRuns(runs);
  await f.tick();
  return f;
}

test('F14 DSH: a fresh module factory reads a script once (the document 反证 baseline)', async () => {
  const f = await boot('dsh', { runs: [live(ID, EPOCH(1))] });
  await openScriptOf(f, ID);
  assert.equal(scriptGets(f), 1, 'precondition: the first open of a run reads its script once');
  await openScriptOf(f, ID);
  assert.equal(scriptGets(f), 1, 'precondition: a repeat open of the same live epoch is served from the cache');
});

test('F14 DSH (guard): a run that stays in the list still reuses its script for the same epoch', async () => {
  // 有效 epoch 复用 — the cost of the fix on the happy path must be zero: many polls, many
  // opens, one GET. The fix only removes entries for epochs the list no longer carries.
  const f = await boot('dsh', { runs: [live(ID, EPOCH(1))] });
  await openScriptOf(f, ID);
  for (let i = 0; i < 3; i++) {
    await f.tick();
    await openScriptOf(f, ID);
  }
  assert.equal(scriptGets(f), 1, 'the same epoch is read once and reused while the run is listed');
});

test('F14 DSH: a run that leaves the list does not keep its script text cached', async () => {
  const f = await boot('dsh', { runs: [live(ID, EPOCH(1))] });
  await openScriptOf(f, ID);
  assert.equal(scriptGets(f), 1, 'precondition: the script was read once');

  await setList(f, []);                                   // the run left the list; prune runs
  await setList(f, [live(ID, EPOCH(1))]);                 // …and came back with the SAME identity+epoch
  await openScriptOf(f, ID);

  assert.equal(
    scriptGets(f), 2,
    '离列表条目必须淘汰: same identity + same epoch after leaving the list is read again, not answered from the cache',
  );
});

test('F14 DSH: an epoch that rotated does not keep the previous epoch text cached', async () => {
  const f = await boot('dsh', { runs: [live(ID, EPOCH(1))] });
  await openScriptOf(f, ID);
  assert.equal(scriptGets(f), 1);

  await setList(f, [live(ID, EPOCH(2))]);                 // same run, new lifecycle
  await openScriptOf(f, ID);
  assert.equal(scriptGets(f), 2, 'control (pre-existing behaviour): a new epoch is always read again');

  // Rotate BACK to the epoch read first. A new epoch was a miss anyway, so this open is the
  // one that can only miss if the rotated-away entry was evicted.
  await setList(f, [live(ID, EPOCH(1))]);
  await openScriptOf(f, ID);
  assert.equal(
    scriptGets(f), 3,
    '轮换条目必须淘汰: the epoch that rotated away was dropped, so returning to it is a read, not a stale hit',
  );
});

test('F14 DSH: ten departed epochs leave no reusable text behind (entries converge)', async () => {
  // The document's 实测形态 (runCount=0, entries=10, chars=81920) with an honest substitution:
  // the fixture body is a short fixed string, so byte volume proves nothing. What IS measurable
  // is the entry count: a cache HIT is only possible while an entry survives, so "every departed
  // epoch is read again" is exactly "zero entries survived".
  const N = 10;
  const f = await boot('dsh', { runs: [live(ID, EPOCH(0))] });

  for (let i = 0; i < N; i++) {
    await setList(f, [live(ID, EPOCH(i))]);
    await openScriptOf(f, ID);
    await setList(f, []);                                 // every epoch leaves the list
  }
  assert.equal(scriptGets(f), N, 'precondition: each listed epoch was read exactly once');

  for (let i = 0; i < N; i++) {
    await setList(f, [live(ID, EPOCH(i))]);
    await openScriptOf(f, ID);
    await setList(f, []);
  }
  assert.equal(
    scriptGets(f), N * 2,
    '十条离列表 epoch 全部重新读取: no departed epoch was still cached, so retained entries converge to 0',
  );
});

test('F14 DSH (guard): the prune adds no timer and no TTL of its own', async () => {
  // 定时器可注入，但修法本身不许引入它们：淘汰挂在已经存在的轮询上。
  const f = await boot('dsh', { runs: [live(ID, EPOCH(1))] });
  await openScriptOf(f, ID);
  await setList(f, []);
  await setList(f, [live(ID, EPOCH(2))]);
  await openScriptOf(f, ID);
  assert.equal(f.timers.length, 0, 'eviction rides the existing poll: no setTimeout was armed');
  assert.equal(f.intervals.length, 1, 'and the single existing poll interval is untouched');
});

test('F14 DSH (guard): pruning the script cache does not touch bindings or dismissed state', async () => {
  // 不删除 bindings/dismissed 等持久用户状态 — these are the user's own records and are NOT
  // per-run scratch state, so a run-list prune must leave them byte-identical.
  const bound = { sessionId: 'sess-legacy', runId: 'f14-legacy', name: 'f14-legacy', savedAt: EPOCH(0) };
  const store = new Map([['dwf-session-bindings', JSON.stringify({ 'f14-legacy': bound })]]);
  const f = await boot('dsh', { runs: [live(ID, EPOCH(1)), run('f14-closed', 'completed')], storage: store });

  const closed = cardOf(f, 'f14-closed');
  assert.ok(closed, 'precondition: the finished run the user already watches has a card');
  closed.querySelector('[data-act="close"]').dispatch('click');   // the client writes dismissed itself
  assert.deepEqual(JSON.parse(store.get('dwf-pipeline-dismissed')), ['f14-closed'], 'precondition: dismissed was written');

  await openScriptOf(f, ID);
  assert.equal(scriptGets(f), 1);
  await setList(f, []);                                          // both runs leave; prune runs

  // Raw-string comparison: the persisted record must be BYTE-identical, which is exactly the
  // claim 不删除 bindings/dismissed 等持久用户状态 makes.
  assert.strictEqual(store.get('dwf-session-bindings'), JSON.stringify({ 'f14-legacy': bound }), 'bindings must survive the prune byte-identical');
  assert.strictEqual(store.get('dwf-pipeline-dismissed'), JSON.stringify(['f14-closed']), 'dismissed must survive the prune byte-identical');
  assert.strictEqual(store.get('dwf-pipeline-visible-runs'), JSON.stringify([]), 'the existing visible-id prune is unchanged');
});

test('F14 DSH (guard): a late /script response for a superseded view is still dropped', async () => {
  // 迟到响应 guard 不得回归. Two live runs, two opens with no flush in between: the first
  // response lands after the modal moved to the second run, so it must be dropped — including
  // its cache write, which is exactly what makes the observable below a miss rather than a hit.
  const A = 'f14-late-a', B = 'f14-late-b';
  const f = await boot('dsh', { runs: [live(A, EPOCH(1)), live(B, EPOCH(1))] });
  const btn = (id) => cardOf(f, id).querySelector('[data-act="script"]');
  btn(A).dispatch('click');
  btn(B).dispatch('click');
  await f.flush();
  assert.equal(scriptGets(f), 2, 'precondition: both views issued their own read');

  await openScriptOf(f, A);
  assert.equal(scriptGets(f), 3, 'the superseded response wrote no cache entry, so A is read again');
  await openScriptOf(f, A);
  assert.equal(scriptGets(f), 3, 'and the valid epoch it just read is reused normally');
});
