// test/ui-isolation-tools.test.mjs — PURE unit tests for the UI-isolation tools.
//
// Run: node --test test/ui-isolation-tools.test.mjs
//
// Scope discipline: this file opens no port, starts no process, connects to no CDP endpoint and
// touches no MiniMax instance. It imports the tool modules only to assert their pure logic —
// argument parsing, the isolation guard, path containment, the fixture document shapes, the
// redaction rules and the PASS/BLOCKED classifier. Because every CLI uses the strict
// isDirectRun() entry-point check, importing them here cannot start anything.
//
// The negative cases are the point of this file. A message-list count of 0, a card that is not in the
// conversation, a card that is not the expected fixture, or a card with glyphs instead of task
// labels must all be BLOCKED — never PASS. A harness that cannot fail is not evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FORBIDDEN_PORTS, FIXTURE_LABEL, FIXTURE_ID_RE, IsolationRefused,
  assertCdpPortAllowed, assertEphemeralApiPort, assertInjectedApiBase, assertInsideArtifacts,
  assertFixtureId, fixtureRunDir, parseStrictArgs, redact, isDirectRun, ARTIFACTS, CLIENT_SCRIPT,
  FIXTURES, readIsolationProof, LAUNCH_STATE_FILE, REQUIRED_IDENTITY_FIELDS, PKG_ROOT,
} from './iso/iso-guard.mjs';
import { parseIsoArgs, manifestPayload, startIsoSidecar, createRevalidatedConnector } from './iso/iso-sidecar.mjs';
import { parseInspectArgs, classify, cardMatchesIdentity, expectedFixtureIdentity, maskRunKey, inspect, selectDeps, fetchTargets, PROBE_EXPRESSION } from './iso/iso-inspect.mjs';
import { parseFixtureArgs, writeFixture, fixtureProgress, fixtureState, fixtureOut, fixtureCalls } from './iso/iso-fixture.mjs';
import { buildInjectSource, runKeyFor } from '../sidecar.mjs';

// Scratch and self-test artifacts stay INSIDE the project's own artifacts directory. Nothing here
// touches the real .qoder run tree or the system Temp.
const FIX_ID = 'ui-iso-fixture-0001';
const LABEL = FIXTURE_LABEL;
// The real fixture path, so the expected runKey comes from the sidecar's own runKeyFor() exactly as
// the inspector derives it at runtime.
const FIXTURE_DIR = join(FIXTURES, '.qoder', 'workflow-runs', FIX_ID);
const FIXTURE_RUN_KEY = runKeyFor(FIXTURE_DIR);
const EXPECT = { fixtureId: FIX_ID, label: LABEL, runKey: FIXTURE_RUN_KEY, runName: `${LABEL}·${FIX_ID}` };
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof IsolationRefused && (!re || re.test(e.message)), 'expected an IsolationRefused');

test('production and control-plane ports are refused; an isolated port is accepted', () => {
  for (const port of FORBIDDEN_PORTS) refused(() => assertCdpPortAllowed(port));
  for (const bad of [0, -1, 65536, '9331x', '', null, undefined, 19.5]) refused(() => assertCdpPortAllowed(bad));
  assert.equal(assertCdpPortAllowed('19331'), 19331);
  assert.equal(assertCdpPortAllowed(19480), 19480);
});

test('a dynamic ephemeral port is re-checked after the bind', () => {
  assert.equal(assertEphemeralApiPort(4711, 19331), 4711);
  for (const port of FORBIDDEN_PORTS) refused(() => assertEphemeralApiPort(port, 19331));
  refused(() => assertEphemeralApiPort(19331, 19331), /equals the CDP port/);
  refused(() => assertEphemeralApiPort(0, 19331));
});

test('the injectable bundle API assignment is compared exactly, not scanned as text', () => {
  assert.equal(assertInjectedApiBase(`var API = 'http://127.0.0.1:4711';`, 'http://127.0.0.1:4711'), true);
  // Aiming somewhere else (here production) is refused on the assignment value.
  refused(() => assertInjectedApiBase(`var API = 'http://127.0.0.1:4231';`, 'http://127.0.0.1:4711'), /not the isolated/);
  refused(() => assertInjectedApiBase(``, 'http://127.0.0.1:4711'), /no `var API/);
  refused(() => assertInjectedApiBase(undefined, 'http://127.0.0.1:4711'));
  // A bundle that still holds the unsubstituted placeholder is refused.
  refused(() => assertInjectedApiBase(`var API = '__MMXDWF_API_BASE__';`, 'http://127.0.0.1:4711'), /not the isolated/);
  refused(() => assertInjectedApiBase(`var API = 'http://127.0.0.1:4711'; var C = '__MMXDWF_API_BASE__';`, 'http://127.0.0.1:4711'), /placeholder/);
  refused(() => assertInjectedApiBase(`var API = 'http://127.0.0.1:4711'; var C = '__MMXDWF_CAPABILITY__';`, 'http://127.0.0.1:4711'), /capability placeholder/);
  // Comments elsewhere in the bundle may legitimately mention the production default.
  assert.equal(assertInjectedApiBase(
    `// production http://127.0.0.1:4231 is the default\nvar API = 'http://127.0.0.1:4711';`,
    'http://127.0.0.1:4711'), true);
});

