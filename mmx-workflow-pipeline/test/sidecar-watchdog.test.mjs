// test/sidecar-watchdog.test.mjs — decision logic, singleton lock and log discipline for the
// sidecar watchdog. Run: node --test test/sidecar-watchdog.test.mjs
//
// Nothing here touches a real port or starts a real sidecar: every probe is a mock, every spawn
// is a fake ChildProcess, and every file lands in a per-test temp directory. The production ports
// (4231 / 9331) are only read as constants imported from sidecar.mjs, never bound.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireLock, createLogger, createStopper, createTransitionMemory, decide, installTask,
  isProcessAlive, parseArgs, probeCdp, probeSidecar, readLock, releaseLock, runOnce, runWatchdog,
  sidecarArgv, startSidecar, stateKey, REASON, LOG_EVENT, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS,
  CHILD_LOG_PATH, LOCK_PATH, LOG_PATH, PIPELINE_ROOT, SIDECAR_PATH,
} from '../scripts/sidecar-watchdog.mjs';
import { API_PORT, CDP_PORT } from '../sidecar.mjs';

const temps = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmxdwf-watchdog-'));
  temps.push(dir);
  return dir;
};
after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } });

// A logger that keeps lines in memory, so "was this decision logged?" is observable.
const memoryLogger = () => {
  const lines = [];
  const log = (event, detail = '') => { lines.push({ event, detail: String(detail), line: `${event} ${String(detail)}`.trim() }); };
  log.lines = lines;
  log.events = () => lines.map((l) => l.event);
  return log;
};

const okResponse = (body = '', status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => JSON.parse(body),
  arrayBuffer: async () => new ArrayBuffer(0),
});

// ---- decide(): the whole decision surface ---------------------------------
test('decide: sidecar alive -> wait, regardless of the host', () => {
  assert.deepEqual(decide({ httpProbe4231: true, httpProbe9331: true }), { action: 'wait', reason: 'sidecar-alive' });
  assert.deepEqual(decide({ httpProbe4231: true, httpProbe9331: false }), { action: 'wait', reason: 'sidecar-alive' });
  assert.deepEqual(decide({ httpProbe4231: true, httpProbe9331: null }), { action: 'wait', reason: 'sidecar-alive' });
});

test('decide: sidecar down + injectable host -> start-sidecar', () => {
  assert.deepEqual(decide({ httpProbe4231: false, httpProbe9331: true }), { action: 'start-sidecar', reason: 'sidecar-down-host-up' });
});

test('decide: sidecar down + no host -> wait (never a bare sidecar with nothing to inject)', () => {
  for (const httpProbe9331 of [false, null, undefined, 0, '']) {
    assert.deepEqual(decide({ httpProbe4231: false, httpProbe9331 }), { action: 'wait', reason: 'no-injectable-host' });
  }
});

test('decide: never asks for a start unless BOTH probes are false/true in that order', () => {
  for (const httpProbe4231 of [true, false]) {
    for (const httpProbe9331 of [true, false]) {
      const decision = decide({ httpProbe4231, httpProbe9331 });
      if (decision.action === 'start-sidecar') {
        assert.equal(httpProbe4231, false);
        assert.equal(httpProbe9331, true);
        assert.equal(decision.reason, REASON.SIDECAR_DOWN_HOST_UP);
      }
      assert.ok(['wait', 'start-sidecar'].includes(decision.action));
      assert.equal(typeof decision.reason, 'string');
      assert.notEqual(decision.reason, '');
    }
  }
});

test('decide: no input at all is the safe branch, not a throw', () => {
  assert.deepEqual(decide(), { action: 'wait', reason: 'no-injectable-host' });
  assert.deepEqual(decide({}), { action: 'wait', reason: 'no-injectable-host' });
});

