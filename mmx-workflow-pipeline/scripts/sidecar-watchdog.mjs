#!/usr/bin/env node
// mmx-workflow-pipeline sidecar watchdog — self-healing supervisor for the sidecar PROCESS ONLY.
//
// Why this exists (observed 2026-10-02): sidecar.mjs already reconnects/re-injects on its own
// (5s retry / 10s poll), so a host (MiniMax Code) restart is survivable AS LONG AS THE SIDECAR
// PROCESS IS STILL ALIVE. The one failure mode the sidecar cannot heal is its own disappearance —
// an external supervisor restarted the host and the sidecar died with it, and nothing brought it
// back. This file is that missing supervisor.
//
// SCOPE DISCIPLINE (deliberate, do not widen):
//   * process liveness only — no capability, no API base, no credential, no workflow logic;
//   * never touches the port contract: 4231 and 9331 are imported from sidecar.mjs, never
//     hardcoded here, and the watchdog NEVER rebinds, kills, inspects-beyond-liveness or
//     reconfigures the host;
//   * never runs a sidecar with no injectable host: with no CDP endpoint there is nothing to
//     inject into, so the decision is 'wait', forever, until the host comes back.
//
// USAGE (run from anywhere; every path is resolved from this file, never from cwd):
//   node mmx-workflow-pipeline/scripts/sidecar-watchdog.mjs                  # run the loop (default 15s)
//   node mmx-workflow-pipeline/scripts/sidecar-watchdog.mjs --interval-ms 5000
//   node mmx-workflow-pipeline/scripts/sidecar-watchdog.mjs --once           # one decision, then exit
//   node mmx-workflow-pipeline/scripts/sidecar-watchdog.mjs --install-task   # register the logon task
//   node mmx-workflow-pipeline/scripts/sidecar-watchdog.mjs --help
//
// SINGLETON: exactly one watchdog may run per user account, enforced by logs/sidecar-watchdog.lock
// (JSON with the owning pid). A lock held by a live pid makes this process exit 0 silently; a lock
// left by a dead pid is stale and is cleaned up. The lock is removed on SIGINT/SIGTERM and on a
// normal --once exit. This is a liveness lock, NOT a mutex for correctness: two racing watchdogs
// would both converge on the same decision, and sidecar.mjs itself exits 1 on EADDRINUSE.
//
// FILES: logs/sidecar-watchdog.log (this process), logs/sidecar-watchdog-child.log (the sidecar's
// stdout+stderr), logs/sidecar-watchdog.lock (pid). `*.log` is gitignored; the lock is runtime
// state and is recreated on every boot.
//
// Zero third-party dependencies: node builtins + global fetch only.
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// The fixed ports are imported, not copied: a single source of truth with the sidecar.
import { API_PORT, CDP_PORT } from '../sidecar.mjs';

// ---- paths & contracts ----------------------------------------------------
export const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const SCRIPT_DIR = dirname(SCRIPT_PATH);
export const PIPELINE_ROOT = resolve(SCRIPT_DIR, '..');
export const SIDECAR_PATH = join(PIPELINE_ROOT, 'sidecar.mjs');
export const LOG_DIR = join(PIPELINE_ROOT, 'logs');
export const LOG_PATH = join(LOG_DIR, 'sidecar-watchdog.log');
export const CHILD_LOG_PATH = join(LOG_DIR, 'sidecar-watchdog-child.log');
export const LOCK_PATH = join(LOG_DIR, 'sidecar-watchdog.lock');
export const INSTALLER_PATH = join(SCRIPT_DIR, 'install-watchdog-task.ps1');

export const DEFAULT_INTERVAL_MS = 15000;
export const PROBE_TIMEOUT_MS = 2000;
export const SPAWN_TIMEOUT_MS = 10000;
export const MIN_INTERVAL_MS = 500;

// reason strings are part of the log contract — do not reword them silently.
export const REASON = Object.freeze({
  SIDECAR_ALIVE: 'sidecar-alive',
  SIDECAR_DOWN_HOST_UP: 'sidecar-down-host-up',
  NO_INJECTABLE_HOST: 'no-injectable-host',
});

