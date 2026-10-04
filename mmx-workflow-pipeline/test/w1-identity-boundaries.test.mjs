// test/w1-identity-boundaries.test.mjs — 1004.md §4 W1 (MMX host half).
//
//   F16  state.cwd must not be a movable trust base: the addressed run entry has to BE the run
//        directory the engine will really act on (<state.cwd>/.qoder/workflow-runs/<runId>).
//   F17  SPEC §2.2 item 1: a >2s state/progress generation gap stays fail-closed on /stop and
//        /answer; a normal millisecond skew is not a handoff.
//   F15  a cached runKey must be re-checked against the real run directory at the cache hit AND
//        immediately before a write, so a path swapped for a junction cannot be written through.
//
// Guard limits these tests deliberately keep enforced, quoted from 1004.md §4 W1:
//   F16  "不顺便全面禁止 workspace 外脚本" — the binding is a single realpath equality, and the
//        self-bound / cwd-less positive control below asserts a normal run still reaches the
//        engine spawn, so a cwd outside the scan roots (the engine's global archive) is not
//        banned; nor is this a new global transaction framework — it is one per-entry identity
//        comparison performed before the existing guards.
//   F17  "明确这不是跨进程全局事务" — the check compares the two files' own timestamps at the final
//        snapshot; the 1,999ms control asserts a normal millisecond skew is not a handoff.
//   F15  "不把再次 realpath 说成对外部文件系统竞争的原子保证" — the re-check is re-verified at a point
//        in time; the refresh case asserts a refreshed registry stays authoritative, i.e. the
//        re-check never turns into a blanket ban on the swapped path.
//
// Every test builds its own fs.mkdtempSync(os.tmpdir(), '<unique>-') subtree and removes it in
// t.after. No fixed Temp name, no production host, no third-party dependency, no git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostApi } from '../sidecar.mjs';

const DEAD_PID = 2147483647;                 // never a live pid: a resumable/cancellable fixture
const CAPABILITY = 'w1-mmx-test-capability-0123456789abcdef';
const iso = (ms) => new Date(ms).toISOString();
const listDir = (dir) => readdirSync(dir).sort();
const snapshot = (dir) => listDir(dir).map((name) => name + ':' + readFileSync(join(dir, name), 'utf8')).join('|');

// A run directory: <workspace>/.qoder/workflow-runs/<runId>/{state,progress,script}
// state.startedAt and progress.startedAt are separate knobs: F17 is exactly the case where the
// engine's two files carry a different generation stamp.
function writeRun(dir, { runId, cwd, status = 'running', pid = process.pid, startedAt, stateStartedAt, progressStartedAt, questions = [], artifacts = [], script = 'return 1;', scriptPath = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const state = {
    runId, status, cwd, pid, backend: 'file',
    startedAt: stateStartedAt || startedAt,
    scriptPath: scriptPath || join(dir, 'script.mjs'),
  };
  const progress = {
    runId, name: 'n-' + runId, cwd, cwdBase: 'ws', backend: 'file', status,
    phases: [], calls: [], dispatched: 0, settled: 0, failed: 0, rejected: 0, logs: [],
    questions, artifacts,
    startedAt: progressStartedAt || startedAt, updatedAt: progressStartedAt || startedAt,
  };
  writeFileSync(join(dir, 'progress.json'), JSON.stringify(progress));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'script.mjs'), script);
  return { state, progress };
}

function sandbox(t, prefix, watch = []) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(async () => {
    // A rejected-before-write path must leave nothing behind; a red run may have let the engine
    // claim a run, so never leave a child process holding a temp tree open.
    for (const dir of watch) {
      let st; try { st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); } catch { continue; }
      if (Number.isInteger(st.pid) && st.pid > 0 && st.pid !== process.pid) { try { process.kill(st.pid); } catch {} }
    }
    removeTree(root);
  });
  return root;
}

