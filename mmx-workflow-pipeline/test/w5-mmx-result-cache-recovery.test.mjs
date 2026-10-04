// test/w5-mmx-result-cache-recovery.test.mjs — 1004.md §4 W5, MMX half: F04.
//
//   F04 (中) 暂态结果失败被永久化为当前 key 内的空预览缓存。
//        触发边界（原文）：首次预览 HTTP 非 2xx / 解析失败 / `body.ok` 假时写空缓存；记录持续
//        存在，成功 `/runs` 轮询不重试（`resultRequests=1, preview=null`），手动全文成功不回填。
//        fetch 本身 reject 会重试；**404 有意负缓存应保留**。
//
//   Root cause re-checked against the CURRENT source (client-inject.js hydrateResults):
//     `apiFetch('/result?…')` collapses every non-2xx into `null` (`res.ok ? json() : null`),
//     every parse failure into `null` (`json().catch(() => null)`) and an explicit
//     `ok:false` into `b.ok` false — and all three land on the SAME branch, which writes
//     `resultCache.set(id, { key, text: '' })`. Because the cache is consulted by
//     `cached.key === key` and the key contains only (identity, startedAt, updatedAt, status),
//     a settled terminal run never changes key again: the empty entry is permanent for the whole
//     lifecycle, and no later /runs poll can retry it. A manual 结果 read succeeds but never
//     writes the cache, so it cannot repair the card either.
//
//   最小改法 (1004.md): 区分 404 与可恢复 5xx/解析错误，用现有轮询做有界退避；手动成功读取可回填
//   当前有效 key。No new timer, no new framework: the backoff is counted in /runs poll ticks.
//
//   安全 guard 保持:
//     * 不把正常引擎先写 out 再写终态的行为判为缺陷  -> a LIVE run is never hydrated at all,
//       and the moment it goes terminal the very next poll reads the out.json that is already
//       there (case 6 below). The engine's write ordering stays invisible to this change.
//     * key 变更 / 新客户端可解除                     -> a new (identity|startedAt|updatedAt|
//       status) key drops the backoff record and retries immediately (case 5).
//     * 404 有意负缓存应保留                          -> case 2: exactly one request, forever.
//
// No third-party dependency, no host, no fixed Temp name, no real engine: the shared harness
// (test/lib/w2-client-harness.mjs) owns the DOM/fetch doubles and the fake clock. The /result
// responder is installed by overriding the sandbox fetch — the same technique client-lifecycle
// uses. The fixture therefore boots with an EMPTY run list (the harness runs one tick during
// boot, before any override can be installed) and the run under test is introduced afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run } from './lib/w2-client-harness.mjs';

const P = 'mmxdwf';
const previewOf = (f, id) => {
  const c = f.doc.querySelector('[data-' + P + '-card][data-run="' + id + '"]');
  const r = c ? c.querySelectorAll('.' + P + '-result')[0] : null;
  return r ? r.textContent : null;
};

// Boot with the run LIVE, then take over /result. A live run is always in the card pool but is
// never hydrated (hydrateResults returns early for isLive), so the harness's boot tick cannot
// burn a /result request before the override is installed; each test then flips the SAME run to
// 'completed', which is exactly the transition that makes hydration start. Keeping the harness's
// own visible-runs seeding out of the picture is deliberate — a seed written into the Map after
// boot is already too late (the client reads the key once, at init).
async function armed(replies, runId) {
  const live = run(runId, 'running');
  const f = await boot('mmx', { runs: [live], options: { watched: false } });
  const real = f.sandbox.fetch;
  let n = 0;
  f.sandbox.fetch = (url, opts) => {
    if (!String(url).includes('/result?')) return real(url, opts);
    const r = replies[Math.min(n++, replies.length - 1)];
    if (r === 'reject') return Promise.reject(new TypeError('network error'));
    if (r.unparseable) return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) });
    if (r.text) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, out: { result: r.text } }) });
    return Promise.resolve({ ok: r.status === 200, status: r.status, json: async () => ({ ok: false, error: r.error || 'boom' }) });
  };
  // Flip the same run terminal: identity and startedAt are unchanged, so the lifecycle key the
  // client caches under is the one a real settled run has.
  const finish = async (extra = {}) => { f.setRuns([{ ...live, status: 'completed', ...extra }]); await f.tick(); };
  return { f, calls: () => n, finish, live };
}

