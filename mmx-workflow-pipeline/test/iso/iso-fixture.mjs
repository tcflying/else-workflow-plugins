// test/iso/iso-fixture.mjs — author-only fixture generator for the UI-isolation acceptance run.
//
// WHY THIS EXISTS: the only real run in .qoder/workflow-runs is a COMPLETED, UNBOUND audit. That is
// not a usable subject for a live-render assertion (it will never be "running" again) and it is NOT
// ours to mutate — it is the finished audit record. So a fresh, clearly-marked fixture run is needed
// for the card to render live. This tool writes that fixture and nothing else.
//
// WHAT IT IS NOT:
//   * it never runs the workflow engine. There is no child process, no model call, no agent
//     dispatch, and no cost. A fixture is a static on-disk run directory, not an execution;
//   * it never writes into the real .qoder/ tree, a real run, or any path outside
//     test/artifacts/ui-isolation/fixtures. Both the artifacts root and the
//     .qoder/workflow-runs/<fixture-id> shape are asserted before a byte is written;
//   * it never overwrites silently: an existing fixture directory needs --replace, and even then
//     only inside the fixtures root;
//   * every name / label / call label is stamped with the non-business marker verbatim, so a
//     screenshot or a /runs listing can never be read as a real business run.
//
// BOUNDARY (project lead decides, this tool does not): whether a fixture may be executed, bound to a
// session, or promoted to a real run is NOT decided here. A fixture is display material only. It
// is never evidence that a real workflow executed successfully.
//
// Run (author only — the test author does not execute it):
//   node test/iso/iso-fixture.mjs --fixture-id ui-iso-fixture-0001 --stage live
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  parseStrictArgs, fixtureRunDir, assertInsideArtifacts, assertFixtureId, isDirectRun,
  FIXTURES, FIXTURE_LABEL, IsolationRefused,
} from './iso-guard.mjs';

// Local refusal helper: the guard module exports the assertion functions, not a bare thrower.
const refuse = (message) => { throw new IsolationRefused(message); };

const SPEC = {
  '--fixture-id': String,
  '--stage': String,
  '--out': String,
  '--replace': 'boolean',
};

const USAGE = `mmx UI-isolation fixture writer (author-only, never executes anything)
  node test/iso/iso-fixture.mjs --fixture-id <id> [--stage live|completed|failed] [--out <dir>] [--replace]

  --fixture-id <id>  REQUIRED, must match /^ui-iso-fixture-[a-z0-9][a-z0-9-]{0,63}$/.
  --stage <s>        live (default) | completed | failed.
  --out <dir>        Fixtures root (default test/artifacts/ui-isolation/fixtures).
  --replace          Rewrite an existing fixture directory (still fixtures-root only).

Writes state.json + progress.json only. Starts no engine, calls no model, mutates no real run.`;

export function parseFixtureArgs(argv) {
  const args = parseStrictArgs(argv, SPEC, { name: 'iso-fixture' });
  if (args.help) return { help: true };
  if (!args['--fixture-id']) throw new IsolationRefused('iso-fixture: --fixture-id is required');
  const fixtureId = assertFixtureId(args['--fixture-id']);
  const stage = args['--stage'] || 'live';
  if (!['live', 'completed', 'failed'].includes(stage)) {
    throw new IsolationRefused(`iso-fixture: --stage must be live|completed|failed, got ${JSON.stringify(stage)}`);
  }
  // --out may only be the fixed fixtures root or a subdirectory of it, so the inspector's
  // runKeyFor() derivation and this writer always agree on the same path.
  let out = FIXTURES;
  if (args['--out']) {
    out = assertInsideArtifacts(args['--out'], 'fixtures root');
    const relToFixtures = relative(resolve(FIXTURES), out);
    if (relToFixtures.startsWith('..')) refuse(`iso-fixture: --out must be the fixtures root or a subdirectory of it (${FIXTURES}); got ${out}`);
  }
  return { help: false, fixtureId, stage, out, replace: args['--replace'] === true };
}

