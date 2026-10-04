// test/w2-mutation-result-state.test.mjs — 1004.md §4 W2, MMX half.
//
//   F18 (中) malformed HTTP 200 read as definite success. A truncated JSON body, a non-JSON
//        body or a 200 that lacks the explicit success field must NOT reach the success state:
//        answer -> not `submitted`, stop -> not `requested`, resume -> not `cooldown`. The
//        receipt is marked 结果未确认, the draft is kept and shown, and nothing is resent.
//        Controls the document requires: 200 {ok:false} and a truncated 502 are real answers.
//
//   F19 (中) after a lost receipt the control unlocks, so a SECOND POST can be emitted. A
//        socket that drops after the receiver already got the request is "may have executed,
//        result unknown" — not "rejected". The control stays locked, the draft and the visible
//        state stay, and the existing /runs poll reconciles epoch/qId.
//
//   F05 (中) no plugin-level bounded deadline covering fetch AND body. An unsettled /runs body
//        keeps pollInFlight true forever; an unsettled mutation keeps the control pending.
//        A native AbortController deadline covers both; a query deadline lands in the existing
//        offline feedback, a mutation deadline lands in 结果未确认 and never resends.
//
// Every test drives a fake clock (no real long timeout) and its own fetch double. No host, no
// production port, no third-party dependency, no fixed Temp name, no real engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run, waiting, SHAPES } from './lib/w2-client-harness.mjs';

const P = 'mmxdwf';
const card = (f, id) => f.doc.querySelector(`[data-${P}-card][data-run="${id}"]`);
const btn = (f, act, id) => card(f, id).querySelector(`[data-act="${act}"]`);

// The three malformed-200 shapes F18 names, plus the two controls the document requires.
const MALFORMED = [
  ['truncated JSON body', SHAPES.truncated],
  ['non-JSON body', SHAPES.nonJson],
  ['200 without an explicit ok:true', SHAPES.missingField],
];
const CONTROLS = [
  ['an explicit 200 {ok:false}', SHAPES.explicitFalse],
  ['a truncated 502', SHAPES.truncated502],
];

// ---------------------------------------------------------------- F18: answer
for (const [label, shape] of [...MALFORMED, ...CONTROLS]) {
  const malformed = !CONTROLS.some(([l]) => l === label);
  test(`F18 MMX: answer with ${label} never reaches the submitted state`, async () => {
    const q = run('q-run', 'running', { questions: [waiting()] });
    const f = await boot('mmx', { runs: [q], server: { post: () => shape } });
    f.doc.querySelector(`.${P}-qin`).value = '这份草稿不能丢';
    f.doc.querySelector('[data-act="answer"]').dispatch('click');
    await f.flush();
    const text = card(f, 'q-run').textContent;
    if (malformed) {
      assert.equal(f.doc.querySelector(`.${P}-qin`).disabled, false, 'an unconfirmed answer must not stay disabled as if submitted');
      assert.notEqual(f.doc.querySelector(`.${P}-qin`).placeholder, '已提交，等待工作流接收…');
      assert.match(text, /结果未确认/, 'an incomplete receipt must be reported as unconfirmed, not as a definite failure or success');
      assert.equal(f.doc.querySelector(`.${P}-qin`).value, '这份草稿不能丢', 'the draft must be kept');
      assert.equal(f.posts('/answer?'), 1, 'an unconfirmed answer must never be resent by itself');
    } else {
      assert.match(text, /提交失败|run is not accepting answers/);
    }
  });
}