// Windows cleanup: a junction inside the subtree makes a plain recursive delete give up, so
// unlink every reparse point first (unlinking a junction never touches its target), then delete.
function removeTree(root) {
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true, recursive: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    try { rmSync(join(entry.parentPath || entry.path, entry.name), { force: true }); } catch {}
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function hostFor(t, roots) {
  const api = createHostApi({ roots, quiet: true, capability: CAPABILITY });
  await new Promise((done, fail) => { api.server.once('error', fail); api.server.listen(0, '127.0.0.1', done); });
  t.after(() => api.close());
  const H = () => ({ 'x-workflow-capability': CAPABILITY });
  const url = (p, params = {}) => 'http://127.0.0.1:' + api.server.address().port + p + '?' + new URLSearchParams(params);
  return { api, H, url, runs: async () => (await (await fetch(url('/runs'), { headers: H() })).json()).runs };
}

// swapRunDir: the registered path is renamed aside (preserved, OUTSIDE the scanned runs
// directory so the post-swap registry still holds exactly one run) and a junction to `target`
// takes its place, so the real identity behind the registered path is now a different directory.
function swapRunDir(dir, target, keep) {
  mkdirSync(join(keep, '..'), { recursive: true });
  renameSync(dir, keep);
  symlinkSync(target, dir, 'junction');
}

// Pick the registered run by identity, never by array position: after a junction swap the runs
// directory can hold more than one directory carrying the same runId, and readdir order is not
// a contract. Fails loudly if the registry is not the single expected entry.
async function onlyRunKey(h, runId) {
  const runs = await h.runs();
  const match = runs.filter((r) => r.runId === runId);
  assert.equal(match.length, 1, 'exactly one registered run carries this runId');
  return match[0].runKey;
}

// ---- F16 -------------------------------------------------------------------

test('F16: a state.cwd that addresses another workspace is refused on read and on resume, with zero writes', async (t) => {
  const tmp = sandbox(t, 'mmxw1-f16-');
  const bDir = join(tmp, 'B', '.qoder', 'workflow-runs', 'shared-run-id');
  const A = join(tmp, 'A');
  const aDir = join(A, '.qoder', 'workflow-runs', 'shared-run-id');
  const runId = 'shared-run-id';
  const started = iso(Date.now() - 60000);
  const script = "export const meta = { name: 'f16-b', description: 'B SCRIPT BODY' };\nreturn 1;\n";

  // B is a resumable run carrying the SAME runId; A is the only scanned workspace and its
  // state.cwd points at B. A is addressed, B is what the engine would really resume.
  writeRun(bDir, { runId, cwd: join(tmp, 'B'), status: 'failed', pid: DEAD_PID, startedAt: started, script });
  // The artifact path resolves against the run WORKSPACE (state.cwd = B), not the run directory:
  // a body parked inside the run directory is 404 in every implementation and the leak assertion
  // below would then be true by construction instead of detecting the leak.
  writeFileSync(join(join(tmp, 'B'), 'secret.txt'), 'B ARTIFACT BODY');
  writeRun(aDir, {
    runId, cwd: join(tmp, 'B'), status: 'failed', pid: DEAD_PID, startedAt: started, script,
    scriptPath: join(bDir, 'script.mjs'),
    artifacts: [{ kind: 'file', path: 'secret.txt', title: 'B artifact' }],
  });
  t.after(() => {
    let st; try { st = JSON.parse(readFileSync(join(bDir, 'state.json'), 'utf8')); } catch { return; }
    if (Number.isInteger(st.pid) && st.pid > 0 && st.pid !== process.pid) { try { process.kill(st.pid); } catch {} }
  });

  const h = await hostFor(t, [A]);
  const key = await onlyRunKey(h, runId);
  const bBefore = snapshot(bDir);
  const aBefore = listDir(aDir);

  // 1. reads that resolve a path through state.cwd must not serve the other workspace
  const scriptRes = await fetch(h.url('/script', { run: key }), { headers: h.H() });
  assert.equal(scriptRes.status, 409, '/script must refuse a run whose state.cwd leaves the addressed entry');
  assert.equal((await scriptRes.json()).code, 'RUN_DIR_MISMATCH');
  const artRes = await fetch(h.url('/artifact', { run: key, index: '0' }), { headers: h.H() });
  assert.equal(artRes.status, 409, '/artifact containment must be refused, not widened to the other workspace');
  assert.equal((await artRes.text()).includes('B ARTIFACT BODY'), false, "B's artifact body must never be served");

  // 2. resume must not touch B and must not write anything on the A side (not even the log)
  const resumeRes = await fetch(h.url('/resume', { run: key, startedAt: started }), { method: 'POST', headers: h.H() });
  assert.equal(resumeRes.status, 409);
  assert.equal((await resumeRes.json()).code, 'RUN_DIR_MISMATCH');
  assert.equal(snapshot(bDir), bBefore, "B's state/progress must be byte-identical after the refusal");
  assert.deepEqual(listDir(aDir), aBefore, 'A must gain no file, not even pipeline-resume.log');
});

test('F16: a run bound to its own directory is not refused, and a legacy state without cwd still resolves', async (t) => {
  const tmp = sandbox(t, 'mmxw1-f16pos-');
  const ws = join(tmp, 'A');
  const dir = join(ws, '.qoder', 'workflow-runs', 'self-bound');
  const legacyDir = join(join(tmp, 'L'), 'proj', '.qoder', 'workflow-runs', 'legacy');
  const started = iso(Date.now() - 60000);
  const script = "export const meta = { name: 'f16-pos', description: 'OWN SCRIPT BODY' };\nreturn 1;\n";

  const selfBound = writeRun(dir, {
    runId: 'self-bound', cwd: ws, status: 'failed', pid: DEAD_PID, startedAt: started, script,
    artifacts: [{ kind: 'file', path: 'report.md', title: 'Report' }],
  });
  writeFileSync(join(ws, 'report.md'), '# OWN ARTIFACT BODY');
  // A legacy state.json without cwd: the runs root is derived from the addressed directory, which
  // is the same fallback the resume spawn uses, so it must not be refused either.
  writeRun(legacyDir, { runId: 'legacy', cwd: join(tmp, 'L', 'proj'), status: 'failed', pid: DEAD_PID, startedAt: started, script });
  const legacyState = JSON.parse(readFileSync(join(legacyDir, 'state.json'), 'utf8'));
  delete legacyState.cwd;
  writeFileSync(join(legacyDir, 'state.json'), JSON.stringify(legacyState));

  const h = await hostFor(t, [ws, join(tmp, 'L')]);
  const runs = await h.runs();
  const key = runs.find((r) => r.runId === 'self-bound').runKey;
  const legacyKey = runs.find((r) => r.runId === 'legacy').runKey;

  const scriptRes = await fetch(h.url('/script', { run: key }), { headers: h.H() });
  assert.equal(scriptRes.status, 200, 'a self-bound run must keep serving its own script');
  assert.match(await scriptRes.text(), /OWN SCRIPT BODY/);
  const artRes = await fetch(h.url('/artifact', { run: key, index: '0' }), { headers: h.H() });
  assert.equal(artRes.status, 200, 'a self-bound run must keep serving its own artifact');
  assert.equal(await artRes.text(), '# OWN ARTIFACT BODY');
  assert.equal((await fetch(h.url('/script', { run: legacyKey }), { headers: h.H() })).status, 200, 'a state without cwd must not be refused');

  // The resume guard is not over-broad. The binding check is the FIRST check resumeRun performs,
  // so pointing the script at a missing file makes the request get PAST it and be answered by the
  // next, pre-existing rule instead. A refused run would answer 409 RUN_DIR_MISMATCH. Nothing is
  // spawned, so this case stays deterministic and leaves no child or resume log behind.
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...selfBound.state, scriptPath: join(dir, 'missing-script.mjs') }));
  const resumed = await fetch(h.url('/resume', { run: key, startedAt: started }), { method: 'POST', headers: h.H() });
  const resumedBody = await resumed.json();
  assert.notEqual(resumedBody.code, 'RUN_DIR_MISMATCH', 'a self-bound run must not be refused by the run-dir binding guard');
  assert.equal(resumed.status, 409, JSON.stringify(resumedBody));
  assert.match(String(resumedBody.error || ''), /readable|missing|script/i);
  assert.equal(existsSync(join(dir, 'pipeline-resume.log')), false, 'the request must be answered before the spawn, not after');
});