// Pure builders — the unit test asserts these shapes without writing anything.
// Phase counts are DERIVED from the call states, so a phase can never claim zero settled while one
// of its calls is done, and a failure can never mark a phase whose calls all finished.
const PHASES = [
  { name: `${FIXTURE_LABEL}·阶段1·只读DOM取证` },
  { name: `${FIXTURE_LABEL}·阶段2·卡片渲染核对` },
];
// Call timestamps are DERIVED from the run's own startedAt, never from a fixed calendar date: a
// hardcoded base made finishedAt fall BEFORE startedAt on any real run, which is an impossible
// lifecycle. The steps are deliberately 0ms apart — a fixture must not invent elapsed work time.
const step = (startedAt, ms) => new Date(Date.parse(startedAt) + ms).toISOString();

export function fixtureCalls(stage, startedAt = '2026-01-01T00:00:00.000Z') {
  const finished = stage !== 'live';
  const at0 = step(startedAt, 0);
  const at1 = step(startedAt, 0);
  return [
    { callId: 'q001-fixture01', label: `${FIXTURE_LABEL}·任务A-探测message-list`, phase: PHASES[0].name, state: 'done', startedAt: at0, settledAt: at1, durationMs: 0, preview: `${FIXTURE_LABEL}：仅用于 UI 隔离验收的静态结果，非真实业务产出。` },
    { callId: 'q001-fixture02', label: `${FIXTURE_LABEL}·任务B-核对阶段与子任务`, phase: PHASES[1].name, state: finished ? (stage === 'failed' ? 'failed' : 'done') : 'running', startedAt: at1, ...(finished ? { settledAt: at1, durationMs: 0 } : {}), preview: `${FIXTURE_LABEL}：静态预览，非真实业务产出。` },
  ];
}

const summarisePhase = (name, calls) => {
  const mine = calls.filter((c) => c.phase === name);
  return {
    name,
    dispatched: mine.length,
    settled: mine.filter((c) => c.state !== 'running').length,
    failed: mine.filter((c) => c.state === 'failed').length,
    rejected: 0,
  };
};

export function fixtureProgress({ fixtureId, stage, startedAt }) {
  const running = stage === 'live';
  const calls = fixtureCalls(stage, startedAt);
  const phases = PHASES.map((p) => summarisePhase(p.name, calls));
  return {
    runId: fixtureId,
    hostSession: null,
    name: `${FIXTURE_LABEL}·${fixtureId}`,
    fixture: true,
    note: FIXTURE_LABEL,
    cwd: '',
    cwdBase: 'ui-isolation',
    backend: 'file',
    status: running ? 'running' : stage,
    startedAt,
    ...(running ? {} : { finishedAt: step(startedAt, 0) }),
    currentPhase: running ? PHASES[1].name : PHASES[PHASES.length - 1].name,
    phases,
    calls,
    dispatched: calls.length,
    settled: calls.filter((c) => c.state !== 'running').length,
    failed: calls.filter((c) => c.state === 'failed').length,
    rejected: 0,
    notesDelivered: 0,
    logs: [{ ts: startedAt, level: 'info', message: `${FIXTURE_LABEL}：静态 fixture，无引擎执行。` }],
    // The card renders a result panel only for a finished run, so a completed/failed fixture is
    // what proves the result surface. live intentionally has none.
    ...(running ? {} : { resultPreview: `${FIXTURE_LABEL}：静态结果预览，用于核对结果面板渲染；不是真实运行结果。` }),
  };
}

