// test/ui-isolation-fixture-result.test.mjs — proves the UI-isolation fixture actually GIVES THE
// CLIENT something to render, without rendering anything.
//
// THE DEFECT THIS PINS: a finished fixture writes out.json with findings/report at the TOP LEVEL
// only. Both client result paths read out.error / out.result and nothing else:
//   * client-inject.js openResult()  -> out.error !== undefined ? error text
//                                        : out.result !== undefined ? JSON.stringify(out.result)
//                                        : '(无 result 字段)'
//   * client-inject.js previewOfOut() -> out.result !== undefined ? JSON.stringify(out.result)
//                                        : out.error ? String(out.error) : ''
// so a click on the result entry WOULD render "(无 result 字段)" and the card WOULD have no
// preview — derived from those expressions alone. Inferred from source; no real GUI click has
// been performed. fixtureOut() now also publishes the same honest static content under `result`,
// and still fakes no `error`.
//
// WHAT THIS IS NOT: this is a SOURCE-level contract over pure builders. It is NOT a GUI acceptance
// run. No DOM is constructed, no PNG, no screenshot, no host instance, no CDP, no API call, and no
// fixture is written to disk. This test calls only the pure builders — writeFixture(), the CLI and
// the module main are never invoked — and nothing here proves a real workflow ran. (The node test
// runner is itself a process; this describes this test's own calls only, not the whole runner.)
//
// EXPECTATIONS ARE FIXED LITERALS on purpose: they are written out here rather than imported from
// the module under test, so a changed label/phase/field cannot silently redefine its own
// expectation. (The literals are the authorised non-business marker and the two phase names.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureOut, fixtureProgress, fixtureState, fixtureCalls } from './iso/iso-fixture.mjs';

// ---- fixed expectations (NOT taken from the module under test) ----------------
const NOTE = 'UI隔离验收fixture（非业务运行）';
const PHASE_1 = `${NOTE}·阶段1·只读DOM取证`;
const PHASE_2 = `${NOTE}·阶段2·卡片渲染核对`;
const LABEL_A = `${NOTE}·任务A-探测message-list`;
const LABEL_B = `${NOTE}·任务B-核对阶段与子任务`;
const RUN_A = 'ui-iso-fixture-result-0001';
const RUN_B = 'ui-iso-fixture-result-0002';
const STARTED_AT = '2026-01-01T00:00:00.000Z';
const FINISHED_STAGES = ['completed', 'failed'];

// Read-only mirrors of the two production expressions, so the assertions describe which branch those
// source expressions would select; not a GUI observation. Copying the expression here does not
// modify the client.
const clientResultModalText = (out) => (out && out.error !== undefined ? 'error: ' + String(out.error)
  : out && out.result !== undefined ? JSON.stringify(out.result, null, 2) : '(无 result 字段)');
const clientCardPreview = (out) => {
  const raw = out && out.result !== undefined
    ? (typeof out.result === 'string' ? out.result : JSON.stringify(out.result))
    : out && out.error ? String(out.error) : '';
  return raw.length > 1200 ? raw.slice(0, 1200) + '…（已截断，点击查看全文）' : raw;
};

test('a finished fixture publishes the standard result object both client paths read', () => {
  for (const stage of FINISHED_STAGES) {
    const out = fixtureOut({ fixtureId: RUN_A, stage });
    const result = out.result;
    assert.equal(typeof result, 'object', `${stage}: out.result must be an object`);
    assert.notEqual(result, null, `${stage}: out.result must not be null`);
    assert.equal(result.fixture, true, `${stage}: result.fixture`);
    assert.equal(result.nonBusiness, true, `${stage}: result.nonBusiness`);
    assert.equal(result.note, NOTE, `${stage}: result.note must carry the non-business marker`);
    assert.equal(result.runId, RUN_A, `${stage}: result.runId is this fixture's own id`);
    assert.equal(result.status, stage, `${stage}: result.status must report the stage it was written for`);
    assert.equal(out.status, stage, `${stage}: top-level status stays the stage`);
  }
});

test('result body carries the static findings and the non-business report', () => {
  for (const stage of FINISHED_STAGES) {
    const { result } = fixtureOut({ fixtureId: RUN_A, stage });
    assert.ok(Array.isArray(result.findings), `${stage}: result.findings must be an array`);
    assert.equal(result.findings.length, 2, `${stage}: two static findings`);
    for (const finding of result.findings) {
      assert.equal(finding.severity, 'info', `${stage}: a fixture never claims a real severity`);
      assert.ok(finding.title.startsWith(NOTE), `${stage}: finding title must carry the marker`);
      assert.ok(typeof finding.detail === 'string' && finding.detail.length > 0, `${stage}: finding detail`);
    }
    assert.equal(typeof result.report, 'string', `${stage}: result.report`);
    assert.ok(result.report.includes(NOTE), `${stage}: report must carry the non-business marker`);
    assert.ok(result.report.includes('非业务运行'), `${stage}: report must say it is not a business run`);
  }
});