export const LOG_EVENT = Object.freeze({
  BOOT: 'boot',
  DECISION_START: 'decision-start',
  DECISION_WAIT: 'decision-wait',
  ERROR: 'error',
  EXIT: 'exit',
});

const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

// ---- the decision (pure, exported for tests) ------------------------------
// The ONLY thing this watchdog decides. Both inputs are already-resolved probe booleans; the caller
// decides how to probe. `httpProbe9331` may be null/undefined, meaning "not probed" (the 4231
// branch already decided), and any non-true value means "no injectable host".
export function decide({ httpProbe4231, httpProbe9331 } = {}) {
  if (httpProbe4231) return { action: 'wait', reason: REASON.SIDECAR_ALIVE };
  if (httpProbe9331) return { action: 'start-sidecar', reason: REASON.SIDECAR_DOWN_HOST_UP };
  return { action: 'wait', reason: REASON.NO_INJECTABLE_HOST };
}

// A state's identity for change-detection. Repeated 'wait' collapses to one log line; repeated
// start attempts are distinguished by the attempt counter so a sidecar that refuses to come up
// produces one line per attempt instead of silence.
export function stateKey(decision, attempts = 0) {
  const base = `${decision.action}:${decision.reason}`;
  return decision.action === 'start-sidecar' ? `${base}#${attempts}` : base;
}

// Remembers the last state so the loop logs a decision only when it CHANGES (a healthy watchdog is
// silent; a 15s "still waiting" line would bury the one line that matters).
export function createTransitionMemory(initial = null) {
  let last = initial;
  return {
    get last() { return last; },
    // true (and consumes the state) exactly when this state differs from the previous one
    shouldLog(state) {
      if (state === last) return false;
      last = state;
      return true;
    },
    reset() { last = null; },
  };
}

// ---- logging --------------------------------------------------------------
// One line per event: "<UTC ISO> <event> <detail>". Write failures are swallowed: a watchdog that
// dies because its log is unwritable would be the exact failure it exists to prevent.
export function createLogger({
  logPath = LOG_PATH, now = () => new Date().toISOString(), onLine = null,
} = {}) {
  return function log(event, detail = '') {
    const line = `${now()} ${oneLine(event)} ${oneLine(detail)}`.trimEnd() + '\n';
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line, 'utf8');
    } catch { /* logging must never take the watchdog down */ }
    if (onLine) { try { onLine(line); } catch { /* ditto */ } }
    return line;
  };
}

// ---- probes ---------------------------------------------------------------
async function getWithTimeout(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// "Is something listening on 4231?" — ANY HTTP response counts, including 403/404/500: those prove
// a server accepted the connection. Only a connection-level failure means "not listening".
export async function probeSidecar({
  fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, port = API_PORT, url = null,
} = {}) {
  try {
    const res = await getWithTimeout(url || `http://127.0.0.1:${port}/`, timeoutMs, fetchImpl);
    try { await res.arrayBuffer(); } catch { /* body is irrelevant; drain best-effort */ }
    return true;
  } catch {
    return false;
  }
}

// "Is there an injectable host?" — CDP must answer /json/version with real JSON carrying a Browser
// field. A non-200, a non-JSON body, or JSON without Browser is NOT an injectable host.
export async function probeCdp({
  fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS, port = CDP_PORT, path = '/json/version', url = null,
} = {}) {
  try {
    const res = await getWithTimeout(url || `http://127.0.0.1:${port}${path}`, timeoutMs, fetchImpl);
    if (!res.ok) { try { await res.arrayBuffer(); } catch { /* ignore */ } return false; }
    const data = await res.json();
    return !!(data && typeof data === 'object' && !Array.isArray(data)
      && typeof data.Browser === 'string' && data.Browser.trim() !== '');
  } catch {
    return false;
  }
}

// ---- singleton lock -------------------------------------------------------
// process.kill(pid, 0) is the portable existence probe: ESRCH => gone, EPERM => alive but not ours.
export function isProcessAlive(pid, killImpl = (...args) => process.kill(...args)) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try { killImpl(n, 0); return true; }
  catch (error) { return !!(error && error.code === 'EPERM'); }
}