test('F04 MMX: a transient 500 is not frozen into the lifecycle key as an empty preview', async () => {
  const { f, calls, finish } = await armed([
    { status: 500, error: 'out.json is corrupt' },
    { status: 500, error: 'out.json is corrupt' },
    { text: '恢复后的完整结果' },
  ], 'f04-500');
  try {
    await finish();
    assert.equal(previewOf(f, 'f04-500'), null, 'the first failure shows no preview at all');
    assert.equal(calls(), 1);

    // The record still exists and the lifecycle key is unchanged, so only a RETRY can recover.
    await f.tick(); await f.tick(); await f.tick();
    assert.ok(calls() >= 2, 'a settled terminal run must be retried, not served from an empty cache forever');
    assert.match(previewOf(f, 'f04-500') || '', /恢复后的完整结果/,
      'the recovered out.json reaches the card once the host answers again');
  } finally { f.stop(); }
});

test('F04 MMX: an unparseable 2xx result body is treated as transient, not as a negative cache', async () => {
  const { f, calls, finish } = await armed([{ unparseable: true }, { unparseable: true }, { text: '解析恢复' }], 'f04-parse');
  try {
    await finish(); await f.tick(); await f.tick(); await f.tick();
    assert.ok(calls() >= 2, 'a truncated body must not permanently cache an empty preview');
    assert.match(previewOf(f, 'f04-parse') || '', /解析恢复/);
  } finally { f.stop(); }
});

test('F04 MMX: an explicit body {ok:false} on a 2xx is transient too', async () => {
  const { f, calls, finish } = await armed([{ status: 200, error: 'run not finished writing' }, { text: '补齐后' }], 'f04-okfalse');
  try {
    await finish(); await f.tick(); await f.tick();
    assert.ok(calls() >= 2);
    assert.match(previewOf(f, 'f04-okfalse') || '', /补齐后/);
  } finally { f.stop(); }
});

test('F04 MMX: a fetch-level reject still retries (the pre-existing behaviour is kept)', async () => {
  const { f, calls, finish } = await armed(['reject', 'reject', { text: '网络恢复' }], 'f04-reject');
  try {
    await finish(); await f.tick(); await f.tick(); await f.tick();
    assert.ok(calls() >= 2, 'a dead socket was already retryable and must stay so');
    assert.match(previewOf(f, 'f04-reject') || '', /网络恢复/);
  } finally { f.stop(); }
});

test('F04 MMX: guard — a 404 stays negatively cached, fetched exactly once', async () => {
  const { f, calls, finish } = await armed([{ status: 404, error: 'run has no out.json yet' }], 'f04-404');
  try {
    await finish();
    for (let i = 0; i < 5; i++) await f.tick();
    assert.equal(calls(), 1, '1004.md: 404 有意负缓存应保留 — the 5000+/day refetch must not come back');
    assert.equal(previewOf(f, 'f04-404'), null, 'and no result section is rendered for a resultless run');
    assert.ok(f.doc.querySelector('[data-run="f04-404"]'), 'the card itself still renders');
  } finally { f.stop(); }
});

test('F04 MMX: guard — a key change lifts the backoff and retries immediately', async () => {
  const { f, calls, finish, live } = await armed([{ status: 500, error: 'transient' }, { status: 500, error: 'transient' }, { text: '换 key 后' }], 'f04-key');
  try {
    await finish({ updatedAt: '2026-10-05T00:00:01.000Z' });
    const before = calls();
    // A new updatedAt is a new lifecycle key: the backoff record must not gate the next read.
    f.setRuns([{ ...live, status: 'completed', updatedAt: '2026-10-05T00:00:07.000Z' }]);
    await f.tick();
    assert.ok(calls() > before, 'a changed key retries at once rather than waiting out a backoff');
    // The new key starts its own backoff from zero, so the very next poll may read again.
    await f.tick();
    assert.match(previewOf(f, 'f04-key') || '', /换 key 后/);
  } finally { f.stop(); }
});