// ---------------------------------------------------------------- F18: stop
for (const [label, shape] of [...MALFORMED, ...CONTROLS]) {
  const malformed = !CONTROLS.some(([l]) => l === label);
  test(`F18 MMX: stop with ${label} never reaches the requested state`, async () => {
    const f = await boot('mmx', { runs: [run('s-run', 'running')], server: { post: () => shape } });
    f.doc.querySelector('[data-act="stop"]').dispatch('click');
    await f.flush();
    const text = card(f, 's-run').textContent;
    if (malformed) {
      assert.doesNotMatch(text, /已发送停止请求，等待工作流确认/, 'only a complete receipt may claim the stop was requested');
      assert.match(text, /结果未确认/);
      assert.equal(btn(f, 'stop', 's-run').disabled, true, 'an unconfirmed stop must not be re-sendable by a second click');
      assert.equal(f.posts('/stop?'), 1);
    } else {
      assert.match(text, /停止失败|run is not accepting answers/);
    }
  });
}

// ---------------------------------------------------------------- F18: resume
for (const [label, shape] of [...MALFORMED, ...CONTROLS]) {
  const malformed = !CONTROLS.some(([l]) => l === label);
  test(`F18 MMX: resume with ${label} never reaches the 3s cooldown`, async () => {
    const f = await boot('mmx', { runs: [run('r-run', 'failed')], server: { post: () => shape } });
    f.doc.querySelector('[data-act="resume"]').dispatch('click');
    await f.flush();
    // A cooldown is a timed state: firing every timer must NOT re-enable a resume whose receipt
    // never confirmed. (Pre-fix this is exactly what happens — the 3s timer clears the lock.)
    await f.fireTimers();
    const text = card(f, 'r-run').textContent;
    if (malformed) {
      assert.match(text, /结果未确认/);
      assert.equal(btn(f, 'resume', 'r-run').disabled, true, 'an unconfirmed resume must not silently unlock after the cooldown timer');
      assert.equal(f.posts('/resume?'), 1);
    } else {
      assert.match(text, /恢复失败|run is not accepting answers/);
    }
  });
}

test('F18 MMX: a complete receipt still reaches submitted / requested / cooldown', async () => {
  const q = run('ok-run', 'running', { questions: [waiting()] });
  const f = await boot('mmx', {
    runs: [q, run('ok-stop', 'running'), run('ok-resume', 'failed')],
    server: { post: (u) => (u.includes('/resume') ? SHAPES.accepted : SHAPES.okTrue) },
  });
  f.doc.querySelector(`.${P}-qin`).value = '正常回答';
  f.doc.querySelector('[data-act="answer"]').dispatch('click');
  btn(f, 'stop', 'ok-stop').dispatch('click');
  btn(f, 'resume', 'ok-resume').dispatch('click');
  await f.flush();
  assert.equal(f.doc.querySelector(`.${P}-qin`).placeholder, '已提交，等待工作流接收…');
  assert.match(card(f, 'ok-stop').textContent, /已发送停止请求，等待工作流确认/);
  assert.equal(btn(f, 'resume', 'ok-resume').disabled, true, 'a confirmed resume holds the cooldown');
  await f.fireTimers();
  assert.equal(btn(f, 'resume', 'ok-resume').disabled, false, 'and the cooldown still expires');
});

// ---------------------------------------------------------------- F19
test('F19 MMX: a socket that drops after the receiver got the request cannot be sent twice', async () => {
  const q = run('drop-a', 'running', { questions: [waiting('q1')] });
  const f = await boot('mmx', { runs: [q, run('drop-stop', 'running'), run('drop-resume', 'failed')], server: { post: () => 'socket-drop' } });
  f.doc.querySelector(`.${P}-qin`).value = '已经送到对端的草稿';
  f.doc.querySelector('[data-act="answer"]').dispatch('click');
  btn(f, 'stop', 'drop-stop').dispatch('click');
  btn(f, 'resume', 'drop-resume').dispatch('click');
  await f.flush();
  // The user clicks again on every control, as a real user would.
  f.doc.querySelector('[data-act="answer"]').dispatch('click');
  btn(f, 'stop', 'drop-stop').dispatch('click');
  btn(f, 'resume', 'drop-resume').dispatch('click');
  await f.fireTimers();  // the 3s cooldown timer must not release an unconfirmed resume either
  await f.flush();
  assert.equal(f.posts('/answer?'), 1, 'answer: the request may already have been applied; a second POST must be impossible');
  assert.equal(f.posts('/stop?'), 1, 'stop: same');
  assert.equal(f.posts('/resume?'), 1, 'resume: same — a 8s-unconfirmed spawn is not evidence that nothing happened');
  assert.equal(f.doc.querySelector(`.${P}-qin`).value, '已经送到对端的草稿', 'the draft stays in the control and stays visible');
  assert.match(card(f, 'drop-resume').textContent, /结果未确认/);
});

