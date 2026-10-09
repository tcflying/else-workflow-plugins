// test/engine-entry-alignment.test.mjs — 1004.md §4 W4 / F23 (mmx-native-session-hook).
//
// F23: "MMX 安装 Skill 创建入口与 Hook 精确匹配入口不一致". The hook only ever rewrites a command
// that names THIS workspace's engine, so a create entry that points anywhere else produces a run
// the engine records with no native origin (`origin=null`).
//
// Re-verified against the current tree before implementing (this item carries no "历史快照" note,
// but the deployed state is what decides it):
//
//   * scripts/relay.mjs:14  ENGINE_RESOLVED =
//     'g:/mmx-project/zcode动态工作流-原else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs'
//     — the workspace engine, and `shouldAppendFlag` matches that whole path (case/separator
//     insensitive), never a basename.
//   * mmx-workflow-pipeline/skills/mmx-workflow/SKILL.md:52-56 — the only supported entry names
//     that exact file and says "Do not use an installed copy under ~/.minimax/skills/; the native
//     session hook and the attribution contract both key off this path".
//   * mmx-workflow-pipeline/install-skills.mjs:37 — its engine identity (the thing it validates
//     the deployment against) is the same workspace engine, and it installs ONLY `mmx-workflow`;
//     the generic `dynamic-workflow` skill is quarantined, never installed.
//   => the MMX-specific install/call guidance is ALREADY aligned with the hook's workspace-only
//      boundary, which is the branch F23's minimal fix prefers. So no guidance edit is made here;
//      what was missing is any test that would notice the two drifting apart, plus an explicit
//      statement of the one residual (see the last test).
//
// The doc's own experiment method is reused: import the real relay `handle` and feed it synthetic
// command strings. No engine is executed, no synthetic script is run, no host is contacted, no
// process is spawned, no Temp directory is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { handle, shouldAppendFlag } from '../scripts/relay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_ROOT = resolve(HERE, '..');                       // plugins/mmx-native-session-hook
const PIPELINE_ROOT = resolve(HOOK_ROOT, '..', '..', 'mmx-workflow-pipeline');
const SKILL_MD = join(PIPELINE_ROOT, 'skills', 'mmx-workflow', 'SKILL.md');
const INSTALLER = join(PIPELINE_ROOT, 'install-skills.mjs');
const INSTALLED_SKILL = 'C:/Users/datoo/.minimax/skills/mmx-workflow/SKILL.md';
const INSTALLED_LEGACY_ENGINE = 'C:/Users/datoo/.minimax/skills/dynamic-workflow/runtime/wf.mjs';