test('result carries no business identity and no engine execution evidence', () => {
  for (const stage of FINISHED_STAGES) {
    const { result } = fixtureOut({ fixtureId: RUN_A, stage });
    // No pid / hostSession / engine fields may ever appear in fixture result material: a fixture is
    // static display content, and a live-looking identity here would be a forged business record.
    assert.equal('pid' in result, false, `${stage}: result must not carry a pid`);
    assert.equal('hostSession' in result, false, `${stage}: result must not carry a hostSession`);
    assert.equal('engine' in result, false, `${stage}: result must not carry an engine field`);
    assert.equal(JSON.stringify(result).includes('"pid"'), false, `${stage}: no pid anywhere in result JSON`);
  }
});

test('no error is fabricated in place of a result', () => {
  for (const stage of FINISHED_STAGES) {
    const out = fixtureOut({ fixtureId: RUN_A, stage });
    assert.equal(out.error, undefined, `${stage}: a fixture must not fake out.error`);
    assert.equal('error' in out, false, `${stage}: out must not even carry an error key`);
    assert.equal('error' in out.result, false, `${stage}: result must not carry an error key`);
  }
});

test('the result modal can no longer fall through to "(无 result 字段)"', () => {
  for (const stage of FINISHED_STAGES) {
    const out = fixtureOut({ fixtureId: RUN_A, stage });
    const text = clientResultModalText(out);
    assert.notEqual(text, '(无 result 字段)', `${stage}: the modal must have something to show`);
    assert.ok(!text.startsWith('error: '), `${stage}: the modal must not take the error branch`);
    assert.ok(text.includes(RUN_A), `${stage}: the modal text must show this run's id`);
    assert.ok(text.includes(NOTE), `${stage}: the modal text must show the non-business marker`);
    assert.ok(text.includes('"nonBusiness": true'), `${stage}: the modal text must show the flag`);
    assert.ok(text.includes(`"status": "${stage}"`), `${stage}: the modal text must show the stage status`);
  }
});

test('the card preview shows this run id and the non-business marker, not an empty string', () => {
  for (const stage of FINISHED_STAGES) {
    const preview = clientCardPreview(fixtureOut({ fixtureId: RUN_B, stage }));
    assert.notEqual(preview, '', `${stage}: the card must get a non-empty preview`);
    assert.ok(preview.includes(RUN_B), `${stage}: preview must name this fixture, not another run`);
    assert.ok(preview.includes(NOTE), `${stage}: preview must carry the non-business marker`);
  }
  // Identity must follow the argument: two fixtures must not be able to show each other's id.
  const other = clientCardPreview(fixtureOut({ fixtureId: RUN_A, stage: 'completed' }));
  assert.ok(other.includes(RUN_A) && !other.includes(RUN_B), 'each fixture renders only its own id');
});

test('a live fixture has task A settled and task B running, phase 1 at 1/1 and phase 2 at 0/1', () => {
  const calls = fixtureCalls('live', STARTED_AT);
  assert.equal(calls.length, 2, 'live fixture has two static calls');
  assert.equal(calls[0].callId, 'q001-fixture01');
  assert.equal(calls[0].label, LABEL_A);
  assert.equal(calls[0].phase, PHASE_1);
  assert.equal(calls[0].state, 'done', 'task A is the completed one');
  assert.equal(calls[1].callId, 'q001-fixture02');
  assert.equal(calls[1].label, LABEL_B);
  assert.equal(calls[1].phase, PHASE_2);
  assert.equal(calls[1].state, 'running', 'task B is the running one');
  assert.equal('settledAt' in calls[1], false, 'a running call has no settledAt');

  const progress = fixtureProgress({ fixtureId: RUN_A, stage: 'live', startedAt: STARTED_AT });
  assert.equal(progress.status, 'running');
  assert.equal(progress.dispatched, 2);
  assert.equal(progress.settled, 1);
  assert.equal(progress.failed, 0);
  assert.deepEqual(progress.phases.map((p) => p.name), [PHASE_1, PHASE_2]);
  assert.deepEqual(progress.phases.map((p) => p.dispatched), [1, 1]);
  assert.deepEqual(progress.phases.map((p) => p.settled), [1, 0], 'phase 2 is 0/1 while task B runs');
  assert.deepEqual(progress.phases.map((p) => p.failed), [0, 0]);
  assert.equal('finishedAt' in progress, false, 'a running fixture has no finishedAt');
  assert.equal('resultPreview' in progress, false, 'a running fixture claims no result');

  const state = fixtureState({ fixtureId: RUN_A, stage: 'live', startedAt: STARTED_AT, dir: 'unused-in-this-test' });
  assert.equal(state.status, 'running');
  assert.equal(state.agentDispatched, 2);
  assert.equal(state.agentSettled, 1);
  assert.equal(state.agentFailed, 0);
  assert.deepEqual(state.phases, [PHASE_1, PHASE_2]);
  assert.equal('finishedAt' in state, false, 'a running fixture state has no finishedAt');
});

