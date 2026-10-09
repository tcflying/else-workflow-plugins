// test/iso/iso-observer.mjs — the LIVE identity observer for the UI-isolation run.
//
// Why this file exists: iso-guard.readIsolationProof() refuses unless it is handed a fresh,
// read-only observation of the running instance, and its default is a refusal. That default is a
// guard, not an oversight — but without an observer the guard is unreachable, so no real run could
// ever be accepted. This module is the missing half: it produces the observation, and it may only
// produce it out of values the LIVE SYSTEM reports.
//
// What an observation is allowed to be built from, and nothing else:
//   * pid / start time / image / command line — ONE read-only Get-CimInstance Win32_Process query
//     for ONE pid. No process is started, stopped, injected into or attached to;
//   * debug-port owner — ONE read-only Get-NetTCPConnection query for ONE port, on loopback only.
//     It must be the recorded pid exactly. A parent/child relationship is NOT accepted: Chromium
//     spawns renderer processes, and a proof that walks a process tree proves nothing about which
//     process serves the debugger;
//   * userDataDir — parsed out of the LIVE process's own command line. It is never copied from the
//     launch report's requested value: a request is an assertion, and an assertion about a process
//     that has since died would survive every check here;
//   * runtimeDataDir — the path recorded as the child's MINIMAX_DATA_DIR, and only if the
//     directory demonstrably holds a write NEWER than this process's start time. A directory that
//     merely exists (the launcher creates it before starting the app) proves nothing.
//
// Fail-closed is the only failure mode. Every one of those five sources can come back empty,
// unreadable, ambiguous or contradictory, and each of those refuses rather than substituting a
// default, a parent process, or the requested value.
//
// Run: node test/iso/iso-observer.mjs --launch-state <file> --cdp-port <port>
// (read-only: it observes and prints, it never starts or stops anything)
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  assertCdpPortAllowed, assertInsideArtifacts, isDirectRun, parseStrictArgs,
  LAUNCH_STATE_FILE, IsolationRefused,
} from './iso-guard.mjs';

const refuse = (message) => { throw new IsolationRefused(message); };

// ---- the two read-only OS queries ---------------------------------------------

// Sent as a single -EncodedCommand payload rather than an argument list or stdin. The script
// contains an absolute path with a space, a Chinese path segment and double quotes; -EncodedCommand
// is base64 of UTF-16LE and therefore carries all of that byte-exact with no quoting layer at all.
//
// Bounded: one pid in, one port in, a timeout on the child. No execution policy is touched — there
// is no -ExecutionPolicy Bypass here and no Unblock-File, so the host's own policy governs this
// script exactly as it governs everything else the operator runs.
const POWERSHELL = process.env.MMX_ISO_PWSH || 'pwsh';
const POWERSHELL_TIMEOUT_MS = 15000;

/**
 * ONE Win32_Process row for ONE pid. Emits `{}` when nothing matches.
 * Returns only non-secret identity facts; the raw command line is kept because it IS the evidence.
 */
export function processQueryScript(processId) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$row = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${Number(processId)}" -ErrorAction SilentlyContinue)[0]`,
    'if ($null -eq $row) { "{}" } else {',
    '  [pscustomobject]@{',
    '    processId = [int]$row.ProcessId',
    "    creationDate = $(if ($row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') } else { '' })",
    '    executablePath = [string]$row.ExecutablePath',
    '    commandLine = [string]$row.CommandLine',
    '  } | ConvertTo-Json -Compress',
    '}',
  ].join('\n');
}