const norm = (p) => p.replace(/\//g, '\\').toLowerCase();
const skillText = readFileSync(SKILL_MD, 'utf8');

// The engine path the guidance publishes: the first absolute .../wf.mjs literal in the skill.
const guidedEngine = (skillText.match(/[A-Za-z]:[\\/][^\s`]*wf\.mjs/) || [])[0];
const preToolUse = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'bash', session_id: 'sess-mm-w4',
  cwd: 'G:/mmx-project/zcode动态工作流-原else', tool_input: { command }, ...extra,
});
const flaggedCommand = async (command) => {
  const out = await handle(JSON.stringify(preToolUse(command)));
  if (!out) return null;
  return JSON.parse(out).hookSpecificOutput.updatedInput.command;
};
const hostSessionOf = (command) => {
  const m = command && command.match(/--host-session (\S+)/);
  return m ? JSON.parse(Buffer.from(m[1], 'base64url')) : null;
};

test('F23: the guidance names a real engine file, and it is the one the hook matches', () => {
  assert.ok(guidedEngine, 'SKILL.md publishes an absolute engine path');
  assert.ok(existsSync(guidedEngine), 'that engine file exists: ' + guidedEngine);
  // The hook's own boundary, read from its source rather than re-typed here.
  const relaySource = readFileSync(join(HOOK_ROOT, 'scripts', 'relay.mjs'), 'utf8');
  const hookEngine = (relaySource.match(/const ENGINE_RESOLVED = '([^']+)'/) || [])[1];
  assert.ok(hookEngine, 'relay.mjs still pins one exact engine path');
  assert.equal(norm(guidedEngine), norm(hookEngine),
    'the published entry and the hook entry are the same file — a rename on one side alone fails here');
});

test('F23: the workspace create entry is attributed to the exact native session', async () => {
  const command = 'node "' + guidedEngine + '" run "G:/ws/.qoder/workflow-drafts/w4.js" --backend file --yes --run-id w4';
  assert.equal(shouldAppendFlag(command), true);
  const flagged = await flaggedCommand(command);
  assert.ok(flagged, 'the hook rewrites the workspace create command');
  assert.ok(flagged.startsWith(command + ' '), 'the original command text is preserved byte-for-byte');
  assert.deepEqual(hostSessionOf(flagged), { host: 'mmx', sessionId: 'sess-mm-w4', source: 'native-hook' },
    'so the engine records a native origin instead of origin=null');
});

test('F23: an installed-copy create entry stays unattributed — the boundary is deliberate', async () => {
  const command = 'node "' + INSTALLED_LEGACY_ENGINE + '" run "G:/ws/w4.js" --backend file --yes --run-id w4';
  assert.equal(shouldAppendFlag(command), false, 'the hook never rewrites another engine copy');
  assert.equal(await flaggedCommand(command), null, 'no --host-session is appended, so origin stays null');
  // The same engine file NAME elsewhere in the tree must not match either (no basename matching).
  assert.equal(shouldAppendFlag('node "C:/elsewhere/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs" run x'), false);
});

test('F23: the create and resume entries in the guidance are the same workspace engine', () => {
  // The guidance spells every engine invocation as <ENGINE>; the resume/stop/steer rows carry no
  // path of their own, so they can only mean the same workspace file. If a future edit adds an
  // installed-copy path to a create or resume row, this fails.
  const engineInvocations = [...skillText.matchAll(/node "?<ENGINE>"? ([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(engineInvocations, ['check', 'run'], 'create/check entries both go through <ENGINE>');
  assert.ok(!/\.minimax[\\/]skills[\\/][^\s`]*wf\.mjs/.test(skillText),
    'no engine path under the installed skill tree is ever presented as a runnable entry');
  assert.match(skillText, /Do \*\*not\*\* use an installed copy under/, 'the workspace-only boundary is stated in the guidance itself');
});

test('F23: a resume is never retro-attributed by the hook', async () => {
  // The doc's trigger notes resume keeps the original null rather than back-filling one: the hook
  // tags `run` only, so replaying a settled run cannot invent an attribution it never had.
  const resume = 'node "' + guidedEngine + '" resume w4';
  assert.equal(shouldAppendFlag(resume), false);
  assert.equal(await flaggedCommand(resume), null);
});

test('F23: the installer validates against the same engine the hook matches', () => {
  // ENGINE is module-private in install-skills.mjs, so the expression is replicated here from the
  // source text: a rename surfaces as a clear failure instead of a silent mismatch.
  const source = readFileSync(INSTALLER, 'utf8');
  const line = (source.match(/const ENGINE = join\(HERE,([^)]*)\);/) || [])[1];
  assert.ok(line, 'the installer still pins one engine identity');
  const segments = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const installerEngine = resolve(dirname(INSTALLER), ...segments);
  assert.equal(norm(installerEngine), norm(guidedEngine), 'installer engine identity === hook engine === published entry');
  assert.match(source, /const SRC = join\(HERE, 'skills', 'mmx-workflow'\)/,
    'only the dedicated MMX skill is installed');
  assert.match(source, /const LEGACY_NAME = 'dynamic-workflow'/,
    'the generic dynamic-workflow skill is quarantined, never installed');
});

test('F23: the deployed mmx-workflow guidance, if present, points at the workspace engine', () => {
  if (!existsSync(INSTALLED_SKILL)) return;   // not deployed on this machine: nothing to claim
  const installed = readFileSync(INSTALLED_SKILL, 'utf8');
  const installedEngine = (installed.match(/[A-Za-z]:[\\/][^\s`]*wf\.mjs/) || [])[0];
  assert.ok(installedEngine, 'the installed skill publishes an engine path');
  assert.equal(norm(installedEngine), norm(guidedEngine),
    'the installed copy has not drifted onto an installed engine copy');
});