test('the REAL shipped client, built for an isolated base, passes the API check', () => {
  // Full production bundle, not a stub: the shipped header and comments legitimately mention the
  // production default, so the check must compare the actual API assignment instead of scanning the
  // whole text for "4231".
  const source = readFileSync(CLIENT_SCRIPT, 'utf8');
  assert.match(source, /__MMXDWF_API_BASE__/, 'the shipped bundle carries the API base placeholder');
  assert.match(source, /http:\/\/127\.0\.0\.1:4231/, 'and documents the production default in comments');
  const CAP = 'a'.repeat(64);
  const built = buildInjectSource(source, CAP, 'http://127.0.0.1:4711');
  assert.equal(assertInjectedApiBase(built, 'http://127.0.0.1:4711'), true);
  assert.equal(built.includes('__MMXDWF_API_BASE__'), false);
  assert.equal(built.includes('__MMXDWF_CAPABILITY__'), false);
  assert.match(built, /var API = 'http:\/\/127\.0\.0\.1:4711'/);
  // A build aimed at production must not be accepted as the isolated one, and vice versa.
  refused(() => assertInjectedApiBase(built, 'http://127.0.0.1:4712'), /not the isolated/);
  refused(() => assertInjectedApiBase(source, 'http://127.0.0.1:4711'), /not the isolated|placeholder/);
});

test('strict parsing rejects launch/kill vocabulary and unknown flags', () => {
  for (const flag of ['--launch', '--no-launch', '--kill', '--kill-on-exit', '--taskkill', '--reload']) {
    refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, flag]), /refused/);
  }
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--sneaky']), /unknown flag/);
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--cdp-port', '19332']), /more than once/);
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--quiet=1']), /takes no value/);
  // --root is the one repeatable flag: repeats collect instead of colliding.
  assert.deepEqual(parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--root', join(FIXTURES, 'sub')]).roots, [FIXTURES, join(FIXTURES, 'sub')]);
});

test('iso-sidecar args: repeatable --root collects, ports are validated, client script is fixed', () => {
  const args = parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--require-attach', '60000', '--poll-ms', '5000']);
  assert.deepEqual(args.roots, [FIXTURES]);
  assert.equal(args.cdpPort, 19331);
  assert.equal(args.requireAttachMs, 60000);
  assert.equal(args.pollMs, 5000);
  assert.equal(args.clientPath.endsWith('client-inject.js'), true);
  // R4: no flag may repoint the injectable bundle.
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--client', 'evil.js']), /unknown flag/);
  refused(() => parseIsoArgs(['--root', 'a']), /--cdp-port is required/);
  // --root is optional now (defaults to the fixtures root) but can never point outside the
  // isolation artifacts, so the real workspace's run history stays out of reach.
  assert.deepEqual(parseIsoArgs(['--cdp-port', '19331']).roots, [FIXTURES]);
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', 'a']), /escapes the isolation artifacts/);
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', 'G:/mmx-project/zcode动态工作流-原else']));
  refused(() => parseIsoArgs(['--cdp-port', '9331', '--root', FIXTURES]));
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--poll-ms', '10']));
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--require-attach', '999999']));
  assert.equal(parseIsoArgs(['--help']).help, true);
});

test('the sidecar manifest exposes endpoints and never the capability', () => {
  const m = manifestPayload({ pid: 1, apiPort: 4711, cdpPort: 19331, apiBase: 'http://127.0.0.1:4711', roots: ['r'], clientPath: 'c.js', attached: false });
  assert.equal(m.apiBase, 'http://127.0.0.1:4711');
  assert.equal(m.attached, false);
  assert.equal(JSON.stringify(m).includes('4231'), true, 'the refused-port list names 4231');
  assert.equal('capability' in m, false);
  assert.equal(JSON.stringify(m).toLowerCase().includes('x-workflow-capability'), false);
});

test('iso-inspect args require a port and an expected fixture identity', () => {
  const args = parseInspectArgs(['--cdp-port', '19331', '--expect-fixture-id', FIX_ID]);
  assert.equal(args.cdpPort, 19331);
  assert.equal(args.expectFixtureId, FIX_ID);
  assert.equal(args.expectLabel, LABEL);
  refused(() => parseInspectArgs(['--expect-fixture-id', FIX_ID]), /--cdp-port is required/);
  refused(() => parseInspectArgs(['--cdp-port', '19331']), /--expect-fixture-id is required/);
  refused(() => parseInspectArgs(['--cdp-port', '4231', '--expect-fixture-id', FIX_ID]));
  refused(() => parseInspectArgs(['--cdp-port', '19331', '--expect-fixture-id', 'audit-20261008-044410-mvs4d56']), /fixture id must match/);
  refused(() => parseInspectArgs(['--cdp-port', '19331', '--expect-fixture-id', FIX_ID, '--timeout-ms', '10']));
  refused(() => parseInspectArgs(['--cdp-port', '19331', '--expect-fixture-id', FIX_ID, '--out', 'C:/somewhere/else']));
});

test('the probe reads only rendered nodes: no storage, no write, no click', () => {
  for (const forbidden of ['localStorage', 'sessionStorage', 'cookie', '.click(', 'dispatchEvent', 'insertAdjacentHTML', 'fetch(']) {
    assert.equal(PROBE_EXPRESSION.includes(forbidden), false, `probe must not contain ${forbidden}`);
  }
  assert.match(PROBE_EXPRESSION, /data-testid=\\?"message-list/);
  assert.match(PROBE_EXPRESSION, /data-mmxdwf-card/);
});

// A probe shaped exactly like a real reading, built to isolate ONE property at a time. data-run
// carries the 64-hex runKey the host API derives from the run directory — never "id@timestamp".
const goodProbe = () => ({
  installed: true, version: 11, passwordInputCount: 0,
  messageListCount: 1, messageListChildCount: 6, globalEntryCount: 1, cardHostCount: 1, cardCount: 1,
  cards: [{
    run: FIXTURE_RUN_KEY, inConversation: true, title: '运行中',
    runName: `${LABEL}·${FIX_ID}`, stats: '2 个阶段 · 1 个子代理工作中', unbound: false,
    subtaskCount: 2,
    subtasks: [
      { label: `${LABEL}·任务A-探测message-list`, state: 'done' },
      { label: `${LABEL}·任务B-核对阶段与子任务`, state: 'running' },
    ],
    phaseCount: 2,
    phases: [{ name: `${LABEL}·阶段1·只读DOM取证`, state: 'done' }, { name: `${LABEL}·阶段2·卡片渲染核对`, state: 'now' }],
    hasResultPanel: false, resultChars: 0, notices: [], actions: ['stop', 'expand'],
  }],
});

test('NEGATIVE: message-list count 0 is BLOCKED, never PASS', () => {
  const p = goodProbe();
  p.messageListCount = 0;
  p.cards[0].inConversation = false;
  const r = classify(p, EXPECT);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.reasons.some((x) => /NO_MESSAGE_LIST/.test(x)));
  assert.ok(r.reasons.some((x) => /CARD_NOT_IN_CONVERSATION/.test(x)));
});

