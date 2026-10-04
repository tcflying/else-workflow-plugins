import { execFile, spawn } from 'node:child_process';
import { readFileSync, existsSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
let snapshot = new Map(), checkedAt = 0, checking;
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function creationTimes(fresh) {
  if (checking) return checking;
  if (!fresh && Date.now() - checkedAt < 5000) return snapshot;
  checking = (async () => {
    try {
      if (process.platform === 'win32') {
        const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { [pscustomobject]@{pid=$_.ProcessId;start=$_.CreationDate.ToUniversalTime().ToString("o")} } }) | ConvertTo-Json -Compress';
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 7000, windowsHide: true, maxBuffer: 1024 * 1024 });
        const rows = JSON.parse(stdout.trim() || '[]');
        snapshot = new Map((Array.isArray(rows) ? rows : [rows]).map((r) => [Number(r.pid), Date.parse(r.start)]));
      } else {
        const { stdout } = await exec('ps', ['-eo', 'pid=,lstart='], { timeout: 5000, env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1024 * 1024 });
        snapshot = new Map(stdout.trim().split('\n').map((line) => {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          return match ? [Number(match[1]), Date.parse(match[2])] : [0, NaN];
        }));
      }
    } catch { snapshot = new Map(); }
    checkedAt = Date.now();
    return snapshot;
  })().finally(() => { checking = null; });
  return checking;
}
export async function processIdentity(state, fresh = false) {
  const pid = Number(state?.pid), alive = pidAlive(pid);
  if (!alive) return { alive: false, reused: false };
  const started = Date.parse(state?.startedAt);
  if (!Number.isFinite(started)) return { alive: true, reused: false, verified: false };
  const created = pid === process.pid ? Date.now() - process.uptime() * 1000 : (await creationTimes(fresh)).get(pid);
  const reused = Number.isFinite(created) && created > started + 1000;
  return { alive: !reused, reused, verified: Number.isFinite(created) };
}

export function sameStateIdentity(a, b) {
  return !!a && !!b && ['startedAt', 'pid', 'runId', 'cwd', 'scriptPath', 'backend', 'concurrency', 'maxAgentCalls'].every((key) => a[key] === b[key]);
}
const stale = (error) => ({ status: 409, body: { ok: false, code: 'STALE_LIFECYCLE', error } });
const normRunPath = (p) => {
  let s = String(p);
  if (process.platform === 'win32') s = s.toLowerCase();
  return s.replace(/\\/g, '/').replace(/\/+$/, '');
};

// F16: bind the addressed entry to the real run directory. The engine always resolves a run as
// <cwd>/.qoder/workflow-runs/<runId> (RUNS_DIR in wf.mjs), so a state whose cwd names another
// workspace makes the addressed entry and the directory the engine will really act on diverge:
// the host would read one run's files and resume a different run. A missing state.cwd falls back
// to the addressed directory's own runs root — the same fallback the spawn below uses — so a
// legacy state without cwd stays resumable. Compared after realpath, never as raw strings.
export function runDirBinding(dir, state, runId) {
  const id = String(runId || '');
  if (!/^[\w.-]+$/.test(id)) return { ok: false, reason: `invalid run id "${id}": a run id is a name, not a path` };
  const cwd = state && state.cwd ? String(state.cwd) : resolve(String(dir), '..', '..', '..');
  const engineDir = resolve(cwd, '.qoder', 'workflow-runs', id);
  let addressed = null;
  try { addressed = realpathSync(resolve(String(dir))); } catch {}
  // The addressed directory is gone: there is no identity to compare, and the read/write paths
  // already report that as 404. Refusing here would only change an existing, covered answer.
  if (!addressed) return { ok: true };
  let real = null;
  try { real = realpathSync(engineDir); } catch {}
  if (real && normRunPath(addressed) === normRunPath(real)) return { ok: true };
  return { ok: false, reason: `this run entry (${addressed}) is not the run directory its own state addresses (${real || engineDir}); refusing to read or resume another workspace` };
}

