// test/ui-isolation-observer.test.mjs — PURE unit tests for the live identity observer.
//
// Run: node --test test/ui-isolation-observer.test.mjs
//
// Scope discipline: nothing here starts a process, opens a port, binds a socket or talks to a
// network. The two OS queries the real observer performs (Get-CimInstance for ONE pid,
// Get-NetTCPConnection for ONE port) are injected as a fake transport, and the filesystem walk is
// injected as a fake fs. The only real filesystem access is a stat/mtime probe inside a mkdtemp
// directory whose prefix is `iso-obs-` — no process, no port, no fixed Temp name.
//
// The point of the whole file is the NEGATIVE cases. Every field of the live observation must come
// from a fresh read of the LIVE system. A missing value, an unparseable value, or a value that came
// from the launch report's own REQUEST rather than from an observation must refuse — because a
// requested value is an assertion, and an assertion about a process that may have died is exactly
// the failure mode the injection gate exists to prevent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as nodeFs from 'node:fs';

import {
  observeLiveIdentity, createObserver, parseObserverArgs, selectObserverDeps, runPowerShell,
  processQueryScript, portOwnerQueryScript, parseProcessQuery, parsePortOwners,
  userDataDirFromCommandLine, debugPortFromCommandLine, newestWriteMs,
  MAX_SCAN_ENTRIES, RUNTIME_WRITE_TOLERANCE_MS,
} from './iso/iso-observer.mjs';
import { readIsolationProof, IsolationRefused, ARTIFACTS } from './iso/iso-guard.mjs';

const EXE = 'G:/MiniMax/MiniMax Code/MiniMax Code.exe';
const START = '2026-10-09T00:00:00.0000000Z';
const START_MS = Date.parse(START);
const PROFILE = join(ARTIFACTS, 'electron-profile');
const RUNTIME = join(ARTIFACTS, 'runtime-data');
const PID = 4242;
const API_PORT_TEXT = '4231';
const PORT = 19331;
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof IsolationRefused && (!re || re.test(e.message)), 'expected an IsolationRefused');

// ---- the launch report the launcher writes ------------------------------------
const launchDoc = (over = {}) => ({
  kind: 'mmx-ui-isolation-instance',
  isolated: true,
  backendIsolationProven: true,
  pid: PID,
  startTime: START,
  exe: EXE,
  debugPort: PORT,
  // Top level: what was REQUESTED (legacy shape, kept for the guard's comparison).
  userDataDir: PROFILE,
  runtimeDataDir: RUNTIME,
  // observed: what was actually SEEN after the launch. The runtime path may only be taken from
  // here — reading it from the top-level field would be trusting the request.
  observed: {
    observedAt: '2026-10-09T00:00:30.000Z',
    pid: PID,
    startTimeUtc: START,
    exe: EXE,
    userDataDir: PROFILE,
    commandLine: `"${EXE}" --user-data-dir=${PROFILE} --remote-debugging-port=${PORT} --remote-debugging-address=127.0.0.1`,
    debugPort: PORT,
    debugPortOwnerPid: PID,
    runtimeDataDir: RUNTIME,
    runtimeDataWrittenAfterStart: true,
  },
  ...over,
});

const processRow = (over = {}) => ({
  processId: PID,
  creationDate: START,
  executablePath: EXE,
  commandLine: `"${EXE}" --user-data-dir=${PROFILE} --remote-debugging-port=${PORT} --remote-debugging-address=127.0.0.1`,
  ...over,
});

const loopbackOwner = (over = {}) => ({ LocalAddress: '127.0.0.1', LocalPort: PORT, OwningProcess: PID, ...over });

// The fake OS transport. `req.kind` is the ONLY thing the observer tells it, so the fake stays
// readable: one process query for one pid, one listener query for one port.
const fakePwsh = ({ row = processRow(), owners = [loopbackOwner()] } = {}) => (req) => {
  if (req && req.kind === 'process') return row === null ? '{}' : JSON.stringify(row);
  if (req && req.kind === 'port') return JSON.stringify(owners);
  throw new Error(`unexpected OS query kind ${JSON.stringify(req && req.kind)}`);
};