// ---- state-change memory --------------------------------------------------
test('createTransitionMemory: logs a state once, again only after it changes', () => {
  const memory = createTransitionMemory();
  const waitState = stateKey(decide({ httpProbe4231: true, httpProbe9331: false }));
  assert.equal(memory.shouldLog(waitState), true);      // first sighting
  assert.equal(memory.shouldLog(waitState), false);     // steady state stays silent
  assert.equal(memory.shouldLog(waitState), false);
  assert.equal(memory.last, waitState);
  const other = stateKey(decide({ httpProbe4231: false, httpProbe9331: false }));
  assert.equal(memory.shouldLog(other), true);          // change is logged
  assert.equal(memory.shouldLog(waitState), true);      // and a change BACK is logged too
  memory.reset();
  assert.equal(memory.last, null);
  assert.equal(memory.shouldLog(waitState), true);
});

test('createTransitionMemory: can start primed, so a mid-run watcher stays quiet', () => {
  const state = stateKey(decide({ httpProbe4231: true, httpProbe9331: false }));
  const memory = createTransitionMemory(state);
  assert.equal(memory.shouldLog(state), false);
});

test('stateKey: repeated waits collapse, repeated start attempts do not', () => {
  const start = decide({ httpProbe4231: false, httpProbe9331: true });
  const wait = decide({ httpProbe4231: true, httpProbe9331: true });
  assert.equal(stateKey(wait, 0), 'wait:sidecar-alive');
  assert.equal(stateKey(wait, 99), 'wait:sidecar-alive', 'a wait has no attempt counter');
  assert.equal(stateKey(start, 1), 'start-sidecar:sidecar-down-host-up#1');
  assert.notEqual(stateKey(start, 1), stateKey(start, 2), 'each retry is its own state');
  assert.notEqual(stateKey(start, 1), stateKey(wait, 0));
});

// ---- probes (mocked fetch; no socket is ever opened) ----------------------
test('probeSidecar: ANY HTTP response means "listening", including 403/404/500', async () => {
  const seen = [];
  for (const status of [200, 403, 404, 500]) {
    const result = await probeSidecar({ fetchImpl: async (url, init) => { seen.push([url, init.method]); return okResponse('nope', status); } });
    assert.equal(result, true, `status ${status} must count as listening`);
  }
  assert.deepEqual(seen[0][0], `http://127.0.0.1:${API_PORT}/`);
  assert.equal(seen[0][1], 'GET');
});

test('probeSidecar: connection failure and abort both read as "not listening"', async () => {
  assert.equal(await probeSidecar({ fetchImpl: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); } }), false);
  const aborted = await probeSidecar({
    timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(aborted, false);
});

test('probeCdp: JSON carrying a Browser field means "injectable host"', async () => {
  assert.equal(await probeCdp({ fetchImpl: async () => okResponse(JSON.stringify({ Browser: 'Chrome/140.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/browser/x' })) }), true);
  const seen = [];
  await probeCdp({ fetchImpl: async (url) => { seen.push(url); return okResponse('{}'); } });
  assert.deepEqual(seen, [`http://127.0.0.1:${CDP_PORT}/json/version`], 'the CDP probe targets /json/version');
});