test('NEGATIVE: a card outside the conversation does not pass on the global entry alone', () => {
  const p = goodProbe();
  p.cards[0].inConversation = false;
  p.globalEntryCount = 1;
  const r = classify(p, EXPECT);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.reasons.some((x) => /CARD_NOT_IN_CONVERSATION/.test(x)));
});

test('NEGATIVE: a different card cannot stand in for the expected fixture', () => {
  const p = goodProbe();
  p.cards[0].run = 'audit-20261008-044410-mvs4d56@2026-10-07T20:58:10.671Z';
  p.cards[0].runName = 'audit-20261008-explicit';
  const r = classify(p, EXPECT);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.reasons.some((x) => /IDENTITY_MISMATCH/.test(x)));
  assert.equal(r.evidence.matchedRunKeyMatchesExpected, false);
});

test('NEGATIVE: right id but no non-business marker in the run name is not our subject', () => {
  const p = goodProbe();
  p.cards[0].runName = 'some other run';
  assert.equal(cardMatchesIdentity(p.cards[0], EXPECT), false);
  assert.equal(classify(p, EXPECT).verdict, 'BLOCKED');
});

test('NEGATIVE: runKey must match exactly — a different key, or the id in data-run, is BLOCKED', () => {
  assert.match(FIXTURE_RUN_KEY, /^[0-9a-f]{64}$/, 'the derived identity is a real 64-hex runKey');
  // The real audit run's key (derived from the real run directory) is a different run.
  const other = runKeyFor('G:/mmx-project/zcode动态工作流-原else/.qoder/workflow-runs/audit-20261008-044410-mvs4d56');
  const otherRun = goodProbe();
  otherRun.cards[0].run = other;
  const r = classify(otherRun, EXPECT);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.reasons.some((x) => /IDENTITY_MISMATCH/.test(x)));
  // A runId sitting in data-run is not a runKey and must not satisfy the comparison.
  const idInRun = goodProbe();
  idInRun.cards[0].run = FIX_ID;
  assert.equal(cardMatchesIdentity(idInRun.cards[0], EXPECT), false);
  // Prefix / suffix lookalikes on the run name fail the character-for-character comparison.
  for (const name of [`${LABEL}·${FIX_ID}-evil`, `${LABEL}·ui-iso-fixture-000`, `xx${LABEL}·${FIX_ID}`]) {
    const lookalike = goodProbe();
    lookalike.cards[0].runName = name;
    assert.equal(cardMatchesIdentity(lookalike.cards[0], EXPECT), false, `must reject ${name}`);
    assert.equal(classify(lookalike, EXPECT).verdict, 'BLOCKED');
  }
  // The runKey evidence survives masking: the boolean and a stable prefix/suffix remain.
  const pass = classify(goodProbe(), EXPECT);
  assert.equal(pass.evidence.matchedRunKeyMatchesExpected, true);
  assert.equal(pass.evidence.matchedRunKey, maskRunKey(FIXTURE_RUN_KEY));
  assert.ok(pass.evidence.matchedRunKey.startsWith(FIXTURE_RUN_KEY.slice(0, 8)));
  assert.equal(maskRunKey('not-a-key'), '(not a 64-hex runKey)');
});

test('the inspector derives the same runKey the fixture writer targets', () => {
  const identity = expectedFixtureIdentity({ fixtureId: FIX_ID, fixtureRoot: FIXTURES });
  assert.equal(identity.runKey, FIXTURE_RUN_KEY, 'inspector and fixture author must agree by construction');
  assert.equal(identity.runName, `${LABEL}·${FIX_ID}`);
  assert.equal(identity.dir, FIXTURE_DIR);
  assert.equal(identity.exists, false, 'no fixture is written by this suite');
  refused(() => expectedFixtureIdentity({ fixtureId: 'audit-20261008-044410-mvs4d56' }));
});

test('NEGATIVE: glyph-only progress and an unnamed stage list are BLOCKED', () => {
  const p = goodProbe();
  p.cards[0].subtasks = [{ label: '', state: '' }, { label: '•••', state: '' }];
  p.cards[0].phases = [{ name: '', state: 'now' }];
  const r = classify(p, EXPECT);
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.reasons.some((x) => /NO_NAMED_STAGE/.test(x)));
  assert.ok(r.reasons.some((x) => /NO_TASK_LABEL/.test(x)));
});

test('NEGATIVE: client not installed, and a missing expected identity, are BLOCKED', () => {
  const notInstalled = goodProbe();
  notInstalled.installed = false;
  assert.ok(classify(notInstalled, EXPECT).reasons.some((x) => /CLIENT_NOT_INSTALLED/.test(x)));
  assert.ok(classify(goodProbe(), {}).reasons.some((x) => /EXPECT_IDENTITY_REQUIRED/.test(x)));
  const noCards = goodProbe();
  noCards.cards = []; noCards.cardCount = 0;
  assert.ok(classify(noCards, EXPECT).reasons.some((x) => /NO_CARD/.test(x)));
});