/** ONE listener row set for ONE port. Read-only; never binds, never probes, never connects. */
export function portOwnerQueryScript(port) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = @(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue |`,
    '  Select-Object -Property LocalAddress, LocalPort, OwningProcess)',
    "if ($rows.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject @($rows) -Compress }",
  ].join('\n');
}

const stripBom = (text) => String(text ?? '').replace(/^\uFEFF/, '');

/**
 * Execute one of the two scripts above. Exported so the DEFAULT wiring is unit-testable by
 * reference (an injected transport alone would never prove the default is the real runner).
 */
export function runPowerShell(request) {
  const script = request && request.script;
  if (typeof script !== 'string' || !script.trim()) {
    refuse('iso-observer: an OS query must carry a script');
  }
  const bin = (request && request.binary) || POWERSHELL;
  try {
    return execFileSync(bin, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      input: '', encoding: 'utf8', timeout: (request && request.timeoutMs) || POWERSHELL_TIMEOUT_MS,
      windowsHide: true, maxBuffer: 1 << 20, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A missing PowerShell, a policy that blocks it, or a query that failed are all the same thing
    // here: the observation could not be taken, so nothing may be injected.
    refuse(`iso-observer: the read-only OS query (${(request && request.kind) || 'unknown'}) could not be run with ${bin} — ${(error && (error.code || error.message)) || error}. Install PowerShell 7 or inject deps.runPowerShell; this observation is never guessed.`);
  }
}

/** Defensive parse of one process row. `{}` / `[]` / `null` / junk all mean "not observable". */
export function parseProcessQuery(text) {
  let parsed;
  try { parsed = JSON.parse(stripBom(text)); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const processId = Number(parsed.processId ?? parsed.ProcessId);
  if (!Number.isInteger(processId) || processId < 1) return null;
  return {
    processId,
    creationDate: String(parsed.creationDate ?? parsed.CreationDate ?? ''),
    executablePath: String(parsed.executablePath ?? parsed.ExecutablePath ?? ''),
    commandLine: String(parsed.commandLine ?? parsed.CommandLine ?? ''),
  };
}

/** Defensive parse of the listener rows. ConvertTo-Json unwraps a one-element array; re-wrap it. */
export function parsePortOwners(text) {
  let parsed;
  try { parsed = JSON.parse(stripBom(text)); }
  catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
  return rows.map((row) => ({
    localAddress: String(row.LocalAddress ?? row.localAddress ?? ''),
    localPort: Number(row.LocalPort ?? row.localPort),
    owningProcess: Number(row.OwningProcess ?? row.owningProcess),
  })).filter((row) => Number.isInteger(row.owningProcess) && row.owningProcess > 0);
}

// ---- command line parsing -----------------------------------------------------

// A quote-aware tokeniser, because that is what the command line actually is. ProcessStartInfo's
// ArgumentList quotes a whole argument when it contains a space, so the live line looks like
// `"--user-data-dir=C:\path with space\dir"`, while a path that needs no quoting appears bare.
// Scanning for a regex over the raw string gets one of those two forms wrong; tokenising gets both.
// Backslash-escaped quotes are handled the way the CRT parses them.
export function splitCommandLine(text) {
  const source = String(text ?? '');
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && source[i + 1] === '"') { current += '"'; i += 1; started = true; continue; }
    if (ch === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

const flagValue = (tokens, flag) => {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const eq = token.indexOf('=');
    if (eq > 0 && token.slice(0, eq).toLowerCase() === flag) return token.slice(eq + 1).trim();
    if (token.toLowerCase() === flag) return String(tokens[i + 1] ?? '').trim();
  }
  return '';
};

/** The `--user-data-dir` the LIVE process was actually started with, or '' when absent. */
export function userDataDirFromCommandLine(commandLine) {
  return flagValue(splitCommandLine(commandLine), '--user-data-dir');
}

/** The `--remote-debugging-port` the LIVE process was actually started with, or null when absent. */
export function debugPortFromCommandLine(commandLine) {
  const raw = flagValue(splitCommandLine(commandLine), '--remote-debugging-port');
  const port = Number(raw);
  return raw && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// ---- the runtime-data freshness gate ------------------------------------------

// Bounded on purpose. The gate answers one question — "did anything land in this directory AFTER
// the process started?" — and a directory tree with no end would turn a check into an outage. The
// ceiling is a REFUSAL, not a truncation: a scan that could not finish is a partial proof, and a
// partial proof is not a proof.
export const MAX_SCAN_ENTRIES = 2000;
export const SCAN_DEPTH = 2;
// Filesystem timestamps and the process start time come from two different clocks and are rounded
// differently. A small window absorbs that rounding and nothing else: it cannot turn a directory
// that was last written a minute before the launch into evidence for this instance.
export const RUNTIME_WRITE_TOLERANCE_MS = 2000;

/**
 * Newest mtime under `dir`, read-only (statSync + readdirSync only — never a write, never a create).
 * Returns { exists, newestMs, truncated, entries }.
 */
export function newestWriteMs(dir, fs, { depth = SCAN_DEPTH, maxEntries = MAX_SCAN_ENTRIES } = {}) {
  let newestMs = -Infinity;
  let entries = 0;
  let truncated = false;
  let exists = false;
  const gone = (error) => Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  const visit = (node) => {
    let stat;
    try { stat = fs.statSync(node.path); }
    catch (error) { if (gone(error)) return false; throw error; }
    exists = true;
    const mtime = Number(stat && stat.mtimeMs);
    if (Number.isFinite(mtime) && mtime > newestMs) newestMs = mtime;
    if (node.level >= depth) return true;
    let children;
    try { children = fs.readdirSync(node.path, { withFileTypes: true }); }
    catch (error) { if (gone(error)) return true; throw error; }
    for (const child of children || []) {
      if (entries >= maxEntries) { truncated = true; return false; }
      entries += 1;
      if (child && typeof child.isDirectory === 'function' && child.isDirectory()) {
        if (!visit({ path: join(node.path, child.name), level: node.level + 1 })) return false;
      }
    }
    return true;
  };
  visit({ path: String(dir), level: 0 });
  return { exists, newestMs: Number.isFinite(newestMs) ? newestMs : null, truncated, entries };
}

// ---- dependencies -------------------------------------------------------------

/**
 * Select the dependencies so the DEFAULT path is explicit rather than a self-referential closure.
 * Exported so the default wiring itself is unit-testable.
 */
export function selectObserverDeps(deps = {}) {
  return {
    runPowerShell: deps.runPowerShell || runPowerShell,
    fs: deps.fs || { readFileSync, statSync, readdirSync },
  };
}

// ---- the observation ----------------------------------------------------------

const toUtcIso = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
};

const readLaunchState = (launchState, fs) => {
  let text;
  try { text = fs.readFileSync(launchState, 'utf8'); }
  catch (error) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the launch report ${launchState} cannot be read (${(error && (error.code || error.message)) || error}); nothing will be observed on the strength of a file that is not there`);
  }
  try {
    const doc = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a JSON object');
    return doc;
  } catch (error) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the launch report ${launchState} is not a readable JSON object (${error.message}); this observation is refused rather than approximated`);
  }
};

/**
 * Produce the live identity fields iso-guard.verifyLiveIdentity() compares against the report.
 *
 * Refuses (throws IsolationRefused) on every "cannot be observed" case. It never returns a
 * partially filled record: an empty field and a missing field are the same decision, and the
 * guard turns both into a refusal.
 */
export function observeLiveIdentity({ pid, debugPort, launchState }, deps = {}) {
  const { runPowerShell: run, fs } = selectObserverDeps(deps);

  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid < 1) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the launch report carries no usable pid (${JSON.stringify(pid)}); refusing to observe a process`);
  }
  const port = Number(debugPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the launch report carries no usable debug port (${JSON.stringify(debugPort)}); refusing to observe a listener`);
  }
  assertCdpPortAllowed(port, 'observed debug port');

  const doc = readLaunchState(launchState, fs);
  // The report read here and the report the guard compares against must be the SAME instance. The
  // guard re-reads the file; if the two disagreed, this function could certify a process the guard
  // never checks, so the disagreement is a refusal rather than a shrug.
  if (Number(doc.pid) !== targetPid) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the launch report ${launchState} describes pid ${doc.pid}, but an observation of pid ${targetPid} was requested; they do not match`);
  }
  const observed = (doc.observed && typeof doc.observed === 'object') ? doc.observed : {};

  // --- 1. the live process -----------------------------------------------------
  const proc = parseProcessQuery(run({ kind: 'process', processId: targetPid, script: processQueryScript(targetPid) }));
  if (!proc) {
    refuse(`STALE_ISOLATION_PROOF: no live process is observable for pid ${targetPid} right now — it has exited, or the query returned nothing. A pid that cannot be read cannot prove it is the instance that was launched`);
  }
  if (proc.processId !== targetPid) {
    refuse(`STALE_ISOLATION_PROOF: the process query answered for pid ${proc.processId}, not the requested pid ${targetPid}`);
  }
  const startTimeUtc = toUtcIso(proc.creationDate);
  if (!startTimeUtc) {
    refuse(`STALE_ISOLATION_PROOF: the live creation time of pid ${targetPid} is empty or unparseable (${JSON.stringify(proc.creationDate)}); without a start time a recycled pid is indistinguishable from the original`);
  }
  if (!proc.executablePath.trim()) {
    refuse(`STALE_ISOLATION_UNPROVEN: the live process image (ExecutablePath) of pid ${targetPid} is empty; without it the process cannot be identified, so this is refused`);
  }
  const exe = proc.executablePath.trim();

  // --- 2. the userDataDir the process was ACTUALLY given ------------------------
  const userDataDir = userDataDirFromCommandLine(proc.commandLine);
  if (!userDataDir) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the live command line of pid ${targetPid} carries no --user-data-dir argument, so the actual userDataDir cannot be observed. The launch report's userDataDir is what was REQUESTED, not what the process holds, so it is not used as a substitute`);
  }
  const livePort = debugPortFromCommandLine(proc.commandLine);
  if (livePort === null) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the live command line of pid ${targetPid} carries no --remote-debugging-port argument, so this process cannot be shown to be the one serving the port under test`);
  }
  if (livePort !== port) {
    refuse(`STALE_ISOLATION_PROOF: the live process was started with --remote-debugging-port=${livePort}, not the port ${port} under test`);
  }

  // --- 3. who holds the debug port RIGHT NOW -----------------------------------
  const owners = parsePortOwners(run({ kind: 'port', port, script: portOwnerQueryScript(port) }));
  if (!owners.length) {
    refuse(`STALE_ISOLATION_PROOF: no listener is observable on the debug port ${port} right now; a historical snapshot in the launch report is not a substitute for the live owner`);
  }
  for (const row of owners) {
    if (row.localAddress !== '127.0.0.1' && row.localAddress !== '::1') {
      refuse(`BACKEND_ISOLATION_UNPROVEN: the debug port ${port} is listening on ${row.localAddress || '(unknown)'}, not on loopback; a debugger reachable off-loopback is refused`);
    }
    // Exact pid equality. Deliberately NOT a process-tree walk: a Chromium renderer or a helper is
    // not the instance the launch report described.
    if (row.owningProcess !== targetPid) {
      refuse(`STALE_ISOLATION_PROOF: the debug port ${port} is currently owned by pid ${row.owningProcess}, not by the launch report's pid ${targetPid}`);
    }
  }

  // --- 4. runtime data this instance demonstrably wrote ------------------------
  const runtimeDataDir = String(observed.runtimeDataDir || '').trim();
  if (!runtimeDataDir) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the launch report ${launchState} carries no OBSERVED runtimeDataDir. Only an observed value may be used here — the requested child environment value is an assertion, not an observation of where runtime data landed`);
  }
  const startMs = Date.parse(toUtcIso(observed.startTimeUtc || doc.startTime));
  if (!Number.isFinite(startMs)) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: neither the launch report nor its observation block carries a parseable start time, so "written after the start" cannot be decided`);
  }
  const scan = newestWriteMs(runtimeDataDir, fs);
  if (!scan.exists) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the observed runtime data directory ${runtimeDataDir} does not exist right now, so it cannot be shown that this instance wrote its runtime data there`);
  }
  if (scan.truncated) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the runtime data directory ${runtimeDataDir} hit the ${MAX_SCAN_ENTRIES}-entry scan ceiling before it could be fully read; a partial proof is refused, not reported as a pass`);
  }
  if (scan.newestMs === null || scan.newestMs + RUNTIME_WRITE_TOLERANCE_MS < startMs) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the newest entry under the observed runtime data directory ${runtimeDataDir} is ${scan.newestMs === null ? '(unreadable)' : new Date(scan.newestMs).toISOString()}, which predates the process start ${new Date(startMs).toISOString()}. An older directory may be left over from a previous run and proves nothing about this instance`);
  }

  return {
    pid: proc.processId,
    startTimeUtc,
    exe,
    debugPortOwnerPid: owners[0].owningProcess,
    userDataDir,
    runtimeDataDir,
  };
}

/**
 * The `observe` function iso-guard.readIsolationProof() calls: `observe({ pid, debugPort, file })`.
 * The launch state is closed over, so the caller cannot redirect the evidence to another file.
 */
export function createObserver({ launchState = LAUNCH_STATE_FILE, cdpPort, deps = {} } = {}) {
  const state = assertInsideArtifacts(launchState, 'observed launch report path');
  const port = cdpPort == null ? null : assertCdpPortAllowed(cdpPort, 'observed cdp port');
  const inner = deps;
  return (hint = {}) => observeLiveIdentity({
    pid: hint.pid,
    debugPort: hint.debugPort == null ? port : hint.debugPort,
    launchState: state,
  }, inner);
}

// ---- CLI ----------------------------------------------------------------------

const SPEC = {
  '--launch-state': String,
  '--cdp-port': String,
  '--quiet': 'boolean',
};

const USAGE = `mmx UI-isolation identity observer (read-only)
  node test/iso/iso-observer.mjs --launch-state <file> --cdp-port <port>

  --launch-state <file>  REQUIRED. The launch report to observe against. Must stay inside the
                         isolation artifacts directory.
  --cdp-port <port>      The port under test. 4231 / 9331 / 19080 are refused.
  --quiet                Print nothing; only the exit code.
  --help