// A lock that cannot be parsed, carries a bogus pid, or belongs to a dead process is stale.
// ENOENT is the only clean "no lock" answer.
export function readLock(lockPath = LOCK_PATH) {
  let raw;
  try { raw = readFileSync(lockPath, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, pid: null, valid: false };
    return { exists: true, pid: null, valid: false, reason: 'unreadable-lock', error: String(error && error.message || error) };
  }
  let data = null;
  try { data = JSON.parse(raw); } catch { return { exists: true, pid: null, valid: false, reason: 'malformed-lock', raw }; }
  const pid = Number(data && data.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { exists: true, pid: null, valid: false, reason: 'malformed-lock', raw };
  return { exists: true, pid, valid: true, startedAt: String(data.startedAt || ''), raw };
}

// Returns { acquired: false, holderPid } when a LIVE watchdog already owns the lock; removes and
// replaces a stale lock; creates atomically ('wx') so two simultaneous boots cannot both win.
export function acquireLock({
  lockPath = LOCK_PATH, pid = process.pid, isAlive = isProcessAlive,
  now = () => new Date().toISOString(), mkdir = mkdirSync, write = writeFileSync, remove = rmSync,
  attempts = 3,
} = {}) {
  try { mkdir(dirname(lockPath), { recursive: true }); } catch { /* already there */ }
  for (let tryNo = 1; tryNo <= attempts; tryNo++) {
    const existing = readLock(lockPath);
    if (existing.exists && existing.valid && isAlive(existing.pid)) {
      return { acquired: false, lockPath, holderPid: existing.pid, reason: 'lock-held-by-live-process' };
    }
    if (existing.exists) { try { remove(lockPath, { force: true }); } catch { /* fall through to wx */ } }
    try {
      write(lockPath, `${JSON.stringify({ pid, startedAt: now() })}\n`, { encoding: 'utf8', flag: 'wx' });
      return { acquired: true, lockPath, pid, staleRemoved: existing.exists, staleReason: existing.reason || null };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      // Lost a creation race: the other writer's lock is re-read on the next pass.
    }
  }
  const last = readLock(lockPath);
  return { acquired: false, lockPath, holderPid: last.pid, reason: 'lock-race-unresolved' };
}

// Only ever removes OUR OWN lock: a delayed SIGTERM must not delete a successor's lock.
export function releaseLock({ lockPath = LOCK_PATH, pid = process.pid, remove = rmSync } = {}) {
  const current = readLock(lockPath);
  if (!current.exists) return { released: false, reason: 'no-lock' };
  if (current.pid !== pid) return { released: false, reason: 'lock-owned-by-other-pid', holderPid: current.pid };
  try { remove(lockPath, { force: true }); } catch (error) {
    return { released: false, reason: 'remove-failed', error: String(error && error.message || error) };
  }
  return { released: true, lockPath, pid };
}

// ---- sidecar start --------------------------------------------------------
// --no-launch is passed deliberately: the watchdog supervises the sidecar, it never starts or
// replaces the host application. sidecar.mjs also refuses to rebind a busy 4231 (exit 1), so a
// double start cannot quietly produce a second API owner.
export function sidecarArgv({ sidecarPath = SIDECAR_PATH, extraArgs = ['--no-launch'] } = {}) {
  return [sidecarPath, ...extraArgs];
}

// Detached start: the sidecar must OUTLIVE the watchdog (reparented, own session), otherwise
// SIGTERM to the watchdog would take the thing it is healing down with it.
export async function startSidecar({
  sidecarPath = SIDECAR_PATH, nodeExec = process.execPath, childLogPath = CHILD_LOG_PATH,
  spawnImpl = spawn, open = openSync, close = closeSync, timeoutMs = SPAWN_TIMEOUT_MS,
  extraArgs = ['--no-launch'],
} = {}) {
  let out = null;
  let err = null;
  try {
    mkdirSync(dirname(childLogPath), { recursive: true });
    out = open(childLogPath, 'a');
    err = open(childLogPath, 'a');
  } catch (error) {
    for (const fd of [out, err]) { try { if (fd !== null) close(fd); } catch { /* ignore */ } }
    return { started: false, error: `cannot open child log ${childLogPath}: ${error && error.message || error}` };
  }
  let child;
  try {
    child = spawnImpl(nodeExec, sidecarArgv({ sidecarPath, extraArgs }), {
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
      env: process.env,
    });
  } catch (error) {
    try { close(out); close(err); } catch { /* ignore */ }
    return { started: false, error: `spawn threw: ${error && error.message || error}` };
  }
  const argv = sidecarArgv({ sidecarPath, extraArgs });
  const outcome = await new Promise((settle) => {
    let done = false;
    const timer = setTimeout(() => finish({ started: false, error: 'spawn-confirmation-timeout', pid: child && child.pid }), timeoutMs);
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child && typeof child.removeListener === 'function') {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
      }
      settle(result);
    }
    const onSpawn = () => finish({ started: true, pid: child.pid });
    const onError = (error) => finish({ started: false, error: `spawn error: ${error && error.message || error}`, pid: child && child.pid });
    if (child && typeof child.once === 'function') { child.once('spawn', onSpawn); child.once('error', onError); }
    else finish({ started: false, error: 'spawn returned a non-ChildProcess handle' });
  });
  // Detach: this process must not be kept alive by, nor die with, the sidecar.
  try { if (child && typeof child.unref === 'function') child.unref(); } catch { /* ignore */ }
  // A later async 'error' with no listener is an uncaught exception; swallow it after we settled.
  try { if (child && typeof child.on === 'function') child.on('error', () => {}); } catch { /* ignore */ }
  try { close(out); close(err); } catch { /* ignore */ }
  return outcome.started
    ? { started: true, pid: outcome.pid, argv, nodeExec, childLogPath }
    : { started: false, error: outcome.error, pid: outcome.pid ?? null, argv, nodeExec, childLogPath };
}