test('a completed fixture has both tasks done and both phases at 1/1', () => {
  const calls = fixtureCalls('completed', STARTED_AT);
  assert.deepEqual(calls.map((c) => c.label), [LABEL_A, LABEL_B]);
  assert.deepEqual(calls.map((c) => c.state), ['done', 'done']);
  assert.deepEqual(calls.map((c) => c.phase), [PHASE_1, PHASE_2]);
  for (const call of calls) {
    assert.equal(call.startedAt, STARTED_AT);
    assert.equal(call.settledAt, STARTED_AT, 'a fixture invents no elapsed time');
  }

  const progress = fixtureProgress({ fixtureId: RUN_A, stage: 'completed', startedAt: STARTED_AT });
  assert.equal(progress.status, 'completed');
  assert.equal(progress.dispatched, 2);
  assert.equal(progress.settled, 2);
  assert.equal(progress.failed, 0);
  assert.deepEqual(progress.phases.map((p) => p.settled), [1, 1], 'both phases are 1/1');
  assert.deepEqual(progress.phases.map((p) => p.dispatched), [1, 1]);
  assert.deepEqual(progress.phases.map((p) => p.failed), [0, 0]);
  assert.equal(progress.currentPhase, PHASE_2, 'a finished run rests on its last phase');
  assert.equal(progress.finishedAt, STARTED_AT);
  assert.equal(progress.resultPreview.startsWith(NOTE), true, 'the card preview is marked non-business');

  const state = fixtureState({ fixtureId: RUN_A, stage: 'completed', startedAt: STARTED_AT, dir: 'unused-in-this-test' });
  assert.equal(state.status, 'completed');
  assert.equal(state.agentSettled, 2);
  assert.equal(state.agentFailed, 0);
  assert.equal(state.finishedAt, STARTED_AT);
});

test('a failed fixture reports the failure honestly instead of pretending success', () => {
  const calls = fixtureCalls('failed', STARTED_AT);
  assert.deepEqual(calls.map((c) => c.state), ['done', 'failed']);

  const progress = fixtureProgress({ fixtureId: RUN_A, stage: 'failed', startedAt: STARTED_AT });
  assert.equal(progress.status, 'failed');
  assert.equal(progress.failed, 1);
  assert.deepEqual(progress.phases.map((p) => p.settled), [1, 1], 'a failed call still settled its phase');
  assert.deepEqual(progress.phases.map((p) => p.failed), [0, 1]);

  const { result } = fixtureOut({ fixtureId: RUN_A, stage: 'failed' });
  assert.equal(result.status, 'failed', 'the result reports the failure, not a success');
  assert.equal(result.nonBusiness, true, 'and it stays marked non-business');
  assert.ok(result.report.includes(NOTE));
});

test('the same startedAt is preserved across every stage of one lifecycle', () => {
  const stages = ['live', 'completed', 'failed'];
  const seen = [];
  for (const stage of stages) {
    const progress = fixtureProgress({ fixtureId: RUN_A, stage, startedAt: STARTED_AT });
    const state = fixtureState({ fixtureId: RUN_A, stage, startedAt: STARTED_AT, dir: 'unused-in-this-test' });
    assert.equal(progress.startedAt, STARTED_AT, `${stage}: progress.startedAt must not be re-minted`);
    assert.equal(state.startedAt, STARTED_AT, `${stage}: state.startedAt must not be re-minted`);
    assert.equal(progress.runId, RUN_A, `${stage}: the lifecycle keeps one runId`);
    assert.equal(state.runId, RUN_A, `${stage}: the lifecycle keeps one runId in state`);
    for (const call of fixtureCalls(stage, STARTED_AT)) {
      assert.equal(call.startedAt, STARTED_AT, `${stage}: call ${call.callId} startedAt must not move`);
      if ('settledAt' in call) {
        assert.equal(call.settledAt, STARTED_AT, `${stage}: call ${call.callId} settledAt must not move`);
      }
    }
    const { result } = fixtureOut({ fixtureId: RUN_A, stage });
    assert.equal(result.runId, RUN_A, `${stage}: the result keeps the same runId`);
    seen.push(progress.status);
  }
  // Identity is the (runId, startedAt) pair, so advancing the stage may change the status only.
  assert.deepEqual(seen, ['running', 'completed', 'failed']);
});

test('the existing top-level fixture fields are kept and mirrored into result', () => {
  for (const stage of FINISHED_STAGES) {
    const out = fixtureOut({ fixtureId: RUN_A, stage });
    // Backward compatibility: readers that already consume the top-level shape keep working.
    assert.equal(out.fixture, true);
    assert.equal(out.nonBusiness, true);
    assert.equal(out.note, NOTE);
    assert.equal(out.runId, RUN_A);
    assert.equal(Array.isArray(out.findings), true);
    assert.equal(typeof out.report, 'string');
    // ...and the mirror must not drift: the same body is what both client paths read.
    assert.deepEqual(out.result.findings, out.findings, `${stage}: findings must not drift`);
    assert.equal(out.result.report, out.report, `${stage}: report must not drift`);
    for (const key of ['fixture', 'nonBusiness', 'note', 'runId', 'status']) {
      assert.equal(out.result[key], out[key], `${stage}: ${key} must not drift`);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(out)).result, out.result, `${stage}: result must survive JSON transport`);
  }
});