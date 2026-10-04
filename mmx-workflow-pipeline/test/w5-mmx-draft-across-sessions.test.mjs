// test/w5-mmx-draft-across-sessions.test.mjs — 1004.md §4 W5, MMX half: F02.
//
//   F02 (中) A→B→A 同 document 切换丢失首次提交前草稿。
//        触发边界（原文）：运行、问题、identity+startedAt 均不变；可靠识别 B 后 A 卡片离池
//        卸载，回 A 新节点 `value=""`，`answerPosts=0`。普通刷新保留原节点。
//        **不是整页重载/运行消失/新生命周期。**
//
//        Root cause re-checked against the CURRENT source (client-inject.js):
//          * `controlsFor(run)` is keyed by identity and rebuilt on a startedAt change — the
//            "分代 controls" 1004.md points at. It only ever stored an answer record, and one
//            is created when the user CLICKS 回答. An unsubmitted draft lived only in the DOM
//            `input.value`.
//          * `sweepCard()` removes every card that left the pool
//            (`current.forEach(card => card.remove())`), so switching the current session from A
//            to B unmounts A's card and destroys that DOM-only value; coming back to A builds a
//            fresh node from `cardHtml`, where `answer` is undefined and the attribute renders
//            as `value=""`.
//          * Nothing was ever POSTed, so `answerPosts` is 0 both before and after — the loss is
//            invisible to the run, the question, the identity and the epoch.
//
// The fix must be INSIDE the existing generation-scoped controls, via input delegation, with
// the draft restored when the card is re-mounted. Guards kept (1004.md):
//   不取消会话过滤        -> A's card must still be absent while B is current (asserted)
//   不增加持久化依赖      -> the draft never reaches localStorage (asserted)
//   普通刷新保留原节点    -> the existing pool-refresh behaviour is asserted here too
//
// No third-party dependency, no host, no fixed Temp name, no real engine: the shared harness
// (test/lib/w2-client-harness.mjs) owns the DOM/fetch doubles and the fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run, waiting } from './lib/w2-client-harness.mjs';

const P = 'mmxdwf';
const SESSION_STATE_KEY = 'mavis:activeSessionId';
const BINDINGS_KEY = 'mmxdwf-session-bindings';
const mvsId = (c) => 'mvs_' + c.repeat(32);
const SESS_A = mvsId('a');
const SESS_B = mvsId('b');