// ---- one iteration --------------------------------------------------------
// Shared by --once and the loop, so both are covered by the same tests. Every dependency is
// injected: nothing here binds a real port or starts a real process by default in tests.
export async function runOnce({
  probe4231 = probeSidecar, probe9331 = probeCdp, startSidecarImpl = startSidecar,
  memory = createTransitionMemory(), attempts = 0, logger = () => {},
  waitAfterStartMs = 0, sleepImpl = sleep, sidecarPath = SIDECAR_PATH,
  nodeExec = process.execPath, childLogPath = CHILD_LOG_PATH,
} = {}) {
  let decision = null;
  let attemptsOut = attempts;
  let state = null;
  let logged = false;
  let spawnResult = null;
  try {
    const httpProbe4231 = await probe4231();
    // 9331 is only probed when 4231 is silent: an answer from the sidecar already decides the round.
    const httpProbe9331 = httpProbe4231 ? null : await probe9331();
    decision = decide({ httpProbe4231, httpProbe9331 });
    const starting = decision.action === 'start-sidecar';
    attemptsOut = starting ? attempts + 1 : 0;
    state = stateKey(decision, attemptsOut);
    logged = memory.shouldLog(state);
    if (logged) {
      const probeDetail = `sidecar-4231-listening=${httpProbe4231 === true} cdp-9331-reachable=${httpProbe9331 === true}`
        + (starting ? ` attempt=${attemptsOut} sidecar=${sidecarPath} node=${nodeExec}` : '');
      logger(starting ? LOG_EVENT.DECISION_START : LOG_EVENT.DECISION_WAIT, `${decision.reason} ${probeDetail}`);
    }
    if (!starting) return { decision, action: decision.action, reason: decision.reason, state, logged, attempts: attemptsOut, spawn: null, error: null };
    spawnResult = await startSidecarImpl({ sidecarPath, nodeExec, childLogPath, logger, attempts: attemptsOut, reason: decision.reason });
    if (spawnResult && spawnResult.started) {
      logger(LOG_EVENT.DECISION_START, `${decision.reason} attempt=${attemptsOut} outcome=started pid=${spawnResult.pid}`);
    } else {
      const why = (spawnResult && spawnResult.error) || 'unknown-spawn-failure';
      logger(LOG_EVENT.ERROR, `${decision.reason} attempt=${attemptsOut} outcome=failed ${why}`);
    }
    // Never look at 4231 sooner than one full interval after the spawn: the sidecar needs time to
    // bind, and an immediate re-probe would only produce a duplicate start.
    if (waitAfterStartMs > 0) await sleepImpl(waitAfterStartMs);
    return { decision, action: decision.action, reason: decision.reason, state, logged, attempts: attemptsOut, spawn: spawnResult, error: null };
  } catch (error) {
    // One bad round must never stop the watchdog.
    const message = error && error.message || String(error);
    logger(LOG_EVENT.ERROR, `round-failed ${message}`);
    return { decision, action: null, reason: null, state, logged, attempts: attemptsOut, spawn: spawnResult, error: message };
  }
}