function readLifecycleFiles(dir) {
  try {
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const progress = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
    if (!state || !progress || typeof state !== 'object' || typeof progress !== 'object') throw new Error('invalid lifecycle files');
    return { state, progress };
  } catch { return { error: stale('state.json or progress.json is unreadable; refusing to resume') }; }
}

export async function resumeRun(dir, runId, state, engine, expectedStartedAt, hooks = {}) {
  const before = readLifecycleFiles(dir);
  if (before.error) return before.error;
  // Before every existing guard and before the first write (pipeline-resume.log included): the
  // spawn below is addressed by runId under state.cwd, so a diverging entry must never reach it.
  const binding = runDirBinding(dir, before.state, runId);
  if (!binding.ok) return { status: 409, body: { ok: false, code: 'RUN_DIR_MISMATCH', error: binding.reason } };
  if (!sameStateIdentity(state, before.state) || (expectedStartedAt != null && String(before.progress.startedAt || '') !== String(expectedStartedAt))) {
    return stale('the requested lifecycle changed; refresh /runs and retry');
  }
  const identity = await processIdentity(before.state, true);
  if (hooks.afterIdentity) await hooks.afterIdentity();
  // Each file retains its own epoch: legacy state/progress timestamps need not be equal.
  const after = readLifecycleFiles(dir);
  if (after.error) return after.error;
  if (!sameStateIdentity(before.state, after.state) || before.progress.startedAt !== after.progress.startedAt) {
    return stale('the run lifecycle rotated during identity verification; refresh /runs and retry');
  }
  const fresh = after.state;
  const status = String(fresh.status || '');
  if (identity.reused) return { status: 409, body: { ok: false, code: 'PID_REUSED_ENGINE_GUARD', error: '旧 PID 已被其它进程复用。为避免误报或干扰其它任务，本次未恢复。未终止任何进程，也未修改运行历史。' } };
  if (!['failed', 'cancelled', 'stale'].includes(status) && !(status === 'running' && !identity.alive)) {
    return { status: 409, body: { ok: false, error: `run is ${status}${identity.alive ? ` (pid ${fresh.pid} still alive)` : ''}: only failed/cancelled/stale (or dead running) runs can be resumed` } };
  }
  const cwd = fresh.cwd || resolve(dir, '..', '..', '..');
  if (!fresh.scriptPath || !existsSync(resolve(cwd, fresh.scriptPath))) return { status: 409, body: { ok: false, error: `script is not readable: ${fresh.scriptPath || 'missing scriptPath'}` } };
  const logPath = join(dir, 'pipeline-resume.log');
  const fd = openSync(logPath, 'a');
  let child, exited = false, code, spawnError;
  try {
    const args = [engine, 'resume', runId, '--cwd', cwd];
    if (['file', 'cli', 'echo'].includes(fresh.backend)) args.push('--backend', fresh.backend);
    if (Number.isInteger(fresh.concurrency)) args.push('--concurrency', String(fresh.concurrency));
    if (Number.isInteger(fresh.maxAgentCalls)) args.push('--max-calls', String(fresh.maxAgentCalls));
    child = spawn(process.execPath, args, { cwd, detached: true, stdio: ['ignore', fd, fd] });
    child.once('exit', (value) => { exited = true; code = value; });
    child.once('error', (error) => { spawnError = error; exited = true; });
  } finally { closeSync(fd); }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    let current;
    try { current = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')); } catch {}
    if (current && current.pid === child.pid && (current.pid !== fresh.pid || current.startedAt !== fresh.startedAt)) {
      child.unref();
      return { status: 200, body: { ok: true, spawned: true, accepted: true, status: current.status } };
    }
    if (exited) return { status: 409, body: { ok: false, code: 'ENGINE_REJECTED', error: spawnError ? String(spawnError.message) : `引擎未接受恢复（exit ${code}）；详情见 ${logPath}` } };
    await sleep(50);
  }
  child.unref();
  return { status: 504, body: { ok: false, code: 'RESUME_UNCONFIRMED', error: '恢复进程已启动，但 8 秒内未确认新生命周期；未终止该进程。请查看进度及 pipeline-resume.log，勿重复启动。' } };
}