// ---- F17 -------------------------------------------------------------------

test('F17: a 30,000ms state/progress generation gap fails closed on stop and answer; 1,999ms still passes', async (t) => {
  const tmp = sandbox(t, 'mmxw1-f17-');
  const now = Date.now();
  const questions = [{ qId: 'q1', question: '确认', state: 'waiting' }];
  const far = join(tmp, 'far', '.qoder', 'workflow-runs', 'f17-far');
  const near = join(tmp, 'near', '.qoder', 'workflow-runs', 'f17-near');
  // state.json and progress.json both stable and both live during the request; only the
  // generation distance differs: 30,000ms (must be refused) and 1,999ms (must be accepted).
  writeRun(far, { runId: 'f17-far', cwd: join(tmp, 'far'), status: 'running', pid: process.pid, stateStartedAt: iso(now), progressStartedAt: iso(now - 30000), questions });
  writeRun(near, { runId: 'f17-near', cwd: join(tmp, 'near'), status: 'running', pid: process.pid, stateStartedAt: iso(now), progressStartedAt: iso(now - 1999), questions });
  const farStarted = iso(now - 30000);
  const nearStarted = iso(now - 1999);

  const h = await hostFor(t, [tmp]);
  const runs = await h.runs();
  const farKey = runs.find((r) => r.runId === 'f17-far').runKey;
  const nearKey = runs.find((r) => r.runId === 'f17-near').runKey;

  const farStop = await fetch(h.url('/stop', { run: farKey, startedAt: farStarted }), { method: 'POST', headers: h.H() });
  assert.equal(farStop.status, 409, 'a 30s generation gap must fail closed on /stop');
  assert.equal((await farStop.json()).code, 'STALE_LIFECYCLE');
  assert.equal(existsSync(join(far, 'CANCEL')), false, 'no CANCEL may be written across generations');
  const farAnswer = await fetch(h.url('/answer', { run: farKey, q: 'q1', startedAt: farStarted }), {
    method: 'POST', headers: { ...h.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: '跨代回答' }),
  });
  assert.equal(farAnswer.status, 409, 'a 30s generation gap must fail closed on /answer');
  assert.equal(existsSync(join(far, 'inbox', 'q1.json')), false, 'no inbox answer may be written across generations');

  const nearStop = await fetch(h.url('/stop', { run: nearKey, startedAt: nearStarted }), { method: 'POST', headers: h.H() });
  assert.equal(nearStop.status, 200, '1,999ms is a normal millisecond skew, not a handoff');
  assert.equal(existsSync(join(near, 'CANCEL')), true);
  const nearAnswer = await fetch(h.url('/answer', { run: nearKey, q: 'q1', startedAt: nearStarted }), {
    method: 'POST', headers: { ...h.H(), 'content-type': 'application/json' }, body: JSON.stringify({ answer: '同代回答' }),
  });
  assert.equal(nearAnswer.status, 200);
  assert.equal(JSON.parse(readFileSync(join(near, 'inbox', 'q1.json'), 'utf8')).text, '同代回答');
});