test('POSITIVE: exact fixture in-conversation card with named stages and task labels passes', () => {
  const r = classify(goodProbe(), EXPECT);
  assert.equal(r.verdict, 'PASS', r.reasons.join(' | '));
  assert.equal(r.evidence.identityMatchedCardCount, 1);
  assert.equal(r.evidence.chatCardCount, 1);
  assert.equal(r.evidence.phaseNames.length, 2);
  assert.equal(r.evidence.taskLabels.length, 2);
  // The result surface is evidence too: a completed fixture reports a panel and its size, never text.
  const done = goodProbe();
  done.cards[0].hasResultPanel = true;
  done.cards[0].resultChars = 1234;
  assert.equal(classify(done, EXPECT).evidence.resultChars, 1234);
});

test('fixture documents are marked non-business at every user-visible field', () => {
  const startedAt = '2026-10-08T00:00:00.000Z';
  const p = fixtureProgress({ fixtureId: FIX_ID, stage: 'live', startedAt });
  const s = fixtureState({ fixtureId: FIX_ID, stage: 'live', startedAt, dir: 'C:/x' });
  assert.equal(p.status, 'running');
  assert.equal(s.pid, 0, 'a positive pid would make the engine-less fixture look stale');
  assert.equal(s.fixture, true);
  assert.equal(p.name.includes(LABEL), true);
  assert.equal(s.name.includes(LABEL), true);
  for (const call of p.calls) assert.equal(call.label.includes(LABEL), true, `call label must carry ${LABEL}`);
  for (const phase of p.phases) assert.equal(phase.name.includes(LABEL), true);
  assert.equal(p.resultPreview, undefined, 'a live fixture must not claim a result panel');
  const done = fixtureProgress({ fixtureId: FIX_ID, stage: 'completed', startedAt });
  assert.equal(done.status, 'completed');
  assert.equal(done.resultPreview.includes(LABEL), true);
  assert.equal(fixtureState({ fixtureId: FIX_ID, stage: 'failed', startedAt, dir: 'C:/x' }).status, 'failed');
});

test('fixture args and paths cannot leave the isolation artifacts directory', () => {
  const args = parseFixtureArgs(['--fixture-id', FIX_ID, '--stage', 'live']);
  assert.equal(args.fixtureId, FIX_ID);
  assert.equal(args.stage, 'live');
  refused(() => parseFixtureArgs(['--fixture-id', 'audit-20261008-044410-mvs4d56']));
  refused(() => parseFixtureArgs(['--fixture-id', FIX_ID, '--stage', 'exploded']));
  refused(() => parseFixtureArgs(['--fixture-id', FIX_ID, '--out', 'G:/mmx-project/zcode动态工作流-原else/.qoder']));
  assert.equal(assertFixtureId(FIX_ID), FIX_ID);
  for (const bad of ['', 'x', 'ui-iso-fixture-', 'UI-ISO-FIXTURE-1', 'ui-iso-fixture-../escape']) {
    refused(() => assertFixtureId(bad));
  }
  assert.equal(FIXTURE_ID_RE.test(FIX_ID), true);
  assert.match(FIXTURE_ID_RE.source, /ui-iso-fixture-\[a-z0-9\]/);
  const dir = fixtureRunDir(ARTIFACTS, FIX_ID);
  assert.equal(dir.includes('\\.qoder\\workflow-runs\\') || dir.includes('/.qoder/workflow-runs/'), true);
  refused(() => fixtureRunDir('G:/mmx-project/zcode动态工作流-原else/.qoder', FIX_ID));
  refused(() => fixtureRunDir(ARTIFACTS, 'audit-20261008-044410-mvs4d56'));
});

test('artifact containment refuses escapes, and link levels are checked at every level', async () => {
  assert.equal(assertInsideArtifacts(join(ARTIFACTS, 'shot.png'), 'file').endsWith('shot.png'), true);
  refused(() => assertInsideArtifacts(join(ARTIFACTS, '..', '..', '.qoder', 'state.json'), 'file'), /escapes/);
  refused(() => assertInsideArtifacts('G:/mmx-project/zcode动态工作流-原else/.qoder', 'file'), /escapes/);
  refused(() => assertInsideArtifacts(join(ARTIFACTS, '..', '..', '..', 'anything'), 'file'), /escapes/);
  // The link cases are covered with INJECTED fs predicates rather than by creating a real junction:
  // no reparse point is created, and nothing outside the project is touched.
  const { realpathSync, lstatSync } = await import('node:fs');
  // Compare the way the walk does: each level is reached by dirname() and compared against
  // PROJECT_ROOT, so the mock keys must be normalised the same way or they would never match.
  const key = (p) => resolve(String(p)).replace(/\\/g, '/').toLowerCase();
  const fakeFs = (links) => {
    const set = new Set([...links].map(key));
    return {
      realpathSync,
      // A complete lstat result: the guard distinguishes "is a link" from "cannot be inspected",
      // so a stub carrying only isSymbolicLink would be rejected for the wrong reason.
      lstatSync: (p) => (set.has(key(p)) ? { isSymbolicLink: () => true, code: undefined } : lstatSync(p)),
    };
  };
  // A link at the artifacts ROOT itself: a resolved-path comparison alone would see both sides
  // inside the outer tree, so this level has to be inspected explicitly.
  refused(() => assertInsideArtifacts(join(ARTIFACTS, 'x.json'), 'file', { fs: fakeFs([ARTIFACTS]) }), /itself a link/);
  // A link on the chain BELOW the artifacts root is caught by the walk (the root's own link is
  // caught by the dedicated check above, which runs first).
  refused(() => assertInsideArtifacts(join(ARTIFACTS, '_selftest-shots', 'shot.png'), 'file', { fs: fakeFs([join(ARTIFACTS, '_selftest-shots')]) }), /link or reparse point/);
  // Levels ABOVE the artifacts root must be inspected too: a junction at test/artifacts, at test/,
  // or at the package dir would otherwise hide behind a walk that stopped at the artifacts root.
  for (const level of ['test/artifacts', 'test', PKG_ROOT]) {
    refused(() => assertInsideArtifacts(join(ARTIFACTS, 'shot.png'), 'file', { fs: fakeFs([resolve(PKG_ROOT, level)]) }), /link or reparse point/);
  }
  // `allow` cannot point OUTSIDE the project root to make the walk stop early. `allow` equal to the
  // project root itself is legal (that is the boundary the walk stops at); a root above it is not,
  // because the walk would never arrive. No link is mocked: the widening check runs BEFORE any link
  // inspection, so the refusal must be about the root, not about a link.
  refused(() => assertInsideArtifacts(join(ARTIFACTS, 'shot.png'), 'file', { allow: resolve(PKG_ROOT, '..', '..'), fs: fakeFs([]) }), /outside the project root/);
  // A fake root that is itself a link must be refused too, even though the target is under it.
  const linkedRoot = join(ARTIFACTS, 'linked-root');
  refused(() => assertInsideArtifacts(join(linkedRoot, 's.json'), 'under a linked root', { allow: linkedRoot, fs: fakeFs([linkedRoot]) }), /itself a link/);
  // Fail-closed: a target that does not lie under the project root can never be "verified".
  refused(() => assertInsideArtifacts(join(PKG_ROOT, '..', '..', 'outside.txt'), 'file'), /escapes/);
  // With no links in play the same paths are accepted, so the guard is not simply refusing
  // everything it is handed.
  assert.equal(assertInsideArtifacts(join(ARTIFACTS, 'fixtures', 'ui-iso-fixture-0001', 'progress.json'), 'file').endsWith('progress.json'), true);
});