test('probeCdp: non-200, non-JSON, and JSON without Browser are NOT an injectable host', async () => {
  assert.equal(await probeCdp({ fetchImpl: async () => okResponse(JSON.stringify({ Browser: 'x' }), 500) }), false);
  assert.equal(await probeCdp({ fetchImpl: async () => okResponse('not json at all') }), false);
  assert.equal(await probeCdp({ fetchImpl: async () => okResponse(JSON.stringify({ webSocketDebuggerUrl: 'ws://x' })) }), false);
  assert.equal(await probeCdp({ fetchImpl: async () => okResponse(JSON.stringify({ Browser: '   ' })) }), false);
  assert.equal(await probeCdp({ fetchImpl: async () => okResponse(JSON.stringify([{ Browser: 'x' }])) }), false);
  assert.equal(await probeCdp({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
});

test('probes read the ports from sidecar.mjs, never a private copy', () => {
  assert.equal(API_PORT, 4231);
  assert.equal(CDP_PORT, 9331);
  assert.equal(SIDECAR_PATH, join(PIPELINE_ROOT, 'sidecar.mjs'));
});

// ---- lock: three states ----------------------------------------------------
test('isProcessAlive: this process is alive, ESRCH is dead, EPERM is alive-but-not-ours', () => {
  assert.equal(isProcessAlive(process.pid), true);
  const calls = [];
  const alive = isProcessAlive(4242, (...args) => { calls.push(args); });
  assert.equal(alive, true);
  assert.deepEqual(calls[0], [4242, 0]);
  assert.equal(isProcessAlive(4242, () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); }), false);
  assert.equal(isProcessAlive(4242, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }), true);
  assert.equal(isProcessAlive(4242, () => { throw new Error('boom'); }), false);
  for (const bogus of [0, -1, 1.5, 'abc', null, undefined, NaN]) {
    let touched = false;
    assert.equal(isProcessAlive(bogus, () => { touched = true; }), false, `pid ${String(bogus)} must be rejected`);
    assert.equal(touched, false, `pid ${String(bogus)} must not reach process.kill`);
  }
});

test('readLock: absent, malformed, bogus-pid and valid locks are distinguished', () => {
  const dir = tempDir();
  assert.deepEqual(readLock(join(dir, 'none.lock')), { exists: false, pid: null, valid: false });

  const malformed = join(dir, 'malformed.lock');
  writeFileSync(malformed, 'not json');
  const malformedRead = readLock(malformed);
  assert.equal(malformedRead.exists, true);
  assert.equal(malformedRead.valid, false);
  assert.equal(malformedRead.reason, 'malformed-lock');

  const bogus = join(dir, 'bogus.lock');
  writeFileSync(bogus, JSON.stringify({ pid: 'abc' }));
  assert.equal(readLock(bogus).reason, 'malformed-lock');

  const good = join(dir, 'good.lock');
  writeFileSync(good, JSON.stringify({ pid: 4242, startedAt: '2026-10-09T00:00:00.000Z' }));
  const goodRead = readLock(good);
  assert.equal(goodRead.valid, true);
  assert.equal(goodRead.pid, 4242);
  assert.equal(goodRead.startedAt, '2026-10-09T00:00:00.000Z');
});

test('acquireLock: no lock -> acquired, file carries our pid', () => {
  const lockPath = join(tempDir(), 'sub', 'watchdog.lock');
  const result = acquireLock({ lockPath, pid: 1234, isAlive: () => true });
  assert.equal(result.acquired, true);
  assert.equal(result.staleRemoved, false);
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 1234);
});

test('acquireLock: a LIVE holder blocks a second watchdog and its lock is left untouched', () => {
  const lockPath = join(tempDir(), 'watchdog.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 777, startedAt: 'earlier' }));
  const result = acquireLock({ lockPath, pid: 1234, isAlive: (pid) => pid === 777 });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, 'lock-held-by-live-process');
  assert.equal(result.holderPid, 777);
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 777, 'a live lock must never be overwritten');
});

test('acquireLock: a DEAD holder is stale — cleaned up and replaced', () => {
  const lockPath = join(tempDir(), 'watchdog.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 777 }));
  const result = acquireLock({ lockPath, pid: 1234, isAlive: () => false });
  assert.equal(result.acquired, true);
  assert.equal(result.staleRemoved, true);
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 1234);
});

test('acquireLock: a malformed lock is stale too', () => {
  const lockPath = join(tempDir(), 'watchdog.lock');
  writeFileSync(lockPath, '{ broken');
  const result = acquireLock({ lockPath, pid: 1234, isAlive: () => false });
  assert.equal(result.acquired, true);
  assert.equal(result.staleRemoved, true);
  assert.equal(result.staleReason, 'malformed-lock');
});