It starts nothing, stops nothing, injects nothing and binds nothing. It performs exactly two
read-only OS queries (one pid, one port) and one bounded read-only directory scan, and prints the
live identity it could actually establish. Exit 0 observed, 2 refused/unobservable.`;

export function parseObserverArgs(argv) {
  const args = parseStrictArgs(argv, SPEC, { name: 'iso-observer' });
  if (args.help) return { help: true };
  if (!args['--launch-state']) {
    throw new IsolationRefused('iso-observer: --launch-state is required; without the report there is nothing to observe against');
  }
  if (!args['--cdp-port']) {
    throw new IsolationRefused('iso-observer: --cdp-port is required; this tool never guesses which port is under test');
  }
  return {
    help: false,
    launchState: assertInsideArtifacts(args['--launch-state'], 'observed launch report path'),
    cdpPort: assertCdpPortAllowed(args['--cdp-port']),
    quiet: args['--quiet'] === true,
  };
}

export function observeReport(options, deps = {}) {
  const { fs } = selectObserverDeps(deps);
  // The pid is taken from the report so the CLI can observe without being told who to look at.
  // It is still checked against the report again inside the observation.
  const doc = readLaunchState(options.launchState, fs);
  const observe = createObserver({ launchState: options.launchState, cdpPort: options.cdpPort, deps });
  const live = observe({ pid: doc.pid, debugPort: options.cdpPort, file: options.launchState });
  return { ok: true, kind: 'mmx-ui-isolation-identity-observation', launchState: options.launchState, ...live };
}

if (isDirectRun(import.meta.url)) {
  let options = null;
  try { options = parseObserverArgs(process.argv.slice(2)); }
  catch (error) {
    console.error('[iso-observer]', error.name === 'IsolationRefused' ? 'REFUSED:' : 'failed:', error.message);
    process.exitCode = 2;
  }
  if (options && options.help) { console.log(USAGE); }
  else if (options) {
    try {
      const report = observeReport(options);
      if (!options.quiet) console.log(JSON.stringify(report, null, 2));
      process.exitCode = 0;
    } catch (error) {
      console.error('[iso-observer]', error.name === 'IsolationRefused' ? 'REFUSED:' : 'failed:', error.message);
      process.exitCode = 2;
    }
  }
}