// test/iso/iso-guard.mjs — pure isolation guard + strict argv parsing for the UI-isolation
// forensics tools. No side effects: importing this file binds no port, starts no process and
// touches no file. Every rule here is a pure function so test/ui-isolation-tools.test.mjs can
// assert it without a live sidecar, a live CDP endpoint or a MiniMax instance.
//
// The rules exist because these tools are the ONLY place the project is allowed to point at a
// non-production host API / CDP pair while the UI is being fixed. Two failure modes are fatal and
// are therefore refused by construction, never by convention:
//   1. accidentally speaking to PRODUCTION (API 4231, CDP 9331, control plane 19080) — the main
//      instance is owned by the project lead and must never be re-injected, re-bound or killed;
//   2. accidentally acting like a launcher — this suite only observes and only writes inside the
//      project's own artifacts directory, so any --launch / kill family flag is a hard error.
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { realpathSync, readFileSync, lstatSync } from 'node:fs';
import { API_BASE_PLACEHOLDER, CAPABILITY_PLACEHOLDER } from '../../sidecar.mjs';

// The only reliable "am I the entry point" test. A basename suffix match would fire for any process
// whose argv[1] happened to end in the same file name — which is exactly how a test import would
// start a server.
export function isDirectRun(moduleUrl) {
  if (!process.argv[1]) return false;
  try { return pathToFileURL(resolve(process.argv[1])).href === moduleUrl; } catch { return false; }
}

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(HERE, '..', '..');                       // mmx-workflow-pipeline
export const PROJECT_ROOT = resolve(PKG_ROOT, '..');                      // repository root
export const ARTIFACTS = join(PKG_ROOT, 'test', 'artifacts', 'ui-isolation');
export const FIXTURES = join(ARTIFACTS, 'fixtures');
export const CLIENT_SCRIPT = join(PKG_ROOT, 'client-inject.js');

// The production endpoints, named. These are refused wherever they appear as a TARGET.
export const PRODUCTION_API_PORT = 4231;
export const PRODUCTION_CDP_PORT = 9331;
export const CONTROL_PLANE_PORT = 19080;
export const FORBIDDEN_PORTS = Object.freeze([PRODUCTION_API_PORT, PRODUCTION_CDP_PORT, CONTROL_PLANE_PORT]);

// A fixture is not a business run. Every generated name/label carries this marker verbatim so a
// screenshot or a /runs listing can never be mistaken for real work.
export const FIXTURE_LABEL = 'UI隔离验收fixture（非业务运行）';
export const FIXTURE_ID_RE = /^ui-iso-fixture-[a-z0-9][a-z0-9-]{0,63}$/;

// The launcher / process-kill vocabulary this suite must never accept. `launch-policy.mjs` and
// `sidecar.mjs` own real launching; these tools only read.
export const REJECTED_FLAGS = Object.freeze([
  '--launch', '--no-launch', '--kill', '--kill-on-exit', '--taskkill', '--restart', '--force',
  '--stop-instance', '--reload', '--inject-client',
]);

export class IsolationRefused extends Error {
  constructor(message) { super(message); this.name = 'IsolationRefused'; }
}
const refuse = (message) => { throw new IsolationRefused(message); };

// ---- ports -----------------------------------------------------------------

// A CDP target must be a port the caller named explicitly: this suite refuses to guess a preset,
// because a guessed default is how a test silently attaches to somebody else's debugger.
export function assertCdpPortAllowed(port, label = 'cdp port') {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) refuse(`${label} must be an explicit integer 1..65535, got ${JSON.stringify(port)}`);
  if (FORBIDDEN_PORTS.includes(n)) {
    refuse(`${label} ${n} is a reserved production/control-plane port (${FORBIDDEN_PORTS.join(', ')}); pick an isolated test port`);
  }
  return n;
}