test('acquireLock: an unresolved creation race fails closed instead of running two watchdogs', () => {
  const lockPath = join(tempDir(), 'watchdog.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 777 }));
  const result = acquireLock({
    lockPath, pid: 1234,
    isAlive: () => false,
    write: () => { throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
    remove: () => {},
  });
  assert.equal(result.acquired, false);
  assert.equal(result.reason, 'lock-race-unresolved');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 777, 'the race loser must not have overwritten the winner');
});

test('releaseLock: removes our own lock, refuses anyone else\'s', () => {
  const dir = tempDir();
  const lockPath = join(dir, 'watchdog.lock');

  writeFileSync(lockPath, JSON.stringify({ pid: 4242 }));
  assert.deepEqual(releaseLock({ lockPath, pid: 999 }), { released: false, reason: 'lock-owned-by-other-pid', holderPid: 4242 });
  assert.equal(existsSync(lockPath), true, 'another pid\'s lock survives');

  writeFileSync(lockPath, JSON.stringify({ pid: 4242 }));
  assert.equal(releaseLock({ lockPath, pid: 4242 }).released, true);
  assert.equal(existsSync(lockPath), false);

  assert.deepEqual(releaseLock({ lockPath, pid: 4242 }), { released: false, reason: 'no-lock' });
});

// ---- one round, fully mocked ----------------------------------------------
test('runOnce: sidecar alive -> no spawn, one wait line, 9331 is not even probed', async () => {
  const logger = memoryLogger();
  let cdpCalls = 0;
  const result = await runOnce({
    probe4231: async () => true,
    probe9331: async () => { cdpCalls += 1; return true; },
    startSidecarImpl: async () => { throw new Error('must not start'); },
    logger,
  });
  assert.equal(result.action, 'wait');
  assert.equal(result.reason, 'sidecar-alive');
  assert.equal(result.spawn, null);
  assert.equal(result.logged, true);
  assert.equal(cdpCalls, 0);
  assert.deepEqual(logger.events(), [LOG_EVENT.DECISION_WAIT]);
});

test('runOnce: unchanged state logs once across consecutive rounds', async () => {
  const logger = memoryLogger();
  const memory = createTransitionMemory();
  const opts = { probe4231: async () => false, probe9331: async () => false, startSidecarImpl: async () => ({ started: true, pid: 1 }), logger, memory };

  const first = await runOnce(opts);
  const second = await runOnce(opts);
  const third = await runOnce(opts);
  assert.equal(first.logged, true);
  assert.equal(second.logged, false);
  assert.equal(third.logged, false);
  assert.equal(logger.events().length, 1);
  assert.match(logger.lines[0].detail, /no-injectable-host/);
});

test('runOnce: state changes are logged again, unchanged rounds stay silent', async () => {
  const logger = memoryLogger();
  const memory = createTransitionMemory();
  const spawned = [];
  let sidecarUp = false;
  let hostUp = false;
  const round = () => runOnce({
    probe4231: async () => sidecarUp,
    probe9331: async () => hostUp,
    startSidecarImpl: async () => { spawned.push(1); return { started: true, pid: 31337 }; },
    logger,
    memory,
  });

  assert.equal((await round()).action, 'wait');           // nothing is up: no-injectable-host
  assert.equal((await round()).logged, false);            // unchanged -> silent
  sidecarUp = true;
  const alive = await round();
  assert.equal(alive.reason, 'sidecar-alive');
  assert.equal(alive.logged, true);                       // a real change -> logged
  assert.equal((await round()).logged, false);            // steady state -> silent

  sidecarUp = false;                                      // the failure this exists for
  hostUp = true;
  const start = await round();
  assert.equal(start.action, 'start-sidecar');
  assert.equal(start.reason, 'sidecar-down-host-up');
  assert.equal(start.logged, true);
  assert.equal(start.spawn.started, true);
  assert.equal(start.spawn.pid, 31337);
  assert.equal(spawned.length, 1);
  assert.deepEqual(logger.events(), [LOG_EVENT.DECISION_WAIT, LOG_EVENT.DECISION_WAIT, LOG_EVENT.DECISION_START, LOG_EVENT.DECISION_START]);
});

test('runOnce: sidecar down + host up starts exactly once per round and never without a host', async () => {
  const logger = memoryLogger();
  const memory = createTransitionMemory();
  const spawned = [];
  let sidecarUp = false;
  let spawnFails = false;
  let attempts = 0;
  const round = () => runOnce({
    probe4231: async () => sidecarUp,
    probe9331: async () => true,
    startSidecarImpl: async (o) => {
      spawned.push(o);
      if (spawnFails) return { started: false, error: 'EADDRINUSE' };
      sidecarUp = true;
      return { started: true, pid: 1000 + spawned.length, argv: sidecarArgv() };
    },
    logger,
    memory,
    attempts,
  }).then((result) => { attempts = result.attempts; return result; });

  const first = await round();
  assert.equal(first.attempts, 1);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].reason, 'sidecar-down-host-up');
  assert.equal(first.spawn.argv[0], SIDECAR_PATH, 'the spawn carries the absolute sidecar path');

  // The sidecar came up: the next round must observe it and stop starting anything.
  const alive = await round();
  assert.equal(alive.action, 'wait');
  assert.equal(spawned.length, 1);

  // Now it dies and refuses to come back: one log line per attempt, counter carried across rounds.
  sidecarUp = false;
  spawnFails = true;
  const loggedPerRound = [];
  for (let i = 0; i < 3; i++) {
    const r = await round();
    loggedPerRound.push(r.logged);
    assert.equal(r.spawn.started, false);
  }
  assert.deepEqual(loggedPerRound, [true, true, true], 'each failed retry is its own state');
  assert.equal(attempts, 3, 'a healthy sidecar reset the counter, then 3 retries counted 1..3');
  assert.equal(logger.events().filter((e) => e === LOG_EVENT.DECISION_START).length, 5, '2 lines for the successful start (intent + outcome) + 3 retry intents');
  assert.equal(logger.events().filter((e) => e === LOG_EVENT.ERROR).length, 3, 'every failed spawn is recorded');
});

