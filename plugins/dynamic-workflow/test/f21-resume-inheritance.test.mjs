import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const engine = fileURLToPath(new URL('../skills/dynamic-workflow/runtime/wf.mjs', import.meta.url));
// Every engine call is a child process with a hard wait, so a parked or wedged lifecycle fails the
// test instead of hanging it.
const TIMEOUT = 20000;

// Throw-only fixture: it settles `failed` with exit 1, which is exactly the state `resume` takes
// over from, and it dispatches nothing -- no model, no agent, no pending entry to wait on.
const THROWER =
  'export const meta={name:"f21-resume",description:"resume settings fixture"};\n' +
  'throw new Error("fixture failure");\n';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'wf-f21-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const script = join(cwd, 'resume-fixture.js');
  writeFileSync(script, THROWER);
  const env = { ...process.env, QODER_WF_HOME: join(cwd, 'fakehome') };
  delete env.DSH_SESSION_ID;
  delete env.QODER_WF_BACKEND;
  delete env.QODER_WF_MAX_CONCURRENCY;
  async function call(args, extra = {}) {
    try {
      const r = await exec(process.execPath, [engine, ...args, '--cwd', cwd], {
        cwd,
        env: { ...env, ...extra },
        timeout: TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, ...r };
    } catch (e) {
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }
  const read = (id, name) => JSON.parse(readFileSync(join(cwd, '.qoder/workflow-runs', id, name + '.json'), 'utf8'));
  // Fixtures that stand in for a state.json some other writer left behind.
  const rewriteState = (id, patch, drop = []) => {
    const file = join(cwd, '.qoder/workflow-runs', id, 'state.json');
    const next = { ...JSON.parse(readFileSync(file, 'utf8')), ...patch };
    for (const key of drop) delete next[key];
    writeFileSync(file, JSON.stringify(next, null, 2));
  };
  const startedBackends = (id) =>
    readFileSync(join(cwd, '.qoder/workflow-runs', id, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((e) => e.type === 'run_started')
      .map((e) => e.backend);
  return { cwd, script, call, read, rewriteState, startedBackends };
}

const settings = (state) => [state.backend, state.concurrency, state.maxAgentCalls];

test('a bare resume keeps the settings the run itself was recorded with', async (t) => {
  const f = fixture(t);
  const first = await f.call(['run', f.script, '--run-id', 'bare', '--backend', 'file', '--concurrency', '3', '--max-calls', '7']);
  assert.equal(first.code, 1, 'the throw-only fixture is expected to exit 1');
  assert.deepEqual(settings(f.read('bare', 'state')), ['file', 3, 7]);

  // The environment says something else on purpose: what governed this run is the journal's record
  // of it, not whatever the shell looks like at resume time.
  const resumed = await f.call(['resume', 'bare'], { QODER_WF_BACKEND: 'cli', QODER_WF_MAX_CONCURRENCY: '8' });
  assert.equal(resumed.code, 1, 'the fixture throws again; exit 1 is the fixture, not a regression');
  assert.deepEqual(settings(f.read('bare', 'state')), ['file', 3, 7]);
  assert.equal(f.read('bare', 'out').backend, 'file');
  assert.deepEqual(f.startedBackends('bare'), ['file', 'file']);
});

test('explicit flags on resume win over the recorded settings', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call(['run', f.script, '--run-id', 'explicit', '--backend', 'file', '--concurrency', '3', '--max-calls', '7'])).code, 1);

  const resumed = await f.call(['resume', 'explicit', '--backend', 'echo', '--concurrency', '5', '--max-calls', '9']);
  assert.equal(resumed.code, 1);
  assert.deepEqual(settings(f.read('explicit', 'state')), ['echo', 5, 9]);
  assert.equal(f.read('explicit', 'out').backend, 'echo');
  assert.deepEqual(f.startedBackends('explicit'), ['file', 'echo']);
});

test('one explicit flag does not drag the other two back to the defaults', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call(['run', f.script, '--run-id', 'partial', '--backend', 'file', '--concurrency', '3', '--max-calls', '7'])).code, 1);

  const resumed = await f.call(['resume', 'partial', '--max-calls', '9'], { QODER_WF_BACKEND: 'cli', QODER_WF_MAX_CONCURRENCY: '8' });
  assert.equal(resumed.code, 1);
  assert.deepEqual(settings(f.read('partial', 'state')), ['file', 3, 9]);
});

test('recorded settings that are missing or out of range fall back to the environment and the defaults', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call(['run', f.script, '--run-id', 'legacy', '--backend', 'file', '--concurrency', '3', '--max-calls', '7'])).code, 1);
  // A state.json written by something else: an unknown backend and no numbers at all.
  f.rewriteState('legacy', { backend: 'nonsense' }, ['concurrency', 'maxAgentCalls']);

  const resumed = await f.call(['resume', 'legacy'], { QODER_WF_BACKEND: 'echo', QODER_WF_MAX_CONCURRENCY: '6' });
  assert.equal(resumed.code, 1, 'an unusable recorded backend is left to the environment, not refused');
  assert.deepEqual(settings(f.read('legacy', 'state')), ['echo', 6, 500]);
});

// An integer outside the engine's own clampInt limits is not a usable old value: cmdRun would pin it
// to the hard ceiling (32 / 100000) and silently re-price the run, so it has to fall through to the
// environment and the defaults like any other unusable record.
for (const [label, recorded] of [
  ['above the ceiling', { concurrency: 1000, maxAgentCalls: 999999 }],
  ['zero or negative', { concurrency: 0, maxAgentCalls: -1 }],
]) {
  test('recorded settings ' + label + ' fall back to the environment and the defaults', async (t) => {
    const f = fixture(t);
    assert.equal((await f.call(['run', f.script, '--run-id', 'range', '--backend', 'file', '--concurrency', '3', '--max-calls', '7'])).code, 1);
    f.rewriteState('range', recorded);
    const resumed = await f.call(['resume', 'range'], { QODER_WF_BACKEND: 'echo', QODER_WF_MAX_CONCURRENCY: '6' });
    assert.equal(resumed.code, 1);
    // The recorded backend is still valid, so it is still inherited over the environment; only the
    // unusable numbers fall through.
    assert.deepEqual(settings(f.read('range', 'state')), ['file', 6, 500]);
  });
}