// The fake filesystem: statSync/readdirSync only. readFileSync stays REAL so the observer reads the
// same report on disk that readIsolationProof reads — otherwise the two would disagree by
// construction and the comparison in verifyLiveIdentity would prove nothing.
const fakeStatFs = ({ mtimeMs = START_MS + 5000, exists = true, entries = [], maxEntries = MAX_SCAN_ENTRIES } = {}) => ({
  readFileSync: nodeFs.readFileSync,
  statSync: (p) => {
    if (!exists) { const e = new Error(`ENOENT: no such file or directory, stat '${p}'`); e.code = 'ENOENT'; throw e; }
    return { mtimeMs, isDirectory: () => true };
  },
  // Every entry is returned: bounding is the observer's job, and a fake that pre-slices them
  // would make the ceiling unreachable — which is exactly the case under test.
  readdirSync: () => entries.map((name) => ({ name, isDirectory: () => false })),
});

// The one temp directory this file creates, and the only prefix used.
const tmpRoot = mkdtempSync(join(tmpdir(), 'iso-obs-'));
process.on('exit', () => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

test.after(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

const observe = (over = {}, deps = {}) => observeLiveIdentity(
  { pid: PID, debugPort: PORT, launchState: over.__launchState || join(ARTIFACTS, '_selftest-observer.json') },
  { runPowerShell: fakePwsh(deps.pwsh), fs: deps.fs || fakeStatFs(deps.stat), ...deps.extra },
);

// The shared report on disk is rewritten before every test. Several NEGATIVE cases poison it on
// purpose, and a test that ran afterwards against a poisoned report would be testing the order of
// the file rather than the observer.
const sharedReport = join(ARTIFACTS, '_selftest-observer.json');
beforeEach(() => { writeFileSync(sharedReport, JSON.stringify(launchDoc()), 'utf8'); });

test('a complete live observation satisfies verifyLiveIdentity end to end', () => {
  const file = join(ARTIFACTS, '_selftest-observer.json');
  const doc = launchDoc();
  writeFileSync(file, JSON.stringify(doc), 'utf8');
  // The observer's own read of the report must agree with the guard's read of it.
  const live = observe({ __launchState: file }, { fs: { ...nodeFs, ...fakeStatFs() } });
  assert.equal(live.pid, PID);
  assert.equal(live.startTimeUtc, '2026-10-09T00:00:00.000Z');
  assert.equal(live.exe, EXE);
  assert.equal(live.debugPortOwnerPid, PID);
  assert.equal(live.userDataDir, PROFILE);
  assert.equal(live.runtimeDataDir, RUNTIME);
  // The real gate, run with the real observer output.
  const proof = readIsolationProof(file, { cdpPort: PORT, observe: () => live });
  assert.equal(proof.verified, true);
  assert.equal(proof.pid, PID);
});

test('createObserver wires the launch state and the port into a ready-to-use observe()', () => {
  const file = join(ARTIFACTS, '_selftest-observer.json');
  writeFileSync(file, JSON.stringify(launchDoc()), 'utf8');
  const observeFn = createObserver({
    launchState: file,
    cdpPort: PORT,
    deps: { runPowerShell: fakePwsh(), fs: { ...nodeFs, ...fakeStatFs() } },
  });
  assert.equal(typeof observeFn, 'function');
  // Called the way readIsolationProof calls it: with the doc's own hints.
  const proof = readIsolationProof(file, { cdpPort: PORT, observe: observeFn });
  assert.equal(proof.verified, true);
  // A reserved port is refused by the same guard the sidecar uses, not by a local copy.
  refused(() => createObserver({ launchState: file, cdpPort: 9331, deps: { runPowerShell: fakePwsh() } }), /reserved/);
  refused(() => createObserver({ launchState: join(ARTIFACTS, '..', '..', '..', 'escape.json'), cdpPort: PORT, deps: { runPowerShell: fakePwsh() } }), /escapes/);
});

test('the default dependency selection is the real runner and the real fs, not a stub', () => {
  const deps = selectObserverDeps();
  assert.equal(deps.runPowerShell, runPowerShell, 'the default must be the module-level real runner');
  assert.equal(deps.fs.statSync, nodeFs.statSync, 'the default fs must be the real node:fs');
  const injected = selectObserverDeps({ runPowerShell: fakePwsh(), fs: fakeStatFs() });
  assert.notEqual(injected.runPowerShell, runPowerShell);
  assert.equal(typeof injected.fs.readdirSync, 'function');
});

// ---- NEGATIVE: each identity field, unobservable, must refuse ------------------

test('NEGATIVE: a pid that no longer resolves to a live process refuses', () => {
  refused(() => observe({}, { pwsh: { row: null } }), /no live process|not observable|exited/i);
});

test('NEGATIVE: a process with no --user-data-dir in its LIVE command line refuses', () => {
  // The report still says userDataDir. Falling back to it would be reporting the REQUEST as the
  // observation, which is the exact substitution this tool exists to prevent.
  refused(() => observe({}, { pwsh: { row: processRow({ commandLine: `"${EXE}" --remote-debugging-port=${PORT}` }) } }), /--user-data-dir|userDataDir/);
  // An empty ExecutablePath (no permission to read another user's image) is equally unobservable.
  refused(() => observe({}, { pwsh: { row: processRow({ executablePath: '' }) } }), /exe|executablePath|image/i);
  // A creation date that is not a date is not an observation.
  refused(() => observe({}, { pwsh: { row: processRow({ creationDate: '' }) } }), /start ?time|creationDate/i);
});

test('NEGATIVE: the debug port owner is read live, never from the report snapshot', () => {
  refused(() => observe({}, { pwsh: { owners: [] } }), /no listener|not listening|debug port/i);
  refused(() => observe({}, { pwsh: { owners: [loopbackOwner({ OwningProcess: 999 })] } }), /owned by pid 999|debug port/i);
  refused(() => observe({}, { pwsh: { owners: [loopbackOwner(), loopbackOwner({ OwningProcess: 1000 })] } }), /owned by pid 1000|debug port/i);
  // A debugger exposed on every interface is a different failure, and it is still a refusal.
  refused(() => observe({}, { pwsh: { owners: [loopbackOwner({ LocalAddress: '0.0.0.0' })] } }), /loopback|0\.0\.0\.0/);
});

test('NEGATIVE: runtime data that cannot be shown to have been written by THIS run refuses', () => {
  refused(() => observe({}, { stat: { exists: false } }), /does not exist/i);
  // Written (or created) before the process started: the directory may be left over from an older
  // run, so its mere existence proves nothing about this instance.
  refused(() => observe({}, { stat: { mtimeMs: START_MS - 60000 } }), /predates|before the process start/i);
  // A scan that hit the ceiling is a PARTIAL proof; it must not be reported as a whole one. The
  // fake hands back MORE entries than the observer's own ceiling, because bounding happens inside
  // the observer and a fake that pre-truncated them would never reach it.
  const tooMany = Array.from({ length: MAX_SCAN_ENTRIES + 10 }, (_, i) => `f${i}`);
  refused(() => observe({}, { stat: { entries: tooMany } }), /ceiling|partial/i);
});

test('NEGATIVE: the runtime path may only come from the observed block, never from the request', () => {
  const file = join(ARTIFACTS, '_selftest-observer.json');
  const doc = launchDoc();
  delete doc.observed.runtimeDataDir;
  writeFileSync(file, JSON.stringify(doc), 'utf8');
  refused(() => observe({ __launchState: file }, { fs: { ...nodeFs, ...fakeStatFs() } }), /observed runtimeDataDir|observation/i);
});

test('NEGATIVE: the observation must describe the very instance the report describes', () => {
  const file = join(ARTIFACTS, '_selftest-observer.json');
  writeFileSync(file, JSON.stringify(launchDoc({ pid: 5150 })), 'utf8');
  refused(() => observe({ __launchState: file }, { fs: { ...nodeFs, ...fakeStatFs() } }), /do(?:es)? not match|expected/i);
  // A live row for a different pid than the one queried is not the process we asked about.
  refused(() => observe({}, { pwsh: { row: processRow({ processId: 5150 }) } }), /pid/i);
});

test('NEGATIVE: an unreadable or absent launch report refuses instead of guessing', () => {
  refused(() => observeLiveIdentity({ pid: PID, debugPort: PORT, launchState: join(ARTIFACTS, '_selftest-absent.json') }, { runPowerShell: fakePwsh(), fs: nodeFs }), /launch report/i);
  const broken = join(tmpRoot, 'broken.json');
  writeFileSync(broken, '{ not json', 'utf8');
  refused(() => observeLiveIdentity({ pid: PID, debugPort: PORT, launchState: broken }, { runPowerShell: fakePwsh(), fs: nodeFs }), /launch report/i);
});

test('a port mismatch between the report and the requested CDP port is refused', () => {
  // The command line carries a different --remote-debugging-port than the port under test: the
  // observer would be about to certify a port this process does not hold.
  refused(() => observe({}, { pwsh: { row: processRow({ commandLine: `"${EXE}" --user-data-dir=${PROFILE} --remote-debugging-port=19999` }) } }), /19999|port/i);
});

// ---- pure parsing -------------------------------------------------------------

test('the command line is parsed for the values the process was actually given', () => {
  // The whole argument quoted, which is what ProcessStartInfo.ArgumentList emits for a path with
  // a space in it.
  assert.equal(userDataDirFromCommandLine(`"C:/app.exe" "--user-data-dir=C:/x y/profile" --remote-debugging-port=19331`), 'C:/x y/profile');
  // The value quoted, the argument bare, the bare form again, and the space-separated form.
  assert.equal(userDataDirFromCommandLine('"C:/app.exe" --user-data-dir="C:/quoted/profile"'), 'C:/quoted/profile');
  assert.equal(userDataDirFromCommandLine('"C:/app.exe" --user-data-dir=C:/simple/profile'), 'C:/simple/profile');
  assert.equal(userDataDirFromCommandLine('"C:/app.exe" --user-data-dir C:/spaced/profile'), 'C:/spaced/profile');
  // Case does not matter on Windows.
  assert.equal(userDataDirFromCommandLine('"C:/app.exe" --USER-DATA-DIR=C:/x'), 'C:/x');
  assert.equal(userDataDirFromCommandLine('"C:/app.exe"'), '');
  assert.equal(userDataDirFromCommandLine(undefined), '');
  assert.equal(userDataDirFromCommandLine('"C:/app.exe" --user-data-dir='), '');
  assert.equal(debugPortFromCommandLine('"a.exe" --remote-debugging-port=19331'), 19331);
  assert.equal(debugPortFromCommandLine('"a.exe" --remote-debugging-port 19331'), 19331);
  assert.equal(debugPortFromCommandLine('"a.exe" --remote-debugging-port=0'), null);
  assert.equal(debugPortFromCommandLine('"a.exe"'), null);
  assert.equal(debugPortFromCommandLine('"a.exe" --remote-debugging-port'), null);
  // A different flag that merely ends in the same word must not be read as the port.
  assert.equal(debugPortFromCommandLine('"a.exe" --other-remote-debugging-port=1'), null);
});

test('the OS query results are parsed defensively, never optimistically', () => {
  assert.equal(parseProcessQuery('{}'), null);
  assert.equal(parseProcessQuery(''), null);
  assert.equal(parseProcessQuery('[]'), null);
  assert.equal(parseProcessQuery('null'), null);
  assert.equal(parseProcessQuery('{"processId":1}').executablePath, '');
  // A single listener row comes back as an object from ConvertTo-Json; it must still be a list.
  assert.deepEqual(parsePortOwners('{"LocalAddress":"127.0.0.1","LocalPort":1,"OwningProcess":2}'),
    [{ localAddress: '127.0.0.1', localPort: 1, owningProcess: 2 }]);
  assert.deepEqual(parsePortOwners('[]'), []);
  assert.deepEqual(parsePortOwners('null'), []);
  assert.deepEqual(parsePortOwners('"nonsense"'), []);
  // A row without a usable owner is not a listener.
  assert.deepEqual(parsePortOwners('[{"LocalAddress":"127.0.0.1","LocalPort":1}]'), []);
  // A BOM must not make a good answer unreadable (pwsh can emit one through a pipe).
  assert.equal(parseProcessQuery(`\uFEFF${JSON.stringify(processRow())}`).processId, PID);
});

// ---- the two OS queries are read-only by construction --------------------------

test('the PowerShell queries are single-target and contain nothing that mutates', () => {
  const proc = processQueryScript(PID);
  const port = portOwnerQueryScript(PORT);
  assert.match(proc, /Get-CimInstance[^\n]*Win32_Process/);
  assert.match(proc, /ProcessId=4242/, 'exactly one pid is queried');
  assert.match(port, /Get-NetTCPConnection[^\n]*-LocalPort 19331/);
  assert.match(port, /-State Listen/);
  for (const [name, script] of [['process', proc], ['port', port]]) {
    for (const verb of ['Stop-Process', 'taskkill', 'Start-Process', 'Remove-Item', 'Set-Item',
      'New-Item', 'Invoke-Expression', 'iex', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Enter-PSSession',
      'Set-Content', 'Out-File', 'Add-Content', 'WriteAllText', 'Stop-Service', 'Restart-Computer']) {
      assert.equal(script.includes(verb), false, `the ${name} query must not contain ${verb}`);
    }
    // Exactly one CIM class: a bulk query would be a different thing. The listener query uses no
    // CIM at all, so the count is asserted only where it applies.
    if (name === 'process') assert.equal((script.match(/Get-CimInstance/g) || []).length, 1);
  }
  // Neither query may name a production port.
  // Whole numbers only: the isolated port 19331 CONTAINS the production digits 9331.
  for (const script of [proc, port]) {
    for (const forbidden of ['4231', '9331', '19080']) {
      assert.equal(new RegExp('(^|[^0-9])' + forbidden + '([^0-9]|$)').test(script), false, 'a query must not name ' + forbidden);
    }
  }
});

// ---- the filesystem freshness gate, on a REAL directory ------------------------

test('the runtime freshness gate reads a real directory: fresh passes, stale refuses', () => {
  // The only real fs work in this file. No process, no port, no network, and the temp name is
  // created by mkdtemp with the one permitted prefix.
  const fresh = join(tmpRoot, 'fresh');
  const stale = join(tmpRoot, 'stale');
  for (const dir of [fresh, stale]) {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'state.json'), '{"fixture":true}');
  }
  const now = Date.now() / 1000;
  utimesSync(join(fresh, 'sub', 'state.json'), now, now);
  utimesSync(join(fresh, 'sub'), now, now);
  utimesSync(fresh, now, now);
  const longAgo = now - 3600;
  utimesSync(join(stale, 'sub', 'state.json'), longAgo, longAgo);
  // The directories carry the same stamps: the gate walks them too, and a subdirectory that was
  // created seconds ago would otherwise make the "stale" tree look fresh.
  utimesSync(join(stale, 'sub'), longAgo, longAgo);
  utimesSync(stale, longAgo, longAgo);

  const freshScan = newestWriteMs(fresh, nodeFs);
  assert.equal(freshScan.exists, true);
  assert.equal(freshScan.truncated, false);
  assert.ok(freshScan.newestMs > 0);
  const staleScan = newestWriteMs(stale, nodeFs);
  assert.ok(staleScan.newestMs < freshScan.newestMs, 'the stale tree really is older');
  // A directory that is not there is reported as missing, not as "old".
  const missing = newestWriteMs(join(tmpRoot, 'nope'), nodeFs);
  assert.equal(missing.exists, false);
  assert.equal(missing.newestMs, null);
  // The tolerance is bounded and small: it absorbs filesystem timestamp rounding only.
  assert.ok(RUNTIME_WRITE_TOLERANCE_MS >= 0 && RUNTIME_WRITE_TOLERANCE_MS <= 5000);
  assert.ok(MAX_SCAN_ENTRIES >= 100);
});