test('runOnce: a failing spawn is recorded, not thrown', async () => {
  const logger = memoryLogger();
  const result = await runOnce({
    probe4231: async () => false,
    probe9331: async () => true,
    startSidecarImpl: async () => { throw new Error('spawn EACCES'); },
    logger,
  });
  assert.equal(result.action, null);
  assert.match(result.error, /spawn EACCES/);
  assert.ok(logger.events().includes(LOG_EVENT.ERROR));
});

test('runOnce: a broken probe is caught inside the round and reported as an error event', async () => {
  const logger = memoryLogger();
  const result = await runOnce({
    probe4231: async () => { throw new Error('probe exploded'); },
    probe9331: async () => true,
    startSidecarImpl: async () => { throw new Error('must not start'); },
    logger,
  });
  assert.match(result.error, /probe exploded/);
  assert.equal(result.spawn, null);
  assert.deepEqual(logger.events(), [LOG_EVENT.ERROR]);
  assert.match(logger.lines[0].detail, /probe exploded/);
});

test('runOnce: --once does not sleep, the loop passes the interval as the post-spawn wait', async () => {
  const slept = [];
  await runOnce({
    probe4231: async () => false,
    probe9331: async () => true,
    startSidecarImpl: async () => ({ started: true, pid: 5 }),
    sleepImpl: async (ms) => { slept.push(ms); },
    waitAfterStartMs: 0,
  });
  assert.deepEqual(slept, [], '--once must not delay');

  await runOnce({
    probe4231: async () => false,
    probe9331: async () => true,
    startSidecarImpl: async () => ({ started: true, pid: 5 }),
    sleepImpl: async (ms) => { slept.push(ms); },
    waitAfterStartMs: DEFAULT_INTERVAL_MS,
  });
  assert.deepEqual(slept, [DEFAULT_INTERVAL_MS], 'the loop waits a full interval before re-probing 4231');
});