test('F04 MMX: a successful manual 结果 read backfills the current valid key', async () => {
  const live = run('f04-manual', 'running');
  const f = await boot('mmx', { runs: [live], options: { watched: false } });
  try {
    // Hydration keeps failing; the user opens the full result, which succeeds.
    let manual = false;
    const real = f.sandbox.fetch;
    f.sandbox.fetch = (url, opts) => {
      if (!String(url).includes('/result?')) return real(url, opts);
      if (!manual) return Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: 'transient' }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, out: { result: '手动全文读到的结果' } }) });
    };
    f.setRuns([{ ...live, status: 'completed' }]);
    await f.tick();
    assert.equal(previewOf(f, 'f04-manual'), null, 'nothing is cached yet');

    manual = true;
    f.doc.querySelector('[data-run="f04-manual"]').querySelectorAll('[data-act="result"]')[0].dispatch('click');
    await f.flush();
    assert.match(f.doc.querySelector('.mmxdwf-mbody').textContent, /手动全文读到的结果/, 'the modal shows the real result');

    // The successful manual read must repair the CARD for the same key — no relaunch, no reload.
    await f.tick();
    assert.match(previewOf(f, 'f04-manual') || '', /手动全文读到的结果/,
      'a manual full read backfills the current key instead of leaving the empty cache in place');
  } finally { f.stop(); }
});

test('F04 MMX: guard — the engine writing out.json before the terminal state is not a defect', async () => {
  // A LIVE run is never hydrated (hydrateResults returns early for isLive), so the engine's
  // "out.json first, terminal state second" ordering is invisible here; the very first poll
  // after the run goes terminal reads the out.json that is already on disk.
  const { f, calls, finish, live } = await armed([{ text: '引擎先写 out' }], 'f04-order');
  try {
    await f.tick();
    assert.equal(calls(), 0, 'a live run is never asked for its result');
    await finish();
    assert.equal(calls(), 1, 'the first poll after the terminal state reads it exactly once');
    assert.match(previewOf(f, 'f04-order') || '', /引擎先写 out/);
  } finally { f.stop(); }
});

test('F04 MMX: a permanently failing host stops being hammered — the backoff is BOUNDED', async () => {
  const { f, calls, finish } = await armed([{ status: 503, error: 'service unavailable' }], 'f04-bounded');
  try {
    await finish();
    for (let i = 0; i < 39; i++) await f.tick();
    const n = calls();
    // Bounded, but not a single request: a long outage must still get several chances to
    // recover on its own. The bound is a ceiling on the request rate, not a hard stop.
    assert.ok(n >= 3, 'the retry still gets several bounded attempts, got ' + n);
    assert.ok(n < 20, 'but it must not degrade back into refetching every poll, got ' + n + ' requests in 40 polls');
  } finally { f.stop(); }
});

test('F04 MMX: the backoff is driven by the existing poll, so no new timer is introduced', async () => {
  const { f, calls, finish } = await armed([{ status: 500, error: 'transient' }], 'f04-timer');
  try {
    await finish();
    for (let i = 0; i < 4; i++) await f.tick();
    // Backoff is counted in poll ticks, so a couple of polls in a row buy at most a couple of
    // requests. If a real timer were involved, firing none would change nothing — the point is
    // that the pacing comes from the poll the client already runs.
    assert.ok(calls() <= 4, 'requests are paced by the poll, got ' + calls() + ' in 5 polls');
    assert.ok(f.timers.filter((t) => !t.cleared).length === 0, 'the fix arms no timer of its own');
  } finally { f.stop(); }
});