test('output redaction removes capability-shaped secrets and bounds length', () => {
  const cap = 'a'.repeat(64);
  const out = redact(`cap=${cap} authorization: Bearer abcdefghijklmnop`, 400);
  assert.equal(out.includes(cap), false);
  assert.match(out, /<redacted/);
  const long = 'x'.repeat(1000);
  const cut = redact(long, 400);
  assert.ok(cut.length < long.length);
  assert.match(cut, /\(\+600 chars\)$/);
});

test('NEGATIVE: injection is refused without a LIVE identity observation, even when flagged', () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const report = join(ARTIFACTS, '_selftest-live-identity.json');
  const doc = {
    backendIsolationProven: true, pid: 4242, startTime: '2026-10-08T00:00:00.0000000Z',
    exe: 'G:/MiniMax/MiniMax Code/MiniMax Code.exe', debugPort: 19331,
    userDataDir: join(ARTIFACTS, 'electron-profile'), runtimeDataDir: join(ARTIFACTS, 'runtime-data'),
  };
  writeFileSync(report, JSON.stringify(doc));
  // The self-declared flag alone is NOT enough: no observe function, so no live evidence.
  refused(() => readIsolationProof(report, { cdpPort: 19331 }), /no LIVE identity observation/);
  // A live observation that omits fields is refused rather than assumed.
  refused(() => readIsolationProof(report, { cdpPort: 19331, observe: () => ({ pid: 4242 }) }), /missing/);
  // A recycled pid: the pid matches, but the process started at a different time. A kill-0 probe
  // and a historical snapshot would both pass this; comparing actual start times does not.
  const live = {
    pid: 4242, startTimeUtc: '2026-10-08T01:00:00.0000000Z', exe: doc.exe,
    debugPortOwnerPid: 4242, userDataDir: doc.userDataDir, runtimeDataDir: doc.runtimeDataDir,
  };
  refused(() => readIsolationProof(report, { cdpPort: 19331, observe: () => live }), /reused pid|actual start times/);
  // The debug port is held by someone else RIGHT NOW — the historical snapshot in the report is
  // not consulted, so a stale report cannot authorise an injection.
  refused(() => readIsolationProof(report, { cdpPort: 19331, observe: () => ({ ...live, startTimeUtc: doc.startTime, debugPortOwnerPid: 999 }) }), /debug port is currently owned/);
  // A different image, and an isolation path that moved.
  refused(() => readIsolationProof(report, { cdpPort: 19331, observe: () => ({ ...live, startTimeUtc: doc.startTime, exe: 'C:/other/app.exe' }) }), /process image/);
  refused(() => readIsolationProof(report, { cdpPort: 19331, observe: () => ({ ...live, startTimeUtc: doc.startTime, runtimeDataDir: join(ARTIFACTS, 'elsewhere') }) }), /runtimeDataDir/);
  refused(() => readIsolationProof(report, { cdpPort: 19480, observe: () => ({ ...live, startTimeUtc: doc.startTime }) }), /requested but the launch report/);
  // Only an exact live match passes.
  const ok = readIsolationProof(report, { cdpPort: 19331, observe: () => ({ ...live, startTimeUtc: doc.startTime }) });
  assert.equal(ok.verified, true);
  assert.equal(ok.pid, 4242);
  // The flag is still required, so a report without it cannot be waved through either.
  writeFileSync(report, JSON.stringify({ ...doc, backendIsolationProven: false }));
  refused(() => readIsolationProof(report, { cdpPort: 19331, observe: () => live }), /BACKEND_ISOLATION_UNPROVEN/);
  // A start-time difference inside the same ISO-8601 instant is not a mismatch.
  assert.equal(readIsolationProof.name, 'readIsolationProof');
  assert.equal(REQUIRED_IDENTITY_FIELDS.includes('debugPortOwnerPid'), true);
});