export function fixtureState({ fixtureId, stage, startedAt, dir }) {
  const running = stage === 'live';
  const calls = fixtureCalls(stage, startedAt);
  return {
    runId: fixtureId,
    hostSession: null,
    name: `${FIXTURE_LABEL}·${fixtureId}`,
    fixture: true,
    note: FIXTURE_LABEL,
    status: running ? 'running' : stage,
    backend: 'file',
    cwd: dir,
    // Deliberately 0: a positive pid makes the host API probe process liveness and would mark an
    // engine-less fixture stale.
    pid: 0,
    scriptPath: '',
    args: {},
    confirmation: { required: false, basis: 'flag' },
    concurrency: 1,
    maxAgentCalls: 0,
    startedAt,
    ...(running ? {} : { finishedAt: step(startedAt, 0) }),
    agentDispatched: calls.length,
    agentSettled: calls.filter((c) => c.state !== 'running').length,
    agentFailed: calls.filter((c) => c.state === 'failed').length,
    agentRejected: 0,
    phases: PHASES.map((p) => p.name),
    notesDelivered: 0,
  };
}

// What the result entry reads. The host API's /result returns out.json verbatim, and the card's
// result panel / result modal render from it — so a finished fixture needs this file for the lead's
// real click to have anything to show. It is marked non-business on every surface it can appear on.
//
// WHY THE SAME CONTENT IS ALSO PUBLISHED UNDER `result`: the card's result entry and the result
// modal read out.error / out.result ONLY — top-level findings/report are invisible to them, so a
// fixture that carried them alone WOULD render "(无 result 字段)". Inferred from source; no real
// GUI click has been performed. The top-level fields are kept verbatim for readers that already
// consume them, and the identical honest static content is mirrored into the one object both client
// paths read.
//
// NO `error` IS FAKED. A fixture must not masquerade as a failed business run: the stage status is
// reported under result.status, and a `failed` fixture says failed there, on purpose. Nothing here
// carries a pid, a hostSession or any engine output — no engine executed.
export function fixtureOut({ fixtureId, stage }) {
  const findings = [
    { severity: 'info', title: `${FIXTURE_LABEL}·静态条目一`, detail: '这是 UI 隔离验收 fixture 的静态发现，不是业务运行结论。' },
    { severity: 'info', title: `${FIXTURE_LABEL}·静态条目二`, detail: '用于核对结果入口的读取与渲染，不代表任何真实任务完成。' },
  ];
  const report = `${FIXTURE_LABEL}：静态结果正文（非业务运行）。`;
  return {
    fixture: true,
    nonBusiness: true,
    note: FIXTURE_LABEL,
    runId: fixtureId,
    status: stage,
    findings,
    report,
    result: {
      fixture: true,
      nonBusiness: true,
      note: FIXTURE_LABEL,
      runId: fixtureId,
      status: stage,
      findings,
      report,
    },
  };
}

// Reads the startedAt of an EXISTING fixture so a live -> completed advance stays ONE lifecycle.
// The identity a mutation is checked against is (runId, startedAt); minting a new startedAt on
// --replace would turn the same fixture into a different lifecycle and quietly invalidate the very
// result entry the project lead is about to open.
function readExistingStartedAt(dir, fixtureId) {
  const file = join(dir, 'progress.json');
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    // The file EXISTS but does not parse. Returning null here would mint a fresh startedAt and
    // silently overwrite it, i.e. a corrupt fixture would be replaced as if it were new. Refuse.
    if (error.code === 'ENOENT') return null;
    refuse(`iso-fixture: ${file} exists but is unreadable (${error.code || error.message}); refusing to overwrite a fixture this tool cannot read`);
  }
  // Only ever continue OUR OWN fixture. Refusing anything else means a mistyped --fixture-id or a
  // replaced path can never rewrite a real run's lifecycle.
  if (doc?.fixture !== true || doc?.note !== FIXTURE_LABEL || doc?.runId !== fixtureId) {
    refuse(`iso-fixture: ${file} exists but is not this non-business fixture (${fixtureId}); refusing to rewrite it`);
  }
  if (typeof doc.startedAt !== 'string' || !doc.startedAt) {
    refuse(`iso-fixture: ${file} carries no startedAt, so this lifecycle cannot be continued; refusing to invent a new one`);
  }
  return doc.startedAt;
}