// The isolated host API binds 127.0.0.1:0 and then reports the port the OS gave it. That port is
// dynamic, so it is re-checked after the bind: a lucky ephemeral draw of 4231/9331/19080 — or a
// collision with the CDP port under test — must abort instead of running.
export function assertEphemeralApiPort(actual, cdpPort) {
  const n = Number(actual);
  if (!Number.isInteger(n) || n < 1 || n > 65535) refuse(`resolved API port is not a real port: ${JSON.stringify(actual)}`);
  if (FORBIDDEN_PORTS.includes(n)) refuse(`resolved API port ${n} landed on a reserved production/control-plane port; refusing to serve on it`);
  if (cdpPort != null && n === Number(cdpPort)) refuse(`resolved API port ${n} equals the CDP port under test; refusing`);
  return n;
}

export const apiBaseFor = (port) => `http://127.0.0.1:${port}`;

// ---- the injected bundle must actually carry the isolated base -------------

// The API assignment in the client bundle, captured as a whole so it can be compared for EXACT
// equality. The shipped bundle legitimately mentions the production default inside its own comments
// and header, so a blanket "the text must not contain 4231" would refuse a correctly retargeted
// bundle. What matters is the one line that decides where requests actually go.
const API_ASSIGN_RE = /\bvar\s+API\s*=\s*(['"])([^'"]*)\1/;

// Fail-closed proof that the client was retargeted. `client-inject.js` ships the placeholder, and
// buildInjectSource(source, capability, apiBase) is what must substitute it. If that did not happen,
// injecting would silently aim the client at production 4231 — a fake pass with a real side effect.
export function assertInjectedApiBase(source, apiBase) {
  const text = String(source ?? '');
  const match = API_ASSIGN_RE.exec(text);
  if (!match) refuse('the injectable bundle has no `var API = "…"` assignment, so its endpoint cannot be verified; refusing to inject an unverified bundle');
  if (match[2] !== apiBase) refuse(`the injectable bundle's API assignment is ${JSON.stringify(match[2])}, not the isolated ${apiBase}; refusing to inject a bundle aimed elsewhere`);
  if (text.includes(API_BASE_PLACEHOLDER)) refuse(`the injectable bundle still contains the API base placeholder ${API_BASE_PLACEHOLDER}; the apiBase substitution did not take effect`);
  if (text.includes(CAPABILITY_PLACEHOLDER)) refuse(`the injectable bundle still contains the capability placeholder ${CAPABILITY_PLACEHOLDER}; the capability substitution did not take effect`);
  return true;
}

// ---- output redaction ------------------------------------------------------

// Tool output is read by a human and pasted into a report, so it is trimmed and scrubbed before
// it is printed. The capability (32 hex chars) and any bearer-looking blob never leave the
// process through stdout.
const SCRUB = [
  [/\b[0-9a-f]{32,}\b/gi, '<redacted-hex>'],
  [/\bey[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted-jwt>'],
  [/(authorization|x-workflow-capability|cookie|set-cookie)(\s*[:=]\s*)("?)[^\s",;}]+/gi, '$1$2<redacted>'],
];
export function redact(input, max = 400) {
  let out = String(input ?? '');
  for (const [re, to] of SCRUB) out = out.replace(re, to);
  return out.length > max ? out.slice(0, max) + `…(+${out.length - max} chars)` : out;
}

// ---- strict argv -----------------------------------------------------------

// Strict on purpose: an unknown flag is an error rather than something to ignore, because the
// failure mode of ignoring it is a tool that quietly did not do what the operator asked for.
export function parseStrictArgs(argv, spec, { name }) {
  const out = { help: false };
  for (const [flag, kind] of Object.entries(spec)) {
    if (kind === 'boolean') out[flag] = false;
    else if (Array.isArray(kind)) out[flag] = [];        // repeatable flag: [] means "list"
    else out[flag] = '';
  }
  const list = [...argv];
  const seen = new Set();
  while (list.length) {
    const token = list.shift();
    const flag = token.split('=')[0];
    if (flag === '--help' || flag === '-h') { out.help = true; continue; }
    if (REJECTED_FLAGS.includes(flag)) {
      refuse(`${name}: flag ${flag} is refused — this suite never launches, kills, reloads or injects; the project lead owns those actions`);
    }
    const kind = spec[flag];
    if (!kind) refuse(`${name}: unknown flag ${JSON.stringify(token)}; accepted: ${[...Object.keys(spec), '--help'].join(', ')}`);
    // A repeatable flag (declared as []) may appear many times — that is how --root collects.
    if (!Array.isArray(kind)) {
      if (seen.has(flag)) refuse(`${name}: flag ${flag} given more than once`);
      seen.add(flag);
    }
    if (kind === 'boolean') {
      if (token.includes('=')) refuse(`${name}: flag ${flag} takes no value`);
      out[flag] = true;
      continue;
    }
    const inline = token.includes('=') ? token.slice(token.indexOf('=') + 1) : null;
    const value = inline !== null ? inline : list.shift();
    if (value === undefined || value === '') refuse(`${name}: flag ${flag} needs a value`);
    if (Array.isArray(kind)) out[flag].push(value);
    else out[flag] = value;
  }
  return out;
}

// ---- path containment ------------------------------------------------------

// Resolve the deepest ANCESTOR that actually exists, following links. Windows reparse points
// (junctions, symlinks, some directory mounts) are invisible to a purely lexical comparison, so
// the check is done on the resolved path of the nearest existing ancestor as well as on the
// literal path.
const normCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

const realFs = { realpathSync, lstatSync };

// The fs predicates are injectable so the link/reparse-point refusal can be unit-tested without
// CREATING a real junction. Default behaviour is the real filesystem.
function nearestExistingRealPath(abs, fs = realFs) {
  let current = abs;
  for (let depth = 0; depth < 64; depth++) {
    try { return fs.realpathSync(current); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

const containedIn = (child, root) => {
  const rel = relative(normCase(root), normCase(child));
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
};

// Refuse a link/reparse point at ANY level from the target all the way UP TO THE PROJECT ROOT,
// inclusive. Walking only as far as the artifacts root would let a junction ABOVE it hide: the
// sub-root check stops at `root` and never inspects `test/`, `test/artifacts/`, the package dir or
// the repository dir, all of which a caller could replace with a reparse point pointing anywhere.
//
// Fail-closed: if the walk reaches the filesystem top without ever arriving at the project root, or
// it runs out of depth, it REFUSES. Returning quietly would treat "could not verify the whole chain"
// as "chain is fine".
const MAX_LINK_WALK_DEPTH = 64;
function assertNoLinkLevels(abs, label, fs = realFs, boundary = PROJECT_ROOT) {
  let current = abs;
  for (let depth = 0; depth <= MAX_LINK_WALK_DEPTH; depth++) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        refuse(`${label} passes through a link or reparse point at ${current}; an isolation path must be a plain directory chain`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') refuse(`${label} cannot be inspected at ${current}: ${error.code || error.message}`);
    }
    if (normCase(current) === normCase(boundary)) return;
    const parent = dirname(current);
    // Reached the volume root without meeting the project root: the chain was never verified.
    if (parent === current) {
      refuse(`${label} cannot be verified: the walk from ${abs} reached ${current} without passing the project root ${boundary}`);
    }
    current = parent;
  }
  refuse(`${label} cannot be verified: walking up from ${abs} exceeded ${MAX_LINK_WALK_DEPTH} levels without reaching the project root ${boundary}`);
}

// Everything this suite writes lives under test/artifacts/ui-isolation inside the package. Four
// conditions must all hold: the literal path is under the artifacts root; the artifacts root itself
// is lexically inside the PROJECT ROOT, so `allow` cannot be handed an outer root to opt out of the
// link walk; NO level from the target up to the project root is a link; and the real path of the
// nearest existing ancestor is under the real path of the root. A path failing any is refused before
// a byte is written.
export function assertInsideArtifacts(target, label = 'path', { allow = ARTIFACTS, fs = realFs } = {}) {
  const abs = isAbsolute(target) ? resolve(target) : resolve(PKG_ROOT, target);
  const root = resolve(allow);
  // `allow` is a narrowing knob, never an escape hatch: an outer root would stop the link walk early.
  if (root !== PROJECT_ROOT && !containedIn(root, PROJECT_ROOT)) {
    refuse(`${label} cannot be verified: the containment root ${root} is outside the project root ${PROJECT_ROOT}; a wider root would skip part of the link walk`);
  }
  if (!containedIn(abs, root) && abs !== root) {
    refuse(`${label} escapes the isolation artifacts directory: ${abs} is not under ${root}`);
  }
  const rootReal = nearestExistingRealPath(root, fs);
  const absReal = nearestExistingRealPath(abs, fs);
  if (!rootReal || !absReal) {
    refuse(`${label} cannot be verified against a real existing path (root=${root}, target=${abs}); refusing an unverifiable write`);
  }
  try {
    if (fs.lstatSync(root).isSymbolicLink()) {
      refuse(`${label} is unreachable safely: the isolation root ${root} is itself a link or reparse point`);
    }
  } catch (error) {
    // A refusal raised by the link check must not be relabelled as an inspection failure.
    if (error instanceof IsolationRefused) throw error;
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') refuse(`${label} cannot inspect the isolation root ${root}: ${error.code || error.message}`);
  }
  assertNoLinkLevels(abs, label, fs);
  if (absReal !== rootReal && !containedIn(absReal, rootReal)) {
    refuse(`${label} resolves outside the isolation artifacts directory through a link or reparse point: ${abs} -> ${absReal} is not under ${rootReal}`);
  }
  return abs;
}

export function assertFixtureId(id) {
  if (!FIXTURE_ID_RE.test(String(id ?? ''))) {
    refuse(`fixture id must match ${FIXTURE_ID_RE} so it can never collide with a business run id; got ${JSON.stringify(id)}`);
  }
  return String(id);
}

// ---- backend isolation gate -------------------------------------------------

// The isolated instance is launched by test/iso/launch-isolated.ps1, which sets MINIMAX_DATA_DIR /
// MAVIS_DATA_DIR for the child. That comes from the CLI documentation and does NOT by itself prove
// the Desktop app's backend runtime and auth are separated. So injection is gated on a LIVE identity
// record, and — deliberately — NOT on a self-declared flag.
//
// Why a live record and not `backendIsolationProven: true` in the launch report:
//   * a boolean in a file is just an assertion; anyone can flip it and nothing re-checks it;
//   * `process.kill(pid, 0)` only proves SOME process holds that pid — Windows recycles pids, so a
//     report for a dead instance can match a fresh unrelated one;
//   * the launch report's listener snapshot is a historical record; comparing its owningPid to
//     doc.pid just compares the file to itself and proves nothing about who holds the port NOW.
//   So every field below must come from a FRESH, read-only observation, and each one is compared
//   for exact equality against the launch report. A mismatch, or a missing field, refuses.
export const LAUNCH_STATE_FILE = join(ARTIFACTS, 'launch-isolated.json');

// The fields a live observation must supply. Everything here is a non-secret identity fact.
export const REQUIRED_IDENTITY_FIELDS = Object.freeze(['pid', 'startTimeUtc', 'exe', 'debugPortOwnerPid', 'userDataDir', 'runtimeDataDir']);

const sameInstant = (a, b) => {
  const ta = Date.parse(String(a ?? ''));
  const tb = Date.parse(String(b ?? ''));
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
};

const samePath = (a, b) => {
  const norm = (p) => {
    const s = resolve(String(p ?? ''));
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return String(a ?? '') !== '' && norm(a) === norm(b);
};

/**
 * Compare the launch report against a LIVE, read-only identity observation.
 *
 * @param doc     parsed launch report
 * @param live    freshly observed fields (see REQUIRED_IDENTITY_FIELDS)
 * @param cdpPort the port this run targets
 *
 * Returns the verified record, or refuses. It never softens a mismatch.
 */
export function verifyLiveIdentity(doc, live, { cdpPort } = {}) {
  if (!doc || typeof doc !== 'object') refuse('BACKEND_ISOLATION_UNPROVEN: the launch report is not a JSON object');
  if (!live || typeof live !== 'object') {
    refuse(`BACKEND_ISOLATION_UNPROVEN: no LIVE identity observation was supplied. This suite refuses to inject on the strength of a self-declared flag, a historical listener snapshot, or a pid-existence probe — a recycled pid would pass all of those. Supply a fresh read-only observation of ${REQUIRED_IDENTITY_FIELDS.join(', ')}.`);
  }
  const missing = REQUIRED_IDENTITY_FIELDS.filter((f) => live[f] === undefined || live[f] === null || live[f] === '');
  if (missing.length) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: the live identity observation is missing ${missing.join(', ')}; injection is refused rather than assumed.`);
  }
  // The pid must be the one the report describes, and the process must have started when it says.
  if (Number(live.pid) !== Number(doc.pid)) {
    refuse(`STALE_ISOLATION_PROOF: live pid ${live.pid} is not the launch report's pid ${doc.pid}.`);
  }
  if (!sameInstant(live.startTimeUtc, doc.startTime)) {
    refuse(`STALE_ISOLATION_PROOF: the live process started at ${live.startTimeUtc}, not at the recorded ${doc.startTime}. A reused pid would pass a kill-0 probe; this compares actual start times.`);
  }
  if (!samePath(live.exe, doc.exe)) {
    refuse(`STALE_ISOLATION_PROOF: the live process image is ${live.exe}, not the recorded ${doc.exe}.`);
  }
  // The debug port must be held BY THIS PID, observed now — not by the snapshot in the report.
  if (Number(live.debugPortOwnerPid) !== Number(doc.pid)) {
    refuse(`STALE_ISOLATION_PROOF: the debug port is currently owned by pid ${live.debugPortOwnerPid}, not by the launch report's pid ${doc.pid}.`);
  }
  if (cdpPort != null && Number(doc.debugPort) !== Number(cdpPort)) {
    refuse(`STALE_ISOLATION_PROOF: ${JSON.stringify(cdpPort)} was requested but the launch report describes debug port ${doc.debugPort}.`);
  }
  // The isolation directories must be the ones this run will actually use.
  for (const key of ['userDataDir', 'runtimeDataDir']) {
    const reported = doc[key];
    assertInsideArtifacts(String(reported || ''), `${key} in the launch report`);
    if (!samePath(live[key], reported)) {
      refuse(`STALE_ISOLATION_PROOF: the live ${key} is ${live[key]}, not the recorded ${reported}.`);
    }
  }
  return {
    verified: true,
    pid: Number(live.pid),
    startTimeUtc: String(live.startTimeUtc),
    exe: String(live.exe),
    userDataDir: String(live.userDataDir),
    runtimeDataDir: String(live.runtimeDataDir),
  };
}

/**
 * Read the launch report and verify it against a LIVE observation.
 *
 * `observe` is injected. The DEFAULT refuses: no live observation means no injection. A real
 * read-only observer (Get-Process / Get-CimInstance / Get-NetTCPConnection, bounded, whitelisted
 * fields only) can be supplied by the project lead later; this suite ships without one rather than
 * with a weaker check, because a wrong check here injects into the wrong process.
 */
export function readIsolationProof(file = LAUNCH_STATE_FILE, { cdpPort, observe } = {}) {
  const path = assertInsideArtifacts(file, 'launch report');
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: ${path} is missing or unreadable (${error.code || error.message}). Start the isolated instance with test/iso/launch-isolated.ps1 first. Nothing will be injected until a live identity observation exists.`);
  }
  if (doc.backendIsolationProven !== true) {
    refuse(`BACKEND_ISOLATION_UNPROVEN: ${path} records backendIsolationProven=${JSON.stringify(doc.backendIsolationProven)}. Note that this flag is necessary but NOT sufficient — injection additionally requires a live identity observation.`);
  }
  const live = typeof observe === 'function' ? observe({ pid: doc.pid, debugPort: doc.debugPort, file: path }) : null;
  return verifyLiveIdentity(doc, live, { cdpPort });
}

// The only directory a fixture run may be written to. Both halves are checked: the artifacts root
// AND the `.qoder/workflow-runs` shape the host API actually scans.
export function fixtureRunDir(fixtureRoot, fixtureId) {
  assertFixtureId(fixtureId);
  const root = assertInsideArtifacts(fixtureRoot, 'fixture root');
  return assertInsideArtifacts(join(root, '.qoder', 'workflow-runs', fixtureId), 'fixture run directory');
}