test('NEGATIVE: a fixture that exists but cannot be read is refused, never overwritten', () => {
  mkdirSync(FIXTURES, { recursive: true });
  const id = 'ui-iso-fixture-selftest';
  const dir = join(FIXTURES, '.qoder', 'workflow-runs', id);
  mkdirSync(dir, { recursive: true });
  const opts = { fixtureId: id, stage: 'live', out: FIXTURES, replace: true };
  // A corrupt progress.json must refuse: returning null would mint a new startedAt and clobber it.
  writeFileSync(join(dir, 'progress.json'), '{ this is not json');
  refused(() => writeFixture(opts), /exists but is unreadable/);
  // A directory holding only state.json is still an occupied directory.
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({ runId: id, fixture: true, note: LABEL, startedAt: '2026-10-08T00:00:00.000Z' }));
  writeFileSync(join(dir, 'state.json'), '{}');
  assert.equal(writeFixture(opts).sameLifecycle, true, 'a well-formed fixture continues one lifecycle');
  const stateOnly = join(FIXTURES, '.qoder', 'workflow-runs', 'ui-iso-fixture-stateonly');
  mkdirSync(stateOnly, { recursive: true });
  writeFileSync(join(stateOnly, 'state.json'), '{}');
  refused(() => writeFixture({ fixtureId: 'ui-iso-fixture-stateonly', stage: 'live', out: FIXTURES, replace: true }), /no progress\.json/);
  refused(() => writeFixture({ fixtureId: 'ui-iso-fixture-stateonly', stage: 'live', out: FIXTURES, replace: false }), /already exists/);
});

test('fixture call times derive from startedAt, so finishedAt is never before it', () => {
  const startedAt = new Date().toISOString();
  for (const stage of ['live', 'completed', 'failed']) {
    const p = fixtureProgress({ fixtureId: FIX_ID, stage, startedAt });
    const s = fixtureState({ fixtureId: FIX_ID, stage, startedAt, dir: 'C:/x' });
    const start = Date.parse(startedAt);
    assert.equal(Date.parse(p.startedAt), start);
    assert.equal(Date.parse(s.startedAt), start);
    for (const call of fixtureCalls(stage, startedAt)) {
      assert.equal(Date.parse(call.startedAt) >= start, true, `${stage}: call must not start before the run`);
      if (call.settledAt) assert.equal(Date.parse(call.settledAt) >= Date.parse(call.startedAt), true, `${stage}: settledAt must not precede startedAt`);
      if (call.durationMs !== undefined) assert.equal(call.durationMs, 0, 'a fixture must not invent elapsed work time');
    }
    if (stage !== 'live') {
      assert.equal(Date.parse(p.finishedAt) >= start, true, `${stage}: finishedAt must not precede startedAt`);
      assert.equal(Date.parse(s.finishedAt) >= start, true, `${stage}: state finishedAt must not precede startedAt`);
    }
  }
});