// ---- the launcher's own freshness gate, on the SOURCE ---------------------------
// launch-isolated.ps1 is PowerShell and it starts the real app, so nothing in this file runs it.
// What can be checked without a process is the contract its source must keep: ONE time base, ONE
// parse, ONE comparison, and the observer's own tolerance in seconds. The numbers it is checked
// against are the ones the first real run actually reported.

const launcherSource = () => nodeFs.readFileSync(new URL('./iso/launch-isolated.ps1', import.meta.url), 'utf8');
// Comments are stripped before anything is asserted: the prose is allowed to explain itself, and an
// assertion that a sentence about [datetime]::Parse() must not exist would forbid the file from ever
// documenting the bug it just fixed.
const launcherCode = () => launcherSource().replace(/<#[\s\S]*?#>/g, '').replace(/^[ \t]*#.*$/gm, '');

test('the launcher reads "written after the start" in UTC, and refuses the inverted verdict', () => {
  const code = launcherCode();

  // REGRESSION, from the first real run: newest write 2026-10-09T08:29:03.678Z against a process
  // start of 2026-10-09T08:29:02.871Z — 807 ms LATER — was reported as "predates the process start"
  // and backendIsolationProven came back false. [datetime]::Parse() on an ISO string ending in 'Z'
  // returns a Kind=Local DateTime holding the LOCAL wall clock (16:29:02.871+08:00 on this host),
  // LastWriteTimeUtc is Kind=Utc, and PowerShell's -lt/-ge compare raw ticks without normalising
  // Kind. So the comparison ran 08:29 against 16:29 and invented an 8 hour drift. There must be
  // exactly one parse left, it must pin the instant, and no comparison may parse the start at all.
  assert.equal((code.match(/\[datetime\]::Parse\(/g) || []).length, 1, 'exactly one datetime parse remains');
  assert.match(code, /\[datetime\]::Parse\([^;]*RoundtripKind\)/);
  // Every parse pins the instant; a parse without DateTimeStyles is the bug wearing a different hat.
  assert.equal((code.match(/\[datetime\]::Parse\([^;]*\)/g) || []).filter((s) => !/RoundtripKind/.test(s)).length, 0,
    'every datetime parse must pass RoundtripKind');
  // The instant compared against is Process.StartTime itself, kept as a Kind=Utc DateTime — not the
  // string form, which is the value that has to survive a round trip.
  assert.match(code, /\$processStartUtc = \$proc\.StartTime\.ToUniversalTime\(\)/);
  assert.match(code, /\$startedAt = \$processStartUtc\.ToString\('o'\)/);

  // The verdict is computed ONCE. The reason list and the reported field used to be two independent
  // copies of the same comparison, each free to drift; a reason and a field that disagree about the
  // same fact are a report nobody can act on.
  assert.match(code, /\$runtimeWriteAfterStart = \(\$null -ne \$observedRuntimeWrite\) -and/);
  assert.match(code, /runtimeDataWrittenAfterStart = \$runtimeWriteAfterStart/);
  assert.equal(/runtimeDataWrittenAfterStart = \(/.test(code), false, 'the report must not re-decide');

  // Same direction and same slack as this file's own gate: newest + TOLERANCE >= start. The slack is
  // read out of the launcher and tied to the exported constant, so the two can no longer drift apart
  // by a number nobody notices.
  assert.equal(/observedRuntimeWrite -lt/.test(code), false, 'the inverted comparison must be gone');
  const slack = /-ge \$processStartUtc\.AddSeconds\((-?[\d.]+)\)/.exec(code);
  assert.ok(slack, 'the launcher must compare newest against start with an explicit slack');
  assert.equal(Number(slack[1]) * 1000, -RUNTIME_WRITE_TOLERANCE_MS, 'the launcher slack must be the observer tolerance');

  // The recorded verdict, on the recorded numbers.
  const proven = (newestMs) => newestMs >= START_MS + Number(slack[1]) * 1000;
  assert.equal(proven(START_MS + 807), true, 'a write 807 ms after the start is evidence');
  assert.equal(proven(START_MS + 1), true);
  assert.equal(proven(START_MS), true, 'the start instant itself is inside the tolerance');
  assert.equal(proven(START_MS - 2000), true, 'the creation race the tolerance exists for');
  assert.equal(proven(START_MS - 2001), false, 'one millisecond past the tolerance is not evidence');
  assert.equal(proven(START_MS - 60000), false, 'a leftover directory from a previous run');
});

// ---- CLI ----------------------------------------------------------------------

test('the observer CLI is strict about its flags and never guesses a port', () => {
  const args = parseObserverArgs(['--launch-state', join(ARTIFACTS, 'launch-isolated.json'), '--cdp-port', '19331']);
  assert.equal(args.launchState, join(ARTIFACTS, 'launch-isolated.json'));
  assert.equal(args.cdpPort, 19331);
  refused(() => parseObserverArgs(['--cdp-port', '19331']), /--launch-state is required/);
  refused(() => parseObserverArgs(['--launch-state', join(ARTIFACTS, 'launch-isolated.json')]), /--cdp-port is required/);
  refused(() => parseObserverArgs(['--launch-state', join(ARTIFACTS, 'launch-isolated.json'), '--cdp-port', '9331']), /reserved/);
  refused(() => parseObserverArgs(['--launch-state', 'G:/mmx-project/zcode动态工作流-原else/.qoder/state.json', '--cdp-port', '19331']), /escapes/);
  refused(() => parseObserverArgs(['--launch-state', join(ARTIFACTS, 'launch-isolated.json'), '--cdp-port', '19331', '--kill']), /refused/);
  refused(() => parseObserverArgs(['--launch-state', join(ARTIFACTS, 'launch-isolated.json'), '--cdp-port', '19331', '--sneaky']), /unknown flag/);
  assert.equal(parseObserverArgs(['--help']).help, true);
});

test('the observer module binds nothing at import time', () => {
  const src = nodeFs.readFileSync(new URL('./iso/iso-observer.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(isDirectRun\(import\.meta\.url\)\)/);
  // The default runner must never be invoked on import, and never with a bypass.
  // Scoped to the real argument list, not the whole file: the prose above says out loud that no
  // bypass is used, and a whole-file grep would match that very sentence.
  const execArgs = /execFileSync\(bin, \[([\s\S]*?)\],/.exec(src)[1];
  assert.equal(/ExecutionPolicy|Unblock-File/i.test(execArgs), false);
  assert.match(execArgs, /'-NoProfile', '-NonInteractive', '-EncodedCommand'/);
  // A production port may appear in the help text — it does — but never in a query.
  assert.match(src, new RegExp(API_PORT_TEXT), 'the refused ports are documented');
  assert.equal(processQueryScript(PID).includes(API_PORT_TEXT), false);
  assert.equal(portOwnerQueryScript(PORT).includes(API_PORT_TEXT), false);
});

test('the shipped report shape is what the observer reads', () => {
  // The observer must tolerate the exact shape launch-isolated.ps1 writes, including the evidence
  // fields it depends on. Anything the script stops writing is an unprovable run, not a soft skip.
  const doc = launchDoc();
  for (const key of ['pid', 'startTimeUtc', 'userDataDir', 'debugPort', 'debugPortOwnerPid', 'runtimeDataDir']) {
    assert.ok(doc.observed[key] !== undefined && doc.observed[key] !== '', `observed.${key} must exist`);
  }
  assert.equal(doc.backendIsolationProven, true);
  assert.equal(resolve(ARTIFACTS).includes('ui-isolation'), true);
});