// ---- F15 -------------------------------------------------------------------

test('F15: a cached runKey whose path was swapped for a junction is refused before any write', async (t) => {
  const tmp = sandbox(t, 'mmxw1-f15a-');
  const A = join(tmp, 'A');
  const B = join(tmp, 'B');
  const runId = 'f15-run';
  const started = iso(Date.now());
  const questions = [{ qId: 'q1', question: '确认', state: 'waiting' }];
  const aDir = join(A, '.qoder', 'workflow-runs', runId);
  const bDir = join(B, '.qoder', 'workflow-runs', runId);
  // B is indistinguishable from the scan-time snapshot: same runId, same startedAt, same
  // question, live pid, running status — every existing guard considers it the same lifecycle.
  writeRun(aDir, { runId, cwd: A, status: 'running', pid: process.pid, startedAt: started, questions });
  writeRun(bDir, { runId, cwd: B, status: 'running', pid: process.pid, startedAt: started, questions });

  const h = await hostFor(t, [A]);
  const keyA = await onlyRunKey(h, runId);   // registry snapshot taken here
  const aOrig = join(tmp, 'A-orig', runId);
  swapRunDir(aDir, bDir, aOrig);
  const aOrigBefore = snapshot(aOrig);
  const bBefore = snapshot(bDir);

  const stop = await fetch(h.url('/stop', { run: keyA, startedAt: started }), { method: 'POST', headers: h.H() });
  assert.equal(stop.status, 409, 'a cached runKey must not act through a swapped directory');
  assert.equal((await stop.json()).code, 'STALE_RUN_IDENTITY');
  assert.equal(existsSync(join(bDir, 'CANCEL')), false, 'otherCancel must stay false: B is not this run any more');
  assert.equal(snapshot(bDir), bBefore, 'B must be byte-identical after the refusal');
  assert.equal(existsSync(join(aOrig, 'CANCEL')), false, 'the originally registered directory must not be written');
  assert.equal(snapshot(aOrig), aOrigBefore, 'the originally registered directory must be untouched');
});