// Writes the fixture. Returns what was written plus the reminder that must travel with it.
export function writeFixture({ fixtureId, stage, out, replace }) {
  const dir = fixtureRunDir(out, fixtureId);
  // The DIRECTORY is the occupied marker, not progress.json: a directory that holds only a
  // state.json (a half-written or externally created run) must not be silently overwritten either.
  const dirExists = existsSync(dir);
  const progressExists = existsSync(join(dir, 'progress.json'));
  if (dirExists && !replace) {
    throw new IsolationRefused(`iso-fixture: ${dir} already exists; pass --replace to advance the same lifecycle`);
  }
  // A directory that exists WITHOUT a parseable progress.json cannot continue a lifecycle, so even
  // --replace refuses rather than stamping a fresh startedAt over whatever is in there.
  const existingStartedAt = progressExists ? readExistingStartedAt(dir, fixtureId) : null;
  if (dirExists && !progressExists) {
    refuse(`iso-fixture: ${dir} exists but holds no progress.json; refusing to write over a directory this tool did not create as a fixture`);
  }
  const startedAt = existingStartedAt || new Date().toISOString();
  mkdirSync(dir, { recursive: true });
  const progress = fixtureProgress({ fixtureId, stage, startedAt });
  const state = fixtureState({ fixtureId, stage, startedAt, dir });
  writeFileSync(join(dir, 'progress.json'), JSON.stringify(progress, null, 2) + '\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  if (stage === 'live') {
    // A live fixture has no result yet; leaving a stale out.json would let the result entry show a
    // finished run's body next to a running card.
    const stale = join(dir, 'out.json');
    if (existsSync(stale)) writeFileSync(stale, JSON.stringify({ fixture: true, nonBusiness: true, note: FIXTURE_LABEL, runId: fixtureId, status: 'running', findings: [], report: `${FIXTURE_LABEL}：尚未结束的静态 fixture，没有结果。` }, null, 2) + '\n');
  } else {
    writeFileSync(join(dir, 'out.json'), JSON.stringify(fixtureOut({ fixtureId, stage }), null, 2) + '\n');
  }
  writeFileSync(join(dir, 'UI-ISOLATION-FIXTURE.txt'),
    `${FIXTURE_LABEL}\n\nThis directory is a static UI fixture written by test/iso/iso-fixture.mjs.\n`
    + 'No workflow engine executed here, no model was called, and no real run was touched.\n'
    + 'It is display material for the isolation acceptance run only, and is NOT evidence that a\n'
    + 'business workflow executed successfully. Its out.json is static fixture content, not the\n'
    + 'result of any real work.\n');
  return {
    ok: true,
    fixtureId, stage, dir, startedAt,
    sameLifecycle: Boolean(existingStartedAt),
    files: ['progress.json', 'state.json', ...(stage === 'live' ? [] : ['out.json']), 'UI-ISOLATION-FIXTURE.txt'],
    nonBusiness: true,
    boundary: 'Display-only fixture. Whether it may be executed or bound is the project lead\'s call; this tool never runs it.',
    note: 'An unbound live fixture (hostSession null) can still render in the conversation — no binding is faked here. Advancing live -> completed/failed keeps one startedAt, so the card keeps its identity and the result entry has something to read.',
  };
}

if (isDirectRun(import.meta.url)) {
  try {
    const options = parseFixtureArgs(process.argv.slice(2));
    if (options.help) console.log(USAGE);
    else console.log(JSON.stringify(writeFixture(options), null, 2));
  } catch (error) {
    // The entry helpers throw SYNCHRONOUSLY, so there is no promise to attach .catch() to; an
    // uncaught throw here would exit with an unhandled-error code instead of the refusal code.
    console.error('[iso-fixture]', error.name === 'IsolationRefused' ? 'REFUSED:' : 'failed:', error.message);
    process.exitCode = 2;
  }
}