test('runOnce: a waiting round does not sleep at the post-spawn point', async () => {
  const slept = [];
  const result = await runOnce({
    probe4231: async () => true,
    probe9331: async () => true,
    sleepImpl: async (ms) => { slept.push(ms); },
    waitAfterStartMs: DEFAULT_INTERVAL_MS,
  });
  assert.equal(result.action, 'wait');
  assert.deepEqual(slept, []);
});

// ---- the loop -------------------------------------------------------------
test('runWatchdog: boots, runs rounds until stopped, exits cleanly', async () => {
  const logger = memoryLogger();
  const stopper = createStopper();
  let rounds = 0;
  const result = await runWatchdog({
    intervalMs: 5,
    stopper,
    logger,
    runOnceImpl: async () => {
      rounds += 1;
      if (rounds >= 3) stopper.stop();
      return { attempts: 2, action: 'wait', reason: 'sidecar-alive', error: null };
    },
  });
  assert.equal(rounds, 3);
  assert.equal(stopper.stopped, true);
  assert.equal(result.attempts, 2);
  assert.equal(logger.events()[0], LOG_EVENT.BOOT);
  assert.equal(logger.events().at(-1), LOG_EVENT.EXIT);
  assert.match(logger.lines[0].detail, /api-port=4231 cdp-port=9331/);
});

test('runWatchdog: a throwing round does not end the loop', async () => {
  const stopper = createStopper();
  const logger = memoryLogger();
  let rounds = 0;
  await runWatchdog({
    intervalMs: 5,
    stopper,
    logger,
    runOnceImpl: async () => {
      rounds += 1;
      if (rounds === 1) throw new Error('round blew up');
      if (rounds >= 3) stopper.stop();
      return { attempts: 0, error: null };
    },
  });
  assert.equal(rounds, 3, 'the loop kept going after the throwing round');
  assert.ok(logger.events().includes(LOG_EVENT.ERROR));
  assert.match(logger.lines.find((l) => l.event === LOG_EVENT.ERROR).detail, /round-threw round blew up/);
});

test('createStopper: stop() is idempotent and unblocks an in-flight wait', async () => {
  const stopper = createStopper();
  assert.equal(stopper.stopped, false);
  stopper.stop();
  stopper.stop();
  assert.equal(stopper.stopped, true);
  await Promise.race([stopper.done, new Promise((_, reject) => setTimeout(() => reject(new Error('not unblocked')), 50))]);
});

// ---- starting the sidecar (fake process, real fds redirected to a temp log) -
class FakeChild extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.unrefed = false; this.setMaxListeners(0); }
  unref() { this.unrefed = true; }
}

test('startSidecar: detached spawn of sidecar.mjs with --no-launch, output to the child log', async () => {
  const dir = tempDir();
  const childLogPath = join(dir, 'nested', 'sidecar-watchdog-child.log');
  const child = new FakeChild(24680);
  let captured = null;
  const result = await startSidecar({
    sidecarPath: SIDECAR_PATH,
    nodeExec: 'node',
    childLogPath,
    spawnImpl: (cmd, argv, opts) => { captured = { cmd, argv, opts }; setImmediate(() => child.emit('spawn')); return child; },
    open: () => 42,
    close: () => {},
  });
  assert.equal(result.started, true);
  assert.equal(result.pid, 24680);
  assert.equal(captured.cmd, 'node');
  assert.deepEqual(captured.argv, [SIDECAR_PATH, '--no-launch']);
  assert.equal(captured.opts.detached, true, 'the sidecar must outlive the watchdog');
  assert.equal(captured.opts.stdio[0], 'ignore');
  assert.deepEqual(captured.opts.stdio.slice(1), [42, 42]);
  assert.equal(child.unrefed, true);
  assert.match(SIDECAR_PATH, /sidecar\.mjs$/);
});