// ---- the loop -------------------------------------------------------------
export function createStopper() {
  let stopped = false;
  let notify = () => {};
  const done = new Promise((r) => { notify = r; });
  return {
    get stopped() { return stopped; },
    stop() { if (stopped) return; stopped = true; notify(); },
    done,
  };
}

export async function runWatchdog({
  intervalMs = DEFAULT_INTERVAL_MS, stopper = createStopper(), memory = createTransitionMemory(),
  logger = createLogger(), runOnceImpl = runOnce, ...runOnceOptions
} = {}) {
  const shared = { ...runOnceOptions, memory, logger };
  let attempts = 0;
  logger(LOG_EVENT.BOOT, `pid=${process.pid} interval=${intervalMs}ms sidecar=${SIDECAR_PATH} api-port=${API_PORT} cdp-port=${CDP_PORT} log=${LOG_PATH}`);
  while (!stopper.stopped) {
    try {
      // runOnce already contains its own failures; this outer guard is the one that matters when
      // something unforeseen throws — the loop must outlive it, whatever it was.
      const result = await runOnceImpl({ ...shared, attempts, waitAfterStartMs: intervalMs });
      if (result && Number.isSafeInteger(result.attempts)) attempts = result.attempts;
    } catch (error) {
      logger(LOG_EVENT.ERROR, `round-threw ${error && error.message || error}`);
    }
    if (stopper.stopped) break;
    // Interruptible sleep: SIGINT/SIGTERM must not have to wait out a 15s tick.
    await Promise.race([sleep(intervalMs), stopper.done]);
  }
  logger(LOG_EVENT.EXIT, `pid=${process.pid} rounds-completed last-state=${memory.last} reason=stopped`);
  return { attempts, lastState: memory.last };
}

// ---- scheduled task installation -----------------------------------------
export async function installTask({
  spawnSyncImpl = spawnSync, scriptPath = INSTALLER_PATH, check = existsSync, platform = process.platform,
} = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'windows-only', platform };
  if (!check(scriptPath)) return { ok: false, reason: 'installer-missing', scriptPath };
  const file = 'powershell.exe';
  const args = ['-NoProfile', '-NonInteractive', '-File', scriptPath];
  let result;
  try { result = spawnSyncImpl(file, args, { stdio: 'inherit', windowsHide: true, encoding: 'utf8' }); }
  catch (error) { return { ok: false, reason: 'spawn-failed', error: String(error && error.message || error) }; }
  return { ok: result && result.status === 0, status: result ? result.status : null, signal: result ? result.signal : null, file, args, scriptPath };
}