test('F19 MMX: an unconfirmed answer is reconciled by the existing /runs poll, not by guessing', async () => {
  let current = [run('rec', 'running', { questions: [waiting('q1')] })];
  const f = await boot('mmx', { runs: current, server: { runs: () => current, post: () => 'socket-drop' } });
  f.doc.querySelector(`.${P}-qin`).value = '草稿';
  f.doc.querySelector('[data-act="answer"]').dispatch('click');
  await f.flush();
  assert.equal(f.doc.querySelector('[data-act="answer"]').disabled, true);

  // Same epoch, same qId still waiting: /runs cannot tell us anything, so the lock must hold.
  await f.tick();
  assert.equal(f.doc.querySelector('[data-act="answer"]').disabled, true, 'an unconfirmed answer stays locked while /runs cannot confirm it');

  // The engine consumed the question — /runs now shows the real outcome, so the lock releases.
  current = [run('rec', 'running', { questions: [{ qId: 'q1', question: '继续？', state: 'answered', answerPreview: '草稿' }] })];
  await f.tick();
  assert.equal(f.posts('/answer?'), 1);
});

test('F19 MMX: a definite rejection still unlocks immediately (it is not the unknown case)', async () => {
  const f = await boot('mmx', { runs: [run('rej', 'running')], server: { post: () => ({ status: 409, body: { ok: false, error: 'run is completed' } }) } });
  f.doc.querySelector('[data-act="stop"]').dispatch('click');
  await f.flush();
  assert.equal(btn(f, 'stop', 'rej').disabled, false, 'a definite refusal is a definite failure: the user may retry');
  assert.match(card(f, 'rej').textContent, /run is completed/);
  f.doc.querySelector('[data-act="stop"]').dispatch('click');
  await f.flush();
  assert.equal(f.posts('/stop?'), 2, 'a refused stop is safe to retry');
});

test('F19 MMX: RESUME_UNCONFIRMED from the host is the unknown case, not a refusal', async () => {
  const f = await boot('mmx', { runs: [run('unconf', 'failed')], server: { post: () => SHAPES.unconfirmed504 } });
  f.doc.querySelector('[data-act="resume"]').dispatch('click');
  await f.flush();
  assert.match(card(f, 'unconf').textContent, /结果未确认/);
  assert.equal(btn(f, 'resume', 'unconf').disabled, true);
  f.doc.querySelector('[data-act="resume"]').dispatch('click');
  await f.flush();
  assert.equal(f.posts('/resume?'), 1);
});

test('F19 MMX: an unconfirmed resume releases when /runs shows a new epoch took over', async () => {
  let current = [run('epoch', 'failed')];
  const f = await boot('mmx', { runs: current, server: { runs: () => current, post: () => 'socket-drop' } });
  f.doc.querySelector('[data-act="resume"]').dispatch('click');
  await f.flush();
  assert.equal(btn(f, 'resume', 'epoch').disabled, true);
  current = [run('epoch', 'failed', { startedAt: '2026-10-05T00:05:00.000Z' })];
  await f.tick();
  assert.equal(btn(f, 'resume', 'epoch').disabled, false, 'a new epoch is the confirmation: the control belongs to the old one and is released');
});