test('startSidecar: sidecarArgv defaults to the absolute sidecar path plus --no-launch', () => {
  assert.deepEqual(sidecarArgv(), [SIDECAR_PATH, '--no-launch']);
  assert.deepEqual(sidecarArgv({ sidecarPath: '/tmp/x/sidecar.mjs', extraArgs: [] }), ['/tmp/x/sidecar.mjs']);
});

test('startSidecar: spawn throwing, spawn erroring and an unopenable log are all reported, never thrown', async () => {
  const dir = tempDir();
  const childLogPath = join(dir, 'child.log');

  const thrown = await startSidecar({ childLogPath, spawnImpl: () => { throw new Error('EACCES'); }, open: () => 1, close: () => {} });
  assert.equal(thrown.started, false);
  assert.match(thrown.error, /spawn threw: EACCES/);

  const erroring = new FakeChild(0);
  const errored = await startSidecar({
    childLogPath,
    spawnImpl: () => { setImmediate(() => erroring.emit('error', new Error('ENOENT node'))); return erroring; },
    open: () => 1, close: () => {},
  });
  assert.equal(errored.started, false);
  assert.match(errored.error, /spawn error: ENOENT node/);

  const unopenable = await startSidecar({ childLogPath, spawnImpl: () => assert.fail('must not spawn'), open: () => { throw new Error('EBADF'); } });
  assert.equal(unopenable.started, false);
  assert.match(unopenable.error, /cannot open child log/);
});

test('startSidecar: a late child error after confirmation does not take the watchdog down', async () => {
  const dir = tempDir();
  const child = new FakeChild(31337);
  const result = await startSidecar({
    childLogPath: join(dir, 'child.log'),
    spawnImpl: () => { setImmediate(() => child.emit('spawn')); return child; },
    open: () => 1, close: () => {},
  });
  assert.equal(result.started, true);
  assert.equal(child.emit('error', new Error('late failure')), true, 'the error had a listener');
});

// ---- log line format ------------------------------------------------------
test('createLogger: "<UTC ISO> <event> <detail>" one line per event, nested dir auto-created', () => {
  const logPath = join(tempDir(), 'deep', 'nested', 'sidecar-watchdog.log');
  const logger = createLogger({ logPath, now: () => '2026-10-09T08:15:30.123Z' });
  logger(LOG_EVENT.BOOT, 'pid=1 interval=15000ms');
  logger(LOG_EVENT.DECISION_WAIT, `${REASON.SIDECAR_ALIVE} sidecar-4231-listening=true`);
  logger(LOG_EVENT.ERROR, 'line one\nline two');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '2026-10-09T08:15:30.123Z boot pid=1 interval=15000ms');
  assert.equal(lines[1], `2026-10-09T08:15:30.123Z decision-wait ${REASON.SIDECAR_ALIVE} sidecar-4231-listening=true`);
  assert.equal(lines[2], '2026-10-09T08:15:30.123Z error line one line two', 'a detail must never break the one-line contract');
  assert.ok(lines.every((l) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z (boot|decision-start|decision-wait|error|exit) /.test(l)));
});

test('createLogger: an unwritable log never throws at the caller', () => {
  const dir = tempDir();
  // A directory as the log target makes appendFileSync fail with EISDIR/EPERM on every write.
  const unwritable = createLogger({ logPath: dir });
  assert.doesNotThrow(() => unwritable(LOG_EVENT.ERROR, 'still fine'));
  const invalid = createLogger({ logPath: '\u0000-invalid', onLine: () => {} });
  assert.doesNotThrow(() => invalid(LOG_EVENT.ERROR, 'still fine'));
});

test('createLogger: onLine mirrors lines to stdout for --once', () => {
  const mirrored = [];
  const logger = createLogger({ logPath: join(tempDir(), 'mirror.log'), now: () => '2026-10-09T00:00:00.000Z', onLine: (line) => mirrored.push(line) });
  logger(LOG_EVENT.DECISION_WAIT, REASON.NO_INJECTABLE_HOST);
  assert.deepEqual(mirrored, [`2026-10-09T00:00:00.000Z decision-wait ${REASON.NO_INJECTABLE_HOST}\n`]);
});

test('default paths all live inside the pipeline, never in cwd', () => {
  for (const p of [SIDECAR_PATH, LOG_PATH, CHILD_LOG_PATH, LOCK_PATH]) {
    assert.equal(p.startsWith(PIPELINE_ROOT), true, `${p} must be under ${PIPELINE_ROOT}`);
  }
  assert.match(LOG_PATH, /logs[\\/]sidecar-watchdog\.log$/);
  assert.match(CHILD_LOG_PATH, /logs[\\/]sidecar-watchdog-child\.log$/);
  assert.match(LOCK_PATH, /logs[\\/]sidecar-watchdog\.lock$/);
  assert.match(SIDECAR_PATH, /mmx-workflow-pipeline[\\/]sidecar\.mjs$/);
});

// ---- CLI ------------------------------------------------------------------
test('parseArgs: defaults and each flag', () => {
  assert.deepEqual(parseArgs([]), { once: false, installTask: false, help: false, intervalMs: DEFAULT_INTERVAL_MS });
  assert.equal(parseArgs(['--once']).once, true);
  assert.equal(parseArgs(['--install-task']).installTask, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--interval-ms', '5000']).intervalMs, 5000);
  assert.equal(parseArgs(['--interval-ms=25000']).intervalMs, 25000);
  assert.deepEqual(parseArgs(['--once', '--interval-ms', '1000']), { once: true, installTask: false, help: false, intervalMs: 1000 });
});

test('parseArgs: rejects bad or unsafe values instead of silently defaulting', () => {
  assert.throws(() => parseArgs(['--interval-ms', 'abc']), /positive integer/);
  assert.throws(() => parseArgs(['--interval-ms', '-1']), /positive integer/);
  assert.throws(() => parseArgs(['--interval-ms=0']), />= 500/);
  assert.throws(() => parseArgs(['--interval-ms', String(MIN_INTERVAL_MS - 1)]), />= 500/);
  assert.throws(() => parseArgs(['--interval-ms']), /requires a value/);
  assert.throws(() => parseArgs(['--interval-ms', '--once']), /requires a value/);
  assert.throws(() => parseArgs(['--nope']), /Unknown watchdog argument/);
});

test('installTask: delegates to the bundled installer with the resolved absolute path', async () => {
  const calls = [];
  const result = await installTask({
    platform: 'win32',
    check: (p) => p.endsWith('install-watchdog-task.ps1'),
    spawnSyncImpl: (file, args, opts) => { calls.push({ file, args, opts }); return { status: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.match(calls[0].args[3], /install-watchdog-task\.ps1$/);
  assert.ok(calls[0].args.includes('-NoProfile'));
});

test('installTask: a non-zero schtasks/powershell exit is a failure, and non-Windows refuses', async () => {
  const failed = await installTask({
    platform: 'win32',
    check: () => true,
    spawnSyncImpl: () => { throw new Error('powershell.exe not found'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'spawn-failed');

  const denied = await installTask({ platform: 'win32', check: () => true, spawnSyncImpl: () => ({ status: 1 }) });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 1);

  assert.deepEqual(await installTask({ platform: 'linux', spawnSyncImpl: () => assert.fail('must not spawn') }), { ok: false, reason: 'windows-only', platform: 'linux' });
  assert.equal((await installTask({ platform: 'win32', check: () => false })).reason, 'installer-missing');
});

test('the installer script is shipped next to the watchdog it starts', () => {
  const installer = join(PIPELINE_ROOT, 'scripts', 'install-watchdog-task.ps1');
  assert.equal(existsSync(installer), true, `${installer} must exist for --install-task`);
  assert.equal(existsSync(SIDECAR_PATH), true, 'the watchdog must point at the real sidecar');
  mkdirSync(PIPELINE_ROOT, { recursive: true });
});