test('F15: a swap that lands after the lookup is still caught at the write boundary', async (t) => {
  const tmp = sandbox(t, 'mmxw1-f15b-');
  const A = join(tmp, 'A');
  const B = join(tmp, 'B');
  const runId = 'f15-run';
  const started = iso(Date.now());
  const questions = [{ qId: 'q1', question: '确认', state: 'waiting' }];
  const aDir = join(A, '.qoder', 'workflow-runs', runId);
  const bDir = join(B, '.qoder', 'workflow-runs', runId);
  writeRun(aDir, { runId, cwd: A, status: 'running', pid: process.pid, startedAt: started, questions });
  writeRun(bDir, { runId, cwd: B, status: 'running', pid: process.pid, startedAt: started, questions });

  const h = await hostFor(t, [A]);
  const keyA = await onlyRunKey(h, runId);
  const aOrig = join(tmp, 'A-orig', runId);
  const bBefore = snapshot(bDir);

  // The /answer handler awaits the request body; the swap lands inside that await, so the
  // lookup already succeeded and only a re-check at the write boundary can catch it.
  const res = await new Promise((done, fail) => {
    const u = new URL(h.url('/answer', { run: keyA, q: 'q1', startedAt: started }));
    const rq = request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'x-workflow-capability': CAPABILITY, 'content-type': 'application/json' },
    }, (rs) => {
      let body = '';
      rs.on('data', (c) => { body += c; });
      rs.on('end', () => done({ status: rs.statusCode, body }));
    });
    rq.on('error', fail);
    rq.write('{"answer":"');
    swapRunDir(aDir, bDir, aOrig);
    rq.end('换向之后的回答"}');
  });

  assert.equal(res.status, 409, 'the write boundary must re-resolve the real directory identity');
  assert.equal(JSON.parse(res.body).code, 'STALE_RUN_IDENTITY');
  assert.equal(existsSync(join(bDir, 'inbox', 'q1.json')), false, 'the answer must not land in the swapped-in directory');
  assert.equal(snapshot(bDir), bBefore);
});

test('F15: a refresh makes the registry authoritative again and retires the old runKey', async (t) => {
  const tmp = sandbox(t, 'mmxw1-f15c-');
  const A = join(tmp, 'A');
  const B = join(tmp, 'B');
  const runId = 'f15-run';
  const started = iso(Date.now());
  const questions = [{ qId: 'q1', question: '确认', state: 'waiting' }];
  const aDir = join(A, '.qoder', 'workflow-runs', runId);
  const bDir = join(B, '.qoder', 'workflow-runs', runId);
  writeRun(aDir, { runId, cwd: A, status: 'running', pid: process.pid, startedAt: started, questions });
  writeRun(bDir, { runId, cwd: B, status: 'running', pid: process.pid, startedAt: started, questions });

  const h = await hostFor(t, [A]);
  const keyA = await onlyRunKey(h, runId);
  swapRunDir(aDir, bDir, join(tmp, 'A-orig', runId));
  const rejected = await fetch(h.url('/stop', { run: keyA, startedAt: started }), { method: 'POST', headers: h.H() });
  assert.equal(rejected.status, 409);
  assert.equal(existsSync(join(bDir, 'CANCEL')), false);

  // Refresh: the rescan publishes the new real identity, and the refreshed entry behaves exactly
  // like any other scanned run. The retired runKey must not resolve to it.
  const refreshed = await onlyRunKey(h, runId);
  assert.notEqual(refreshed, keyA, 'the real identity changed, so the runKey must change with it');
  const ok = await fetch(h.url('/stop', { run: refreshed, startedAt: started }), { method: 'POST', headers: h.H() });
  assert.equal(ok.status, 200, 'the refreshed registry is authoritative for the run it publishes');
  assert.equal(existsSync(join(bDir, 'CANCEL')), true);
  const retired = await fetch(h.url('/stop', { run: keyA, startedAt: started }), { method: 'POST', headers: h.H() });
  assert.equal(retired.status, 404, 'a retired runKey is an unknown run, never a bare-id fallback');
});