// ---- CLI ------------------------------------------------------------------
export const USAGE = `mmx-workflow-pipeline sidecar watchdog
  node sidecar-watchdog.mjs [--once] [--interval-ms N] [--install-task] [--help]
    --once           run exactly one decision round and exit (troubleshooting / smoke test)
    --interval-ms N  loop period in ms (default ${DEFAULT_INTERVAL_MS}, minimum ${MIN_INTERVAL_MS})
    --install-task   register the per-user logon scheduled task (Windows, no admin required)
  sidecar: ${SIDECAR_PATH}
  logs:    ${LOG_PATH} | ${CHILD_LOG_PATH} | lock: ${LOCK_PATH}`;

export function parseArgs(argv = []) {
  const out = { once: false, installTask: false, help: false, intervalMs: DEFAULT_INTERVAL_MS };
  const valueAfter = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value === '' || String(value).startsWith('--')) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') out.once = true;
    else if (arg === '--install-task') out.installTask = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--interval-ms') { out.intervalMs = parseInterval(valueAfter(++i, arg)); }
    else if (arg.startsWith('--interval-ms=')) out.intervalMs = parseInterval(arg.slice('--interval-ms='.length));
    else throw new Error('Unknown watchdog argument: ' + arg);
  }
  return out;
}

function parseInterval(raw) {
  if (!/^\d+$/.test(String(raw))) throw new Error('Invalid --interval-ms: expected a positive integer number of milliseconds.');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < MIN_INTERVAL_MS) throw new Error(`Invalid --interval-ms: must be >= ${MIN_INTERVAL_MS}.`);
  return n;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) { console.error('[sidecar-watchdog]', error.message); console.error(USAGE); return 2; }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.installTask) {
    const result = await installTask();
    console.log('[sidecar-watchdog] install-task:', JSON.stringify({ ok: result.ok, status: result.status ?? null, reason: result.reason ?? null, scriptPath: result.scriptPath ?? INSTALLER_PATH }));
    if (!result.ok) console.error('[sidecar-watchdog] registration failed — run scripts/install-watchdog-task.ps1 manually and read its output.');
    return result.ok ? 0 : 1;
  }

  const logger = createLogger({ onLine: (line) => { if (args.once) process.stdout.write(line); } });
  const lock = acquireLock();
  if (!lock.acquired) {
    // Another watchdog is healthy: exiting 0 keeps ONLOGON re-registration idempotent. The refusal
    // is still recorded, so a task that keeps re-launching a second copy is visible in the log.
    logger(LOG_EVENT.BOOT, `pid=${process.pid} mode=${args.once ? 'once' : 'loop'} refused=${lock.reason} holder=${lock.holderPid ?? 'unknown'}`);
    console.log(`[sidecar-watchdog] another watchdog already owns ${LOCK_PATH} (pid ${lock.holderPid}); exiting.`);
    return 0;
  }
  const stopper = createStopper();
  const onSignal = (signal) => { logger(LOG_EVENT.EXIT, `signal=${signal}`); stopper.stop(); };
  const sigint = () => onSignal('SIGINT');
  const sigterm = () => onSignal('SIGTERM');
  if (!args.once) {
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
  }
  let result = null;
  try {
    if (args.once) {
      logger(LOG_EVENT.BOOT, `pid=${process.pid} mode=once`);
      result = await runOnce({ logger });
      logger(LOG_EVENT.EXIT, `pid=${process.pid} mode=once action=${result.action ?? 'error'} reason=${result.reason ?? 'error'}`);
    } else {
      result = await runWatchdog({ intervalMs: args.intervalMs, stopper, logger });
    }
  } catch (error) {
    logger(LOG_EVENT.ERROR, `fatal ${error && error.message || error}`);
    result = { error: String(error && error.message || error) };
  } finally {
    process.removeListener('SIGINT', sigint);
    process.removeListener('SIGTERM', sigterm);
    const released = releaseLock();
    if (!released.released) logger(LOG_EVENT.ERROR, `lock-not-released ${released.reason} holder=${released.holderPid ?? 'unknown'}`);
  }
  if (args.once) console.log(`[sidecar-watchdog] ${result.action ?? 'error'} ${result.reason ?? result.error ?? ''}`.trimEnd());
  return result && result.error ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error('[sidecar-watchdog] uncaught:', error && error.stack || error);
    process.exitCode = 1;
  });
}