test('the inspector default dependency path is the real fetcher, not a self-recursive closure', () => {
  const none = selectDeps();
  assert.equal(none.listTargets, fetchTargets, 'the default must be the module-level fetch function');
  // Asserted by REFERENCE only. Calling it would issue a real fetch, and the previous version of
  // this test called it — which both hit the network and proved nothing beyond that.
  assert.equal(none.listTargets.length, fetchTargets.length, 'the default keeps the real function signature');
  const injected = selectDeps({ listTargets: async () => [], connect: async () => ({}) });
  assert.notEqual(injected.listTargets, fetchTargets, 'an injected transport wins');
  assert.equal(typeof fetchTargets, 'function');
  // The module source must not declare a default that calls itself by the same local name.
  const src = readFileSync(new URL('./iso/iso-inspect.mjs', import.meta.url), 'utf8');
  assert.equal(/const listTargets = deps\.listTargets \|\| \(\(port, ms\) => listTargets\(/.test(src), false, 'the self-recursive default must be gone');
  assert.match(src, /export function selectDeps/);
  assert.match(src, /listTargets: deps\.listTargets \|\| fetchTargets/);
});

test('the fixture entry point handles a synchronous refusal as exit code 2', () => {
  // parseFixtureArgs and writeFixture throw synchronously; the CLI must catch them itself rather
  // than attaching .then() to a value that is not a promise.
  assert.throws(() => parseFixtureArgs(['--fixture-id', 'audit-20261008-044410-mvs4d56']), (e) => e instanceof IsolationRefused);
  const src = readFileSync(new URL('./iso/iso-fixture.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(isDirectRun\(import\.meta\.url\)\) \{\s*try \{/);
  assert.match(src, /process\.exitCode = 2;/);
  assert.equal(/writeFixture\(options\)\.then\(/.test(src), false, 'must not chain .then() on a sync throw');
});

test('the screenshot branch is covered with an injected sender, not a live endpoint', async () => {
  // No network, no CDP: the transport is injected. This is the branch that previously crashed on an
  // out-of-scope `png` after a successful capture.
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const probe = goodProbe();
  probe.cards[0].hasResultPanel = true;
  probe.cards[0].resultChars = 42;
  const sent = [];
  const client = {
    send: async (method, params) => {
      sent.push(method);
      if (method === 'Runtime.evaluate') return { result: { value: probe } };
      if (method === 'Page.captureScreenshot') return { data: PNG };
      throw new Error('unexpected method ' + method);
    },
    close: () => {},
  };
  const report = await inspect(
    { cdpPort: 19331, expectFixtureId: FIX_ID, expectLabel: LABEL, out: join(ARTIFACTS, '_selftest-shots'), timeoutMs: 2000 },
    {
      listTargets: async () => [{ type: 'page', title: 'MiniMax Code', url: 'app://./archon?x=1#f', id: 'T', webSocketDebuggerUrl: 'ws://127.0.0.1:19331/devtools/page/T' }],
      connect: async () => client,
    },
  );
  assert.deepEqual(sent, ['Runtime.evaluate', 'Page.captureScreenshot']);
  assert.equal(report.screenshotBytes, Buffer.from(PNG, 'base64').length, 'screenshotBytes is readable after capture');
  assert.ok(report.screenshot.endsWith('.png'));
  assert.equal(report.screenshotSkipped, null);
  assert.equal(report.verdict, 'PASS', report.reasons.join(' | '));
  assert.equal(existsSync(report.screenshot), true);
  // A credential surface skips the capture entirely and reports counts only.
  const login = { ...probe, passwordInputCount: 1 };
  const loginReport = await inspect(
    { cdpPort: 19331, expectFixtureId: FIX_ID, expectLabel: LABEL, out: join(ARTIFACTS, '_selftest-shots'), timeoutMs: 2000 },
    {
      listTargets: async () => [{ type: 'page', title: 'MiniMax Code', url: 'app://./archon', id: 'T2', webSocketDebuggerUrl: 'ws://127.0.0.1:19331/devtools/page/T2' }],
      connect: async () => ({ send: async (m) => (m === 'Runtime.evaluate' ? { result: { value: login } } : { data: PNG }), close: () => {} }),
    },
  );
  assert.equal(loginReport.screenshot, null);
  assert.equal(loginReport.screenshotBytes, 0);
  assert.match(loginReport.screenshotSkipped, /CREDENTIAL_SURFACE/);
  // No app://./archon target on the named port is BLOCKED, never a pass.
  const noTarget = await inspect(
    { cdpPort: 19331, expectFixtureId: FIX_ID, expectLabel: LABEL, out: ARTIFACTS, timeoutMs: 2000 },
    { listTargets: async () => [{ type: 'page', title: 'MiniMax Code', url: 'http://localhost:19331/archon', id: 'X', webSocketDebuggerUrl: 'ws://127.0.0.1:19331/devtools/page/X' }] },
  );
  assert.equal(noTarget.verdict, 'BLOCKED');
  assert.ok(noTarget.reasons.some((x) => /NO_ARCHON_TARGET/.test(x)));
});

test('CLI entry points use the strict isDirectRun check, not a basename match', () => {
  // argv[1] IS this file under `node --test`, so this file is correctly seen as the entry point.
  assert.equal(isDirectRun(import.meta.url), true);
  // Any OTHER module — including the tool modules imported above — must not be, which is why this
  // suite could import all of them without a port being bound or a sidecar being started.
  assert.equal(isDirectRun('file:///nope/other.mjs'), false);
  assert.equal(isDirectRun(new URL('./iso/iso-sidecar.mjs', import.meta.url).href), false);
  assert.equal(isDirectRun(new URL('./iso/iso-inspect.mjs', import.meta.url).href), false);
  assert.equal(isDirectRun(new URL('./iso/iso-fixture.mjs', import.meta.url).href), false);
  assert.equal(isDirectRun(new URL('./iso/iso-observer.mjs', import.meta.url).href), false);
});

// ---- the observer wiring: the reachability gap this suite closes ----------------
//
// Before this, `deps.observe` had no CLI entry point, so the production invocation always hit the
// guard's default refusal and the live-identity gate could never be satisfied in a real run. The
// wiring below is asserted on two levels: the pure re-validation seam, and the real startIsoSidecar
// with its two host objects injected — so no port is ever bound and no process is ever contacted.

const OBS_PID = 4343;
const OBS_START = '2026-10-09T02:00:00.0000000Z';
const OBS_EXE = 'G:/MiniMax/MiniMax Code/MiniMax Code.exe';
const OBS_DOC = () => ({
  kind: 'mmx-ui-isolation-instance', isolated: true, backendIsolationProven: true,
  pid: OBS_PID, startTime: OBS_START, exe: OBS_EXE, debugPort: 19331,
  userDataDir: join(ARTIFACTS, 'electron-profile'), runtimeDataDir: join(ARTIFACTS, 'runtime-data'),
  observed: { pid: OBS_PID, startTimeUtc: OBS_START, exe: OBS_EXE, debugPort: 19331, debugPortOwnerPid: OBS_PID,
    userDataDir: join(ARTIFACTS, 'electron-profile'), runtimeDataDir: join(ARTIFACTS, 'runtime-data') },
});
const obsLive = (over = {}) => ({
  pid: OBS_PID, startTimeUtc: OBS_START, exe: OBS_EXE, debugPortOwnerPid: OBS_PID,
  userDataDir: join(ARTIFACTS, 'electron-profile'), runtimeDataDir: join(ARTIFACTS, 'runtime-data'), ...over,
});
const obsReport = () => join(ARTIFACTS, '_selftest-observer-wiring.json');

test('--observe is the CLI entry point the live identity gate was missing', () => {
  const file = obsReport();
  const args = parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES, '--launch-state', file, '--observe', file]);
  assert.equal(args.observeState, file);
  // Absent by default — and absent means the guard's own default refusal, which must not change.
  assert.equal(parseIsoArgs(['--cdp-port', '19331', '--root', FIXTURES]).observeState, null);
  // The identity record and the observation must describe the SAME instance, so the two paths may
  // not silently point at two different reports.
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--launch-state', obsReport(), '--observe', join(ARTIFACTS, 'other.json')]), /same launch report/);
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--observe', 'G:/mmx-project/zcode动态工作流-原else/.qoder/state.json']), /escapes/);
  refused(() => parseIsoArgs(['--cdp-port', '19331', '--observe']), /needs a value/);
});

test('NEGATIVE: a run WITHOUT --observe is still refused before a listener exists', async () => {
  // No injected observer, and none reachable from the args: the guard refuses. This throws BEFORE
  // createHostApi is called, so nothing binds a port — the assertion below proves it, because the
  // fake host API would have been invoked if the refusal had not come first.
  const file = obsReport();
  writeFileSync(file, JSON.stringify(OBS_DOC()), 'utf8');
  let hostApiCalled = false;
  const options = {
    cdpPort: 19331, roots: [FIXTURES], clientPath: CLIENT_SCRIPT,
    manifest: join(ARTIFACTS, '_selftest-observer-wiring.manifest.json'),
    launchState: file, observeState: null, pollMs: 1000, requireAttachMs: 0, quiet: true,
  };
  await assert.rejects(
    startIsoSidecar(options, { pid: 1, on() {} }, {
      createHostApi: () => { hostApiCalled = true; throw new Error('the host API must not be reached'); },
    }),
    (e) => e instanceof IsolationRefused && /no LIVE identity observation/.test(e.message),
  );
  assert.equal(hostApiCalled, false, 'the refusal happens before any listener is created');
});

test('the injector connector re-verifies the live identity before every attach', async () => {
  const file = obsReport();
  writeFileSync(file, JSON.stringify(OBS_DOC()), 'utf8');
  const calls = { observe: 0, verified: 0, revoked: 0, connect: 0 };
  const client = { close() {} };
  const connector = createRevalidatedConnector({
    launchState: file, cdpPort: 19331, observe: () => { calls.observe += 1; return obsLive(); },
    connect: async (wsUrl) => { calls.connect += 1; return client; },
    onVerified: () => { calls.verified += 1; },
    onRevoked: () => { calls.revoked += 1; },
  });
  // Two attaches (the second is a re-attach after the target changed id): two observations.
  assert.equal(await connector('ws://127.0.0.1:19331/devtools/page/A', {}), client);
  assert.equal(await connector('ws://127.0.0.1:19331/devtools/page/B', {}), client);
  assert.equal(calls.observe, 2);
  assert.equal(calls.verified, 2);
  assert.equal(calls.connect, 2, 'the CDP socket is opened only after the identity holds');

  // The instance is replaced while the sidecar runs: the NEXT attach must refuse rather than
  // reconnect, and the connector must not open a socket at all.
  let boom = new Error('gone');
  const revoked = createRevalidatedConnector({
    launchState: file, cdpPort: 19331, observe: () => { throw boom; },
    connect: async () => { throw new Error('must not connect'); },
    onRevoked: (error) => { assert.equal(error, boom); calls.revoked += 1; },
  });
  assert.throws(() => revoked('ws://127.0.0.1:19331/devtools/page/C', {}), /gone/);
  assert.equal(calls.revoked, 1);
  // A poisoned report (backendIsolationProven flipped back to false) revokes too.
  writeFileSync(file, JSON.stringify({ ...OBS_DOC(), backendIsolationProven: false }), 'utf8');
  assert.throws(() => revoked('ws://127.0.0.1:19331/devtools/page/D', {}), /BACKEND_ISOLATION_UNPROVEN/);
});

test('the sidecar hands the re-validating connector to the real injector, and stops on revocation', async () => {
  const file = obsReport();
  writeFileSync(file, JSON.stringify(OBS_DOC()), 'utf8');
  let injectorOptions = null;
  let closed = false, stopped = false;
  let live = obsLive();
  const fakeClient = { close() {} };
  const manifest = join(ARTIFACTS, '_selftest-observer-wiring.manifest.json');
  const api = {
    capability: 'a'.repeat(64),
    start: async () => ({ address: () => ({ port: 4711 }) }),
    close: async () => { closed = true; },
  };
  const options = {
    cdpPort: 19331, roots: [FIXTURES], clientPath: CLIENT_SCRIPT, manifest,
    launchState: file, observeState: file, pollMs: 1000, requireAttachMs: 0, quiet: true,
  };
  const run = await startIsoSidecar(options, { pid: 1, on() {} }, {
    observe: () => live,
    createHostApi: () => api,
    startCdpInjector: (o) => { injectorOptions = o; return { target: null, stop: async () => { stopped = true; return { cleaned: true, errors: [] }; } }; },
    connect: async () => fakeClient,
  });
  assert.equal(run.apiBase, 'http://127.0.0.1:4711');
  // The real option name the injector actually reads — not a same-shaped lookalike.
  assert.equal(typeof injectorOptions.connect, 'function', 'the injector must receive the guarded connector');

  // Attach #1: the identity holds, so the socket is opened.
  assert.equal(await injectorOptions.connect('ws://127.0.0.1:19331/devtools/page/A', {}), fakeClient);
  // The instance is replaced underneath us; the next attach must refuse, and the injector must be
  // stopped rather than left polling. The stop is deferred by a timer on purpose: stop() awaits the
  // in-flight attach, and we are being called from inside it.
  live = obsLive({ startTimeUtc: '2026-10-09T03:00:00.0000000Z' });
  assert.throws(() => injectorOptions.connect('ws://127.0.0.1:19331/devtools/page/B', {}), /STALE_ISOLATION_PROOF/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stopped, true, 'a revoked identity must stop the injector, not silently retry');
  const written = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.match(written.identityRevoked, /STALE_ISOLATION_PROOF/, 'the revocation is recorded in the manifest');
  assert.equal(written.attached, false, 'a revoked run never claims an attached renderer');
  // Shutdown must SURFACE the revocation rather than report a clean stop: a run whose identity
  // was revoked is not a run that cleaned up successfully.
  await assert.rejects(run.shutdown(), (e) => e instanceof AggregateError
    && e.errors.some((m) => /IDENTITY_REVOKED/.test(m)));
  assert.equal(closed, true);
});