// ---------------------------------------------------------------- F05 (MMX only)
test('F05 MMX: an /runs body that never settles expires into the existing offline feedback', async () => {
  // The host answers normally first; the NEXT poll delivers headers and then stalls. That is
  // the exact wedge the document describes: pollInFlight stays true and no later poll runs.
  let stuck = false;
  const f = await boot('mmx', {
    runs: [run('q5', 'running')],
    server: { runs: () => (stuck ? { __spec: { status: 200, hangBody: true } } : [run('q5', 'running')]) },
  });
  assert.equal(f.doc.querySelector(`.${P}-offline`), null, 'nothing is wrong yet');
  stuck = true;
  await f.tick();
  assert.equal(f.doc.querySelector(`.${P}-offline`), null, 'still in flight, not yet expired');
  // The deadline is a fake-clock timer; no real wait happens here.
  await f.fireTimers();
  const banner = f.doc.querySelector(`.${P}-offline`);
  assert.ok(banner, 'an unsettled /runs body must end in the existing offline banner, not a silent wedge');
  assert.doesNotMatch(banner.textContent, /undefined|NaN/);
  // and the next poll is allowed to run again — pollInFlight was released
  stuck = false;
  await f.tick();
  assert.equal(f.doc.querySelector(`.${P}-offline`), null, 'the first good poll after the deadline clears offline');
});

test('F05 MMX: an unsettled mutation body expires as 结果未确认 and is never resent', async () => {
  const f = await boot('mmx', { runs: [run('m5', 'running', { questions: [waiting()] })], server: { post: () => ({ status: 200, hangBody: true }) } });
  f.doc.querySelector(`.${P}-qin`).value = '超时草稿';
  f.doc.querySelector('[data-act="answer"]').dispatch('click');
  await f.flush();
  assert.equal(f.doc.querySelector('[data-act="answer"]').disabled, true, 'pending while in flight');
  await f.fireTimers();
  assert.match(card(f, 'm5').textContent, /结果未确认/);
  f.doc.querySelector('[data-act="answer"]').dispatch('click');
  await f.flush();
  assert.equal(f.posts('/answer?'), 1, 'a timeout must never become an automatic resend');
  assert.equal(f.doc.querySelector(`.${P}-qin`).value, '超时草稿');
});

test('F05 MMX: the positive controls still recover — an explicit reject, and a new epoch', async () => {
  // (a) an explicit reject still unlocks and is still retryable
  const a = await boot('mmx', { runs: [run('pos-a', 'running')], server: { post: () => ({ status: 409, body: { ok: false, error: 'run is completed' } }) } });
  a.doc.querySelector('[data-act="stop"]').dispatch('click');
  await a.flush();
  assert.equal(btn(a, 'stop', 'pos-a').disabled, false);
  a.doc.querySelector('[data-act="stop"]').dispatch('click');
  await a.flush();
  assert.equal(a.posts('/stop?'), 2);

  // (b) a transport failure with no response at all is NOT a proof that nothing was applied —
  //     it is the unknown case, so it is locked exactly like a lost receipt. The only
  //     retryable outcome is a DEFINITE refusal (a), which is the point of the split.
  const b = await boot('mmx', { runs: [run('pos-b', 'running')], server: { post: () => { throw new Error('boom'); } } });
  b.doc.querySelector('[data-act="stop"]').dispatch('click');
  await b.flush();
  assert.match(card(b, 'pos-b').textContent, /结果未确认/);
  b.doc.querySelector('[data-act="stop"]').dispatch('click');
  await b.flush();
  assert.equal(b.posts('/stop?'), 1, 'a network error is never treated as "did not execute"');

  // (c) a new epoch still rebuilds the controls from scratch
  let current = [run('pos-c', 'failed')];
  const c = await boot('mmx', { runs: current, server: { runs: () => current, post: () => 'socket-drop' } });
  c.doc.querySelector('[data-act="resume"]').dispatch('click');
  await c.flush();
  assert.equal(btn(c, 'resume', 'pos-c').disabled, true);
  current = [run('pos-c', 'failed', { startedAt: '2026-10-05T00:09:00.000Z' })];
  await c.tick();
  assert.equal(btn(c, 'resume', 'pos-c').disabled, false);
});