// The host's own per-tab session state is read per call, so the same swap the W4 suite uses
// lets one fixture move the active conversation A -> B -> A without reloading the document.
function setHostSession(api, sid) {
  const store = new Map([[SESSION_STATE_KEY, sid]]);
  api.sandbox.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

// Two runs, each already attributed to its own session, so the current session is the ONLY
// thing deciding which card is in the pool (sessionPool(): bound runs are filtered by cur).
function seeded(aQ) {
  return new Map([[BINDINGS_KEY, JSON.stringify({
    'w5-a': { host: 'mmx', source: 'mmx-picker', sessionId: SESS_A },
    'w5-b': { host: 'mmx', source: 'mmx-picker', sessionId: SESS_B },
  })]]);
}
const runA = () => run('w5-a', 'running', { questions: [waiting('q1', '要继续吗？')] });
const runB = () => run('w5-b', 'running', { questions: [waiting('q1', 'B 的问题')] });
const card = (f, id) => f.doc.querySelector('[data-' + P + '-card][data-run="' + id + '"]');
const input = (f, id) => {
  const c = card(f, id);
  return c ? c.querySelectorAll('[data-act="qinput"]')[0] : null;
};

test('F02 MMX: a draft typed before submitting survives an A→B→A conversation switch', async () => {
  const f = await boot('mmx', { runs: [runA(), runB()], storage: seeded() });
  try {
    setHostSession(f, SESS_A);
    await f.tick();
    const typed = input(f, 'w5-a');
    assert.ok(typed, 'session A shows its own card');

    // Type the draft but DO NOT submit. 1004.md's trigger is exactly this: a value that only
    // ever reached the DOM input.
    typed.value = '第一次提交前写的草稿';
    typed.dispatch('input');
    assert.equal(f.posts('/answer?'), 0, 'typing must not submit anything');

    // A -> B: A's card leaves the pool and is unmounted.
    setHostSession(f, SESS_B);
    await f.tick();
    assert.equal(card(f, 'w5-a'), null, 'A leaves the pool while B is the current session');
    assert.ok(card(f, 'w5-b'), 'B is the one in the pool');

    // B -> A: a NEW node is built for A (the run, the question, the identity and the epoch are
    // all unchanged — this is not a reload and not a new lifecycle).
    setHostSession(f, SESS_A);
    await f.tick();
    const back = input(f, 'w5-a');
    assert.ok(back, 'A is back');
    assert.ok(back !== typed, 'the card really was re-mounted from a fresh node');
    assert.equal(back.value, '第一次提交前写的草稿', 'the unsubmitted draft must come back with it');
    assert.equal(f.posts('/answer?'), 0, 'and nothing was ever submitted on the user\'s behalf');

    // The epoch and the question are untouched by the round trip.
    const q = f.sandbox.__mmxDwfInternals;
    assert.equal(q.currentSessionId(), SESS_A);
    assert.equal(q.identity(runA()), 'w5-a', 'identity is unchanged');
    assert.equal(runA().startedAt, '2026-10-05T00:00:00.000Z', 'the lifecycle epoch is unchanged');

    // The restored draft is a real draft, not a locked submitted state: it can be submitted.
    back.closest('[data-' + P + '-card]').querySelectorAll('[data-act="answer"]')[0].dispatch('click');
    await f.flush();
    assert.equal(f.posts('/answer?'), 1, 'the restored draft is submittable exactly once');
  } finally { f.stop(); }
});

test('F02 MMX: the guard — session filtering is not cancelled by draft preservation', async () => {
  const f = await boot('mmx', { runs: [runA(), runB()], storage: seeded() });
  try {
    setHostSession(f, SESS_A);
    await f.tick();
    input(f, 'w5-a').value = '只属于 A 的草稿';
    input(f, 'w5-a').dispatch('input');
    setHostSession(f, SESS_B);
    await f.tick();
    assert.equal(card(f, 'w5-a'), null, "another session's card still never leaks into this view");
    assert.equal(f.doc.querySelectorAll('[data-' + P + '-card]').length, 1, 'only B is rendered');
    // Coming back is still filtered by the CURRENT session, not by "something was typed".
    setHostSession(f, SESS_B);
    await f.tick();
    assert.equal(card(f, 'w5-a'), null);
    setHostSession(f, SESS_A);
    await f.tick();
    assert.ok(card(f, 'w5-a'));
    assert.equal(card(f, 'w5-b'), null);
  } finally { f.stop(); }
});

test('F02 MMX: the guard — a draft is not a new persistence dependency', async () => {
  const storage = seeded();
  const f = await boot('mmx', { runs: [runA(), runB()], storage });
  try {
    setHostSession(f, SESS_A);
    await f.tick();
    // Snapshot AFTER boot: the harness seeds the pre-existing visible-runs key itself, and
    // that write is not this test's concern. What must not happen is a NEW key appearing (or a
    // draft string reaching ANY key) because a draft was typed.
    const before = [...storage.entries()];
    input(f, 'w5-a').value = '只活在内存里的草稿';
    input(f, 'w5-a').dispatch('input');
    setHostSession(f, SESS_B); await f.tick();
    setHostSession(f, SESS_A); await f.tick();
    const added = [...storage.keys()].filter((k) => !before.some(([bk]) => bk === k));
    assert.deepEqual(added, [], 'no new storage key may be introduced to carry a draft');
    for (const [k, v] of storage) {
      assert.equal(String(v).includes('只活在内存里的草稿'), false, `draft leaked into ${k}`);
    }
  } finally { f.stop(); }
});

test('F02 MMX: an ordinary pool refresh still keeps the SAME input node (no regression)', async () => {
  // 1004.md: 普通刷新保留原节点. The existing suite covers this per progress update; this case
  // pins it next to the new behaviour, because a draft rendered into the markup (instead of
  // delegated through the control) would replace the node on every keystroke and drop focus.
  let current = [runA()];
  const f = await boot('mmx', { runs: current, storage: seeded(), server: { runs: () => current } });
  try {
    setHostSession(f, SESS_A);
    await f.tick();
    const el = input(f, 'w5-a');
    el.value = '正在输入中';
    el.focus();
    el.setSelectionRange(1, 3);
    el.dispatch('input');
    current = [{ ...runA(), updatedAt: '2026-10-05T00:00:09.000Z', logs: [{ text: '后台进度' }] }];
    await f.tick();
    const now = input(f, 'w5-a');
    assert.ok(now === el, 'the input node must survive its own progress update');
    assert.equal(now.value, '正在输入中');
    assert.equal(f.sandbox.__mmxDwfInternals.identity(runA()), 'w5-a');
  } finally { f.stop(); }
});

test('F02 MMX: drafts are per-question and do not bleed across questions', async () => {
  // 'w5-two' is bound to SESS_A so it genuinely leaves the pool on the A->B switch; an unbound
  // LIVE run stays in the pool for every session and would never exercise a re-mount.
  const f = await boot('mmx', {
    runs: [run('w5-two', 'running', { questions: [waiting('q1', '第一问'), waiting('q2', '第二问')] })],
    storage: new Map([[BINDINGS_KEY, JSON.stringify({
      'w5-two': { host: 'mmx', source: 'mmx-picker', sessionId: SESS_A },
    })]]),
  });
  try {
    setHostSession(f, SESS_A);
    await f.tick();
    const inputs = card(f, 'w5-two').querySelectorAll('[data-act="qinput"]');
    assert.equal(inputs.length, 2);
    inputs[0].value = '只写第一问';
    inputs[0].dispatch('input');
    setHostSession(f, SESS_B); await f.tick();
    assert.equal(card(f, 'w5-two'), null, 'the card really left the pool');
    setHostSession(f, SESS_A); await f.tick();
    const back = card(f, 'w5-two').querySelectorAll('[data-act="qinput"]');
    assert.equal(back[0].value, '只写第一问', 'the q1 draft is restored');
    assert.equal(back[1].value, '', 'q2 was never typed into');
  } finally { f.stop(); }
});
