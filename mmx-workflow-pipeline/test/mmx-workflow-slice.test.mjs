// N01/N02 slice safety tests for the dedicated `mmx-workflow` Skill and its installer.
//
// Scope of this file, and nothing outside it:
//   * static contract of the Skill text (the explicit-command gate, the real MMX `task` tool, the
//     file-backend bridge, the ask() wait rule, the guard wording);
//   * installer target ownership + legacy-quarantine proof-by-sha256, against an isolated skills root;
//   * the workspace engine driven in a throwaway mkdtemp workspace: `--backend file --yes` settles
//     without any user confirmation, the answer shapes are the documented two, a business ask() is
//     never auto-answered, and the guards still refuse.
//
// Every write lands in a unique mkdtemp subtree. No real subagent is dispatched (no `task` call, no
// model spend), no host is started or stopped, and the user's real skill tree is never touched. A
// real UI / real-`task` end-to-end run is deliberately NOT covered here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, renameSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, parse as parsePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as installer from '../install-skills.mjs';
import { captureParkedCall, settleDocument, indexReady, perCallReady, CALL_ID_RE } from './lib/engine-park.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SKILL_DIR = join(REPO, 'mmx-workflow-pipeline', 'skills', 'mmx-workflow');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const ENGINE = join(REPO, 'plugins', 'dynamic-workflow', 'skills', 'dynamic-workflow', 'runtime', 'wf.mjs');
const LEGACY_REFERENCE = join(REPO, 'plugins', 'dynamic-workflow', 'skills', 'dynamic-workflow');
const SKILL = readFileSync(SKILL_MD, 'utf8');
// The skill is prose, so every contract phrase is matched against a whitespace-collapsed copy:
// a wrapped sentence must not make a real assertion look broken.
const SKILL_FLAT = SKILL.replace(/\s+/g, ' ');
const has = (phrase) => SKILL_FLAT.includes(phrase.replace(/\s+/g, ' '));

function tempRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function runEngine(cwd, args, env = {}) {
  return spawnSync(process.execPath, [ENGINE, ...args], { cwd, encoding: 'utf8', timeout: 90000, env: { ...process.env, ...env } });
}
// The engine writes `WF ...` progress lines to stdout before the JSON document.
const parse = (result) => JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
function writeScript(cwd, name, body) {
  const dir = join(cwd, '.qoder', 'workflow-drafts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + '.js');
  writeFileSync(file, body);
  return file;
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// --- 1. static contract of the Skill text ------------------------------------------------------

test('the skill declares a unique name, so it cannot collide with the official dynamic-workflow skill', () => {
  assert.match(SKILL, /^---\r?\nname:\s*mmx-workflow\s*$/m);
  assert.match(SKILL, /^description:/m);
  assert.equal(installer.readSkillName(SKILL_MD), 'mmx-workflow');
  assert.notEqual(installer.readSkillName(SKILL_MD), 'dynamic-workflow');
});

test('the skill ships no engine copy: it drives the workspace engine by absolute path', () => {
  assert.deepEqual(readdirSync(SKILL_DIR).sort(), ['SKILL.md']);
  assert.ok(SKILL.includes('plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs'),
    'the skill must name the workspace engine path rather than an installed copy');
  assert.ok(!existsSync(join(SKILL_DIR, 'runtime')), 'the skill must not ship a second engine copy');
  assert.ok(!SKILL.includes('~/.minimax/skills/dynamic-workflow'), 'the retired installed copy must not be named as the engine');
});

test('the explicit-command gate is stated, and natural language is explicitly not a trigger', () => {
  assert.ok(has('/mmx-workflow'), 'the literal entry token must appear in the skill text');
  assert.ok(has("contains the literal token"), 'the gate must be phrased as a token test');
  assert.ok(has('Natural language never triggers a run'));
  assert.ok(has('fan out over these files'), 'a natural-language example must be shown as not triggering');
  assert.ok(has('Do not create a run, do not start one'), 'creation and start must both be gated');
});

test('polling, displaying and answering an existing run are not forbidden by the gate', () => {
  assert.ok(has('Not forbidden without the token'));
  assert.ok(has('polling or reading an already-running run'));
  assert.ok(has("showing a run's progress"));
  assert.ok(has('answering a `kind:"question"` item that an **already running** run is blocked on'));
});

test('the file bridge names the real MMX subagent tool and its exact schema fields', () => {
  assert.ok(has('| `description` | yes |'), 'task.description must be documented');
  assert.ok(has('| `prompt` | yes |'), 'task.prompt must be documented');
  assert.ok(has('| `agent_name` | yes |'), 'task.agent_name must be documented');
  for (const role of ['mavis', 'explore', 'worker', 'verifier']) {
    assert.ok(SKILL.includes('`' + role + '`'), 'role ' + role + ' must be listed');
  }
  assert.ok(has('not "Agent tool"'), 'the Qoder tool name must be called out as wrong for this host');
  assert.ok(has('`additionalProperties` is `false`'), 'the closed schema must be acknowledged');
  assert.ok(has('SUBAGENT_CONCURRENCY_LIMIT'), 'the host concurrency limit must be handled');
});

test('the answer-file shapes, the callId pattern and the containment rule are all in the skill', () => {
  assert.ok(has('{"ok": true,  "text": "<the child\'s final answer>"}'));
  assert.ok(has('{"ok": false, "error": "<why it failed>"}'));
  assert.ok(has('inbox/<callId>.txt'));
  assert.ok(has('^[cq][0-9]{3,}-[0-9a-f]{8}$'), 'the callId validation pattern must be in the skill, in its {3,} form');
  assert.ok(has('still inside'), 'the containment re-check must be stated');
  assert.ok(has('write exactly one file per callId, exactly once'));
  assert.ok(has('Never append, never write'));
});

test('the handshake reads the pending.json index first, then the per-call file, and cross-checks them', () => {
  assert.ok(has('Read `<runDir>/pending.json` — the **index** first'), 'the index must be the first read');
  assert.ok(has('the only list you dispatch from'), 'dispatch must come from the index, not a directory listing');
  assert.ok(has('Dispatch from `items[]` only, never by listing the directory'), 'a directory listing must be refused');
  // runId is an INDEX-top-level field. The skill must say so, and must NOT tell the host to look
  // for a runId in the per-call file: the engine writes none, so requiring one would reject every
  // real run. This assertion is deliberately an absence check.
  assert.ok(has('`runId` lives only here, at the index top level'));
  assert.ok(has('It must equal the `--run-id` you passed to'));
  assert.ok(has('carries **no `runId`**'), 'the skill must state the per-call file has no runId');
  assert.ok(has('Do not go looking for one, and do not invent one'));
  assert.ok(!has('the per-call file names a different `runId`'), 'the false per-call runId claim must be gone');
  // wants come from the per-call file only; the index item does not carry them.
  assert.ok(has('are **not** in the index'), 'the index item must be described as lacking the wants');
  assert.ok(has('`model` / `agent` / `systemPrompt` / `cwd`'), 'the wants keys must be named');
  // per-call vs index cross-check is callId + prompt (+ filename), never runId.
  assert.ok(has('agree with the index item it came from on `callId`'));
  assert.ok(has('its `prompt` must be the one the index lists'));
  assert.ok(has("must equal the filename's `callId`"), 'the filename/body callId must agree');
  // containment survives the correction.
  assert.ok(has('must still be inside `<runDir>/pending`'));
});

test('the callId pattern accepts 3-or-more digits and traversal is refused outright', () => {
  assert.ok(has('^[cq][0-9]{3,}-[0-9a-f]{8}$'), 'the callId pattern must allow {3,} digits');
  assert.ok(!has('^[cq][0-9]{3}-[0-9a-f]{8}$'), 'the exact-3 form must be gone');
  assert.ok(has('`c001-…`, `q000-…`'));
  assert.ok(has('reject path traversal outright'), 'traversal must be refused independently of the pattern');
  assert.ok(has('a drive colon `:`'), 'a drive colon must be refused');
  assert.ok(has('A pattern match alone is not permission to build a path'));
  assert.ok(has('Containment is the check that matters'));
});

test('the engine pre-flight checks the path and the exact version before anything else', () => {
  assert.ok(has('The engine file exists at the exact path above'), 'an existence check is required');
  assert.ok(has('do not look for a copy elsewhere'), 'a missing engine must not be substituted');
  assert.ok(has('ENGINE_VERSION'), 'the version must be read, not assumed');
  assert.ok(has('Expected: **`0.8.1`**'), 'the expected version must be stated');
  assert.ok(has('report the version you read and stop'));
  assert.ok(has('do not assume it'));
});

test('the skill says the invocation gate is a policy, not a mechanical host lock', () => {
  assert.ok(has('This gate is a policy you follow, not a mechanical lock'));
  assert.ok(has('none of them restricts invocation to an explicit command'), 'the frontmatter limits must be stated');
  assert.ok(has('no `invocation_policy` / `explicit_only` key exists in this host build'));
  assert.ok(has('the **sandbox filesystem** policy, a different thing entirely'), 'the decoy symbol must be named and dismissed');
  assert.ok(has('do not invent such a key, do not claim the host enforces this for you'));
  assert.ok(has('the `skill` tool'), 'the one thing the host does prove must still be cited');
  assert.ok(has('The `@name` form is **not** claimed here'), 'an unproven invocation form must stay unclaimed');
  assert.ok(has('no skills section'));
});

test('a business ask() must be answered by the user, never fabricated', () => {
  assert.ok(has('kind:"question"'), 'the question marker must be recognised');
  assert.ok(has('Do not fabricate an answer, auto-select a default, guess'));
  assert.ok(has('treat a timeout or silence as agreement'));
  assert.ok(has('ask(question, opts?)'), 'ask must stay in the facade table');
});

test('the launch authorization is scoped to starting this run and never widens a guard', () => {
  assert.ok(has('--backend file --yes'), 'the self-authorized launch command must be literal');
  assert.ok(has('basis:"flag"'), 'the audit record for an authorized start must be named');
  assert.ok(has('Do **not** call an ask/approve tool'));
  assert.ok(has("covers exactly one action: starting this engine's own run"));
  for (const guard of ['OWNER', '--max-calls', 'additionalProperties', 'forbidden_module']) {
    assert.ok(has(guard), guard + ' must be acknowledged as a guard that stays on');
  }
  assert.ok(has("keep the host's normal"), 'non-workflow commands must keep the normal confirm path');
  assert.ok(has('Never fake a business answer'));
  assert.ok(has('never present one as the other'), 'the official review path must not be conflated');
});

test('the skill refuses the official pending_review path instead of routing around it', () => {
  assert.ok(has('pending_review'));
  assert.ok(has('Start execution'));
  assert.ok(has("Never route this engine's runs through it"));
  assert.ok(has('no approve API'), 'the absence of an approval API must be stated, not worked around');
});

// --- 2. installer: target ownership and legacy quarantine ---------------------------------------

// Every fixture gets its own skills root AND its own work root, both inside one unique mkdtemp
// tree, so no test can write to the real ~/.minimax, and no two tests share a path.
function skillsRootFixture(t) {
  const root = tempRoot(t, 'mmx-wf-install-');
  const home = join(root, 'home');
  const skills = join(home, 'skills');
  // The work root is derived by the same rule the code uses, so the fixture exercises the real path.
  const work = installer.workRootFor(skills);
  mkdirSync(skills, { recursive: true });
  return { root, home, skills, work, destination: join(skills, 'mmx-workflow') };
}
function legacyTree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-wf-legacy-'));
  // This helper's own tree, cleaned with the case that made it. It is renamed into the fixture
  // immediately, so the cleanup is a no-op in the normal path; it only matters when a case fails
  // between the two steps.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(LEGACY_REFERENCE, dir, { recursive: true });
  return dir;
}
// A byte-identical legacy tree, i.e. one this installer may legitimately move.
function seedProvableLegacy(f, t) { renameSync(legacyTree(t), join(f.skills, 'dynamic-workflow')); }

// A fingerprint of a tree that changes if anything under it is created, removed, renamed or
// rewritten: relative path, byte length, sha256 and mtime for every entry.
function fingerprint(root) {
  const rows = [];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      const rel = prefix ? prefix + '/' + name : name;
      if (st.isDirectory()) { rows.push('D ' + rel + ' ' + st.mtimeMs); walk(path, rel); }
      else rows.push('F ' + rel + ' ' + st.size + ' ' + st.mtimeMs + ' ' + createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(root, '');
  return rows.join('\n');
}

test('installing the skill only ever creates <root>/mmx-workflow and leaves the source untouched', (t) => {
  const f = skillsRootFixture(t);
  const before = readFileSync(SKILL_MD, 'utf8');
  const result = installer.installSkill({ destination: f.destination, workRoot: f.work });
  assert.equal(installer.readEngineVersion(ENGINE), '0.8.1');
  assert.equal(result.engineVersion, '0.8.1');
  assert.deepEqual(readdirSync(f.skills), ['mmx-workflow']);
  assert.deepEqual(readdirSync(f.destination), ['SKILL.md']);
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), SKILL);
  assert.equal(readFileSync(SKILL_MD, 'utf8'), before, 'the source tree must never be modified by an install');
  assert.equal(readFileSync(ENGINE, 'utf8').includes("ENGINE_VERSION = '0.8.1'"), true, 'the engine must never be modified by an install');
});

test('a missing workspace engine is refused before anything is created', (t) => {
  const f = skillsRootFixture(t);
  assert.throws(() => installer.installSkill({ engine: join(f.root, 'absent-wf.mjs'), destination: f.destination, workRoot: f.work }), /missing/i);
  assert.deepEqual(readdirSync(f.skills), []);
  assert.equal(existsSync(f.work), false, 'not even the work root is created when a precondition fails');
});

test('the installer refuses a destination occupied by an unrelated skill even with --force', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'SKILL.md'), '---\nname: someone-elses-skill\n---\nnot ours\n');
  writeFileSync(join(f.destination, 'private.txt'), 'unrelated');
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: f.work, force: true }), /unrecognized|unrelated/i);
  assert.equal(readFileSync(join(f.destination, 'private.txt'), 'utf8'), 'unrelated');
});

test('the installer refuses a source that is not the mmx-workflow skill', (t) => {
  const f = skillsRootFixture(t);
  const other = join(f.root, 'other-skill');
  mkdirSync(other);
  writeFileSync(join(other, 'SKILL.md'), '---\nname: dynamic-workflow\n---\nnot ours\n');
  assert.throws(() => installer.installSkill({ source: other, destination: f.destination, workRoot: f.work }), /unrecognized|unrelated/i);
  assert.deepEqual(readdirSync(f.skills), []);
});

test('an unsupported engine is refused before any directory is created', (t) => {
  const f = skillsRootFixture(t);
  const badEngine = join(f.root, 'wf.mjs');
  writeFileSync(badEngine, "export const ENGINE_VERSION = '99.0.0';");
  assert.throws(() => installer.installSkill({ engine: badEngine, destination: f.destination, workRoot: f.work }), /unsupported|expected/i);
  assert.deepEqual(readdirSync(f.skills), []);
  assert.equal(existsSync(f.work), false);
});

test('replacing an existing mmx-workflow needs --force and retains a verified backup', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'SKILL.md'), '---\nname: mmx-workflow\n---\nolder body\n');
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: f.work }), /--force/);
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), '---\nname: mmx-workflow\n---\nolder body\n');
  const result = installer.installSkill({ destination: f.destination, workRoot: f.work, force: true });
  assert.equal(readFileSync(join(result.backupPath, 'SKILL.md'), 'utf8'), '---\nname: mmx-workflow\n---\nolder body\n');
  assert.ok(result.backupPath.startsWith(f.work), 'the retained backup belongs to the work root, not the scanned tree');
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), SKILL);
});

test('a staging failure leaves the existing installation untouched and no stage behind', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'SKILL.md'), '---\nname: mmx-workflow\n---\nolder body\n');
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: f.work, force: true, operations: { copy: () => { throw new Error('COPY_FAILED'); } } }), /COPY_FAILED/);
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), '---\nname: mmx-workflow\n---\nolder body\n');
  assert.deepEqual(readdirSync(f.skills), ['mmx-workflow'], 'no stage or lock may be left in the scanned tree');
});

test('every transient lives in the work root, never in the scanned skills tree', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'SKILL.md'), '---\nname: mmx-workflow\n---\nolder body\n');
  let sawLock = null, sawStage = null;
  const result = installer.installSkill({ destination: f.destination, workRoot: f.work, force: true, operations: {
    copy: (source, stage, options) => { sawStage = stage; cpSync(source, stage, options); },
    rename: (from, to) => { if (from.includes('.install.lock') === false && from === sawLock) throw new Error('unreachable'); renameSync(from, to); },
  } });
  assert.ok(result.workRoot.startsWith(f.root), 'the work root stays inside the fixture');
  assert.ok(sawStage.startsWith(f.work), 'the staging tree must be created in the work root');
  // A hard kill leaves the staging tree behind; it must still not be inside the scanned tree.
  const orphans = readdirSync(f.work).filter((name) => name.includes('.stage-'));
  assert.deepEqual(orphans, [], 'this run cleaned its own stage up');
  assert.deepEqual(readdirSync(f.skills), ['mmx-workflow'], 'the scanned tree holds exactly one mmx-workflow, with no stage/lock siblings');
  assert.equal(existsSync(join(f.skills, 'mmx-workflow.install.lock')), false);
  assert.equal(existsSync(join(f.work, 'mmx-workflow.install.lock')), false, 'the lock is removed on the way out');
});

test('a hard-kill stage left in the work root is not a second skill in the scanned tree', (t) => {
  const f = skillsRootFixture(t);
  // Simulate exactly what a SIGKILL during staging leaves behind, in the location the code uses.
  mkdirSync(f.work, { recursive: true });
  const orphan = join(f.work, 'mmx-workflow.stage-abc123');
  mkdirSync(orphan);
  cpSync(SKILL_DIR, orphan, { recursive: true });
  assert.equal(installer.readSkillName(join(orphan, 'SKILL.md')), 'mmx-workflow', 'the orphan really would collide if it were scanned');
  assert.deepEqual(readdirSync(f.skills), [], 'but it lives outside the skills tree, so the loader never sees it');
  assert.equal(installer.legacyCandidates(f.skills).length, 0, 'and the quarantine never enumerates the work root');
});

test('the work root is refused when it is a symlink, a link hop, or sits inside the scanned skills tree', (t) => {
  const f = skillsRootFixture(t);
  const elsewhere = mkdtempSync(join(tmpdir(), 'mmx-wf-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const linked = join(elsewhere, 'linked-work');
  symlinkSync(f.skills, linked, 'junction');
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: linked }), /symbolic link|resolve to itself/i);
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: join(f.skills, 'inside') }), /outside the scanned skills tree/i);
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: f.destination }), /outside the scanned skills tree|outside the destination tree/i);
  assert.deepEqual(readdirSync(f.skills), []);
});

test('the work root is a sibling of the skills root, never a child, for the real tree too', () => {
  const real = installer.workRootFor('C:/Users/datoo/.minimax/skills');
  assert.equal(real, 'C:\\Users\\datoo\\.minimax\\mmx-workflow-skill-work');
  assert.equal(installer.WORK_ROOT, real, 'the constant the installer defaults to is the derived one');
  assert.equal(real.startsWith('C:\\Users\\datoo\\.minimax\\skills'), false, 'it must not be inside the scanned tree');
});

test('a cross-device move falls back to a verified copy and never deletes what it could not reproduce', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'SKILL.md'), '---\nname: mmx-workflow\n---\nolder body\n');
  const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  let renames = 0;
  const result = installer.installSkill({ destination: f.destination, workRoot: f.work, force: true, operations: {
    rename: (from, to) => { if (String(to).includes('mmx-workflow') && !String(to).includes('.bak-')) throw exdev; renames++; renameSync(from, to); },
  } });
  assert.equal(readFileSync(join(result.backupPath, 'SKILL.md'), 'utf8'), '---\nname: mmx-workflow\n---\nolder body\n', 'the EXDEV fallback still produced a byte-identical backup');
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), SKILL, 'and a byte-identical activation');
  assert.equal(renames, 1, 'only the final cleanup step stayed a plain rename');
});

test('an install lock is reported with its owner and is never removed by the installer', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.work, { recursive: true });
  const lockPath = join(f.work, 'mmx-workflow.install.lock');
  const content = JSON.stringify({ pid: 515151, startedAt: '2002-03-04T05:06:07.000Z', exe: 'other-owner.exe' });
  writeFileSync(lockPath, content);
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: f.work, force: true }), (error) => {
    assert.equal(error.code, 'INSTALL_LOCKED');
    assert.match(error.message, /515151/);
    assert.match(error.message, /2002-03-04T05:06:07.000Z/);
    return true;
  });
  assert.equal(readFileSync(lockPath, 'utf8'), content);
  assert.equal(existsSync(f.destination), false);
  assert.equal(readdirSync(f.work).some((n) => n.includes('.stage-')), false);
});

test('an activation failure rolls the original installation back', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'SKILL.md'), '---\nname: mmx-workflow\n---\nolder body\n');
  assert.throws(() => installer.installSkill({
    destination: f.destination, workRoot: f.work, force: true, operations: {
      rename: (from, to) => { if (from.includes('.stage-') && to === f.destination) throw new Error('ACTIVATION_FAILED'); renameSync(from, to); },
    },
  }), /ACTIVATION_FAILED/);
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), '---\nname: mmx-workflow\n---\nolder body\n');
});

test('a path immediately beneath a drive root keeps its basename', () => {
  const driveRoot = parsePath('G:\\').root;
  assert.equal(installer.canonicalDestinationPath(driveRoot + 'mmx-wf-path-test'), resolve(driveRoot, 'mmx-wf-path-test'));
});

test('a held install lock keeps a second installer process out, and the lock survives it', (t) => {
  const f = skillsRootFixture(t);
  mkdirSync(f.work, { recursive: true });
  const lockPath = join(f.work, 'mmx-workflow.install.lock');
  let heldLock = null;
  const result = installer.installSkill({ destination: f.destination, workRoot: f.work, operations: {
    copy: (source, stage, options) => {
      heldLock = readFileSync(lockPath, 'utf8');
      const owner = JSON.parse(heldLock);
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.exe, process.execPath);
      const entry = new URL('../install-skills.mjs', import.meta.url).href;
      const script = `import { installSkill } from ${JSON.stringify(entry)};
        try { installSkill({ destination: process.argv[1], workRoot: process.argv[2] }); process.exitCode = 2; }
        catch (error) { console.log(error.code); process.exitCode = error.code === 'INSTALL_LOCKED' ? 0 : 3; }`;
      const competing = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.destination, f.work], { encoding: 'utf8', timeout: 30000 });
      assert.equal(competing.status, 0, competing.stdout + competing.stderr);
      assert.match(competing.stdout, /INSTALL_LOCKED/);
      assert.equal(readFileSync(lockPath, 'utf8'), heldLock, 'the loser must not touch the lock');
      assert.equal(existsSync(f.destination), false, 'the loser must not create the destination');
      cpSync(source, stage, options);
    },
  } });
  assert.equal(existsSync(lockPath), false, 'the winning installer still cleans its own lock up');
  assert.equal(readFileSync(join(result.destination, 'SKILL.md'), 'utf8'), SKILL);
});

test('a legacy deployment proven byte-identical is moved out of the skill tree, not deleted', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  const decoy = join(f.skills, 'totally-other-skill');
  mkdirSync(decoy);
  writeFileSync(join(decoy, 'SKILL.md'), '---\nname: totally-other-skill\n---\nkeep me\n');
  const backupRoot = join(f.root, 'backups-outside-the-tree');
  const result = installer.quarantineLegacyDeployments({ skillsRoot: f.skills, backupRoot });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.moved.length, 1);
  assert.equal(existsSync(join(f.skills, 'dynamic-workflow')), false, 'the skill tree must no longer contain the legacy tree');
  assert.ok(readFileSync(join(result.moved[0].to, 'runtime', 'wf.mjs'), 'utf8').includes('ENGINE_VERSION'));
  assert.ok(!result.moved[0].to.startsWith(f.skills), 'the backup must live outside the scanned skill tree');
  assert.equal(readFileSync(join(decoy, 'SKILL.md'), 'utf8'), '---\nname: totally-other-skill\n---\nkeep me\n', 'no other skill may be touched');
});

test('a legacy deployment that is not byte-identical stays in place and is reported as a conflict', (t) => {
  const f = skillsRootFixture(t);
  const legacy = legacyTree(t);
  writeFileSync(join(legacy, 'SKILL.md'), readFileSync(join(legacy, 'SKILL.md'), 'utf8') + '\nhand edited by a human\n');
  renameSync(legacy, join(f.skills, 'dynamic-workflow'));
  const backupRoot = join(f.root, 'backups-outside-the-tree');
  const result = installer.quarantineLegacyDeployments({ skillsRoot: f.skills, backupRoot });
  assert.equal(result.moved.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].reason, /sha256 manifest differs/);
  assert.equal(existsSync(join(f.skills, 'dynamic-workflow', 'SKILL.md')), true, 'unprovable data must never be removed');
  assert.equal(existsSync(backupRoot), false, 'nothing is written when nothing is quarantined');
});

test('an older .bak- tree with a different engine is not provable and is left alone', (t) => {
  const f = skillsRootFixture(t);
  const legacy = legacyTree(t);
  writeFileSync(join(legacy, 'runtime', 'wf.mjs'), "export const ENGINE_VERSION = '0.7.1';\n");
  const name = 'dynamic-workflow.bak-2026-10-02T07-16-28-289Z-bf9b1c29-2599-411a-8090-1b5a58a4722b';
  renameSync(legacy, join(f.skills, name));
  const result = installer.quarantineLegacyDeployments({ skillsRoot: f.skills, backupRoot: join(f.root, 'backups') });
  assert.equal(result.moved.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(existsSync(join(f.skills, name, 'runtime', 'wf.mjs')), true);
});

test('the quarantine only ever considers the two directory names this installer created', (t) => {
  const f = skillsRootFixture(t);
  for (const name of ['dynamic-workflows', 'dynamic-workflow-helper', 'mavis-dynamic-workflow', 'a.bak-x']) {
    const dir = join(f.skills, name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + name + '\n---\nkeep\n');
  }
  const result = installer.quarantineLegacyDeployments({ skillsRoot: f.skills, backupRoot: join(f.root, 'backups') });
  assert.equal(result.moved.length, 0);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(readdirSync(f.skills).sort(), ['a.bak-x', 'dynamic-workflow-helper', 'dynamic-workflows', 'mavis-dynamic-workflow']);
});

test('a symlinked legacy tree is refused instead of followed', (t) => {
  const f = skillsRootFixture(t);
  const real = legacyTree(t);
  symlinkSync(real, join(f.skills, 'dynamic-workflow'), 'junction');
  const result = installer.quarantineLegacyDeployments({ skillsRoot: f.skills, backupRoot: join(f.root, 'backups') });
  assert.equal(result.moved.length, 0);
  assert.equal(existsSync(join(f.skills, 'dynamic-workflow')), true);
});

// --- fix 1: a dry run must write nothing at all -------------------------------------------------

test('quarantineLegacyDeployments with dryRun hashes and plans but performs no mkdir or rename', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  const backupRoot = join(f.root, 'backups');
  let mkdirCalls = 0, renameCalls = 0;
  const result = installer.quarantineLegacyDeployments({
    skillsRoot: f.skills, backupRoot, dryRun: true,
    mkdir: () => { mkdirCalls++; },
    rename: () => { renameCalls++; },
  });
  assert.equal(mkdirCalls, 0, 'a dry run must not create the backup root');
  assert.equal(renameCalls, 0, 'a dry run must not move a byte-identical legacy tree');
  assert.equal(result.moved.length, 1, 'it still reports what it would move');
  assert.equal(result.moved[0].applied, false);
  assert.ok(result.moved[0].to.startsWith(backupRoot));
  assert.equal(existsSync(join(f.skills, 'dynamic-workflow', 'SKILL.md')), true, 'the legacy tree is exactly where it was');
  assert.equal(existsSync(backupRoot), false, 'and no backup root was created');
});

test('a dry-run failure on a later candidate leaves every earlier one where it was', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  // A second, also-provable candidate, so the loop has something to fail on after the first move.
  const second = legacyTree(t);
  renameSync(second, join(f.skills, 'dynamic-workflow.bak-2026-01-01T00-00-00-000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
  let seen = 0;
  assert.throws(() => installer.quarantineLegacyDeployments({
    skillsRoot: f.skills, backupRoot: join(f.root, 'backups'),
    rename: (from, to) => { if (++seen === 2) throw new Error('MOVE_FAILED'); renameSync(from, to); },
  }), /MOVE_FAILED/);
  assert.deepEqual(readdirSync(f.skills).sort(), ['dynamic-workflow', 'dynamic-workflow.bak-2026-01-01T00-00-00-000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    'the tree moved before the failure is put back');
  assert.equal(existsSync(join(f.root, 'backups')), true, 'the backup root may exist, but it must be empty of moved trees');
  assert.deepEqual(readdirSync(join(f.root, 'backups')), [], 'nothing is left parked in the backup root');
});

test('the CLI dry run leaves a provable legacy tree, the backup root, the work root and the lock alone', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  const home = dirname(f.skills);
  const before = readdirSync(home).sort();
  assert.equal(installer.main(['--dry-run', '--skills-root', f.skills]), 0);
  assert.deepEqual(readdirSync(f.skills), ['dynamic-workflow'], 'the legacy tree did not move');
  assert.deepEqual(readdirSync(home).sort(), before, 'no new directory appeared anywhere under the fixture home');
  assert.equal(existsSync(join(f.skills, 'mmx-workflow')), false, 'and nothing was installed');
  assert.equal(existsSync(join(home, 'skills-work')), false, 'no work root was created');
});

test('a --skills-root run never moves a tree into the real ~/.minimax backup root', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  const before = readdirSync(f.home).sort();
  assert.equal(installer.main(['--dry-run', '--skills-root', f.skills]), 0);
  const plan = installer.quarantineLegacyDeployments({ skillsRoot: f.skills, dryRun: true });
  for (const entry of plan.moved) {
    assert.ok(entry.to.startsWith(f.home), 'the reported target belongs to the fixture home: ' + entry.to);
    assert.equal(entry.to.startsWith(dirname(installer.BACKUP_ROOT)), false,
      'and never to the real ~/.minimax tree: ' + entry.to);
  }
  assert.deepEqual(readdirSync(f.home).sort(), before, 'and the dry run still created nothing');
  assert.equal(installer.BACKUP_ROOT, 'C:\\Users\\datoo\\.minimax\\mmx-workflow-skill-backups', 'the real default is the sibling of the real skills root');
  assert.equal(installer.backupRootFor(f.skills), installer.backupRootFor(f.skills), 'derivation is stable');
});

test('a real --skills-root run quarantines inside the fixture, never in the real home', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  assert.equal(installer.main(['--skills-root', f.skills]), 0);
  assert.deepEqual(readdirSync(f.skills), ['mmx-workflow']);
  const backups = readdirSync(f.home).sort();
  assert.ok(backups.includes('mmx-workflow-skill-backups'), 'the moved tree landed in the fixture backup root: ' + backups.join(','));
  const moved = readdirSync(join(f.home, 'mmx-workflow-skill-backups'));
  assert.equal(moved.length, 1);
  assert.ok(readFileSync(join(f.home, 'mmx-workflow-skill-backups', moved[0], 'runtime', 'wf.mjs'), 'utf8').includes('ENGINE_VERSION'), 'content intact');
});

// --- fix 2: install is completed before any legacy tree is moved -------------------------------

test('a refused install never quarantines the legacy tree', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  // Destination already holds an mmx-workflow, so the install is refused without --force.
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'SKILL.md'), '---\nname: mmx-workflow\n---\nalready here\n');
  assert.throws(() => installer.main(['--skills-root', f.skills]), /--force/);
  assert.equal(existsSync(join(f.skills, 'dynamic-workflow', 'SKILL.md')), true,
    'a failed install must leave the generic skill exactly where it was');
  assert.equal(existsSync(join(f.skills, 'dynamic-workflow.bak-2026-10-02T07-16-28-289Z-bf9b1c29-2599-411a-8090-1b5a58a4722b')), false);
});

test('an install refused by a held lock never quarantines the legacy tree', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  mkdirSync(f.work, { recursive: true });
  writeFileSync(join(f.work, 'mmx-workflow.install.lock'), JSON.stringify({ pid: 4242, startedAt: '2003-04-05T06:07:08.000Z', exe: 'someone-else.exe' }));
  assert.throws(() => installer.main(['--skills-root', f.skills]), /lock exists/i);
  assert.equal(existsSync(join(f.skills, 'dynamic-workflow', 'SKILL.md')), true);
});

test('a successful install then quarantines, and the generic skill does not come back', (t) => {
  const f = skillsRootFixture(t);
  seedProvableLegacy(f, t);
  assert.equal(installer.main(['--skills-root', f.skills]), 0);
  assert.deepEqual(readdirSync(f.skills), ['mmx-workflow'], 'the provable legacy tree is gone and nothing replaced it');
  assert.equal(readFileSync(join(f.skills, 'mmx-workflow', 'SKILL.md'), 'utf8'), SKILL);
  assert.equal(installer.readSkillName(join(f.skills, 'mmx-workflow', 'SKILL.md')), 'mmx-workflow');
});

test('the CLI validates flags and refuses a non-existent skills root', (t) => {
  const f = skillsRootFixture(t);
  assert.throws(() => installer.parseInstallArgs(['--typo']), /unknown/i);
  assert.equal(installer.parseInstallArgs(['--force']).force, true);
  assert.throws(() => installer.parseInstallArgs(['--skills-root']), /needs a directory/);
  assert.equal(installer.main(['--help']), 0);
  assert.throws(() => installer.main(['--skills-root', join(f.root, 'no-such-root')]), /does not exist/);
  assert.deepEqual(readdirSync(f.skills), []);
});

test('the CLI keeps an unprovable legacy tree in place while installing the new skill', (t) => {
  const f = skillsRootFixture(t);
  const legacy = legacyTree(t);
  writeFileSync(join(legacy, 'SKILL.md'), readFileSync(join(legacy, 'SKILL.md'), 'utf8') + '\nlocal edit\n');
  renameSync(legacy, join(f.skills, 'dynamic-workflow'));
  assert.equal(installer.main(['--skills-root', f.skills]), 0);
  assert.deepEqual(readdirSync(f.skills).sort(), ['dynamic-workflow', 'mmx-workflow']);
  assert.equal(readFileSync(join(f.skills, 'mmx-workflow', 'SKILL.md'), 'utf8'), SKILL);
  assert.throws(() => installer.main(['--skills-root', f.skills]), /--force/, 'a second run must not silently replace it');
});

// --- D2: the dry-run plan must agree with what a real install would do --------------------------

// Capture everything a run of main() printed, without letting it write.
function captureMain(argv, overrides) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { const code = installer.main(argv, overrides); return { code, out: lines.join('\n') }; }
  finally { console.log = original; }
}
function fixtureEngine(root, contents) {
  const path = join(root, 'engine-fixture.mjs');
  if (contents !== null) writeFileSync(path, contents);
  return path;
}

test('D2a: with a matching engine the dry run says yes, and a real install then succeeds', (t) => {
  const f = skillsRootFixture(t);
  const engine = fixtureEngine(f.root, "export const ENGINE_VERSION = '0.8.1';\n");
  const before = fingerprint(f.home);
  const plan = captureMain(['--dry-run', '--skills-root', f.skills], { engine });
  assert.equal(plan.code, 0);
  assert.match(plan.out, /would install mmx-workflow .*: yes/);
  assert.equal(fingerprint(f.home), before, 'the dry run wrote nothing');
  const installed = installer.installSkill({ destination: f.destination, workRoot: f.work, engine });
  assert.equal(installed.engineVersion, '0.8.1');
  assert.equal(readFileSync(join(f.destination, 'SKILL.md'), 'utf8'), SKILL);
});

test('D2b: a missing engine makes the dry run say no, and the real install refuses the same way', (t) => {
  const f = skillsRootFixture(t);
  const engine = fixtureEngine(f.root, null);
  const before = fingerprint(f.home);
  const plan = captureMain(['--dry-run', '--skills-root', f.skills], { engine });
  assert.equal(plan.code, 0);
  assert.match(plan.out, /would install mmx-workflow .*: no — Workspace engine is missing/);
  assert.equal(fingerprint(f.home), before, 'the dry run wrote nothing');
  let thrown = null;
  try { installer.installSkill({ destination: f.destination, workRoot: f.work, engine }); }
  catch (error) { thrown = error; }
  assert.ok(thrown, 'the real install must refuse too');
  assert.equal(thrown.message, 'Workspace engine is missing: ' + engine, 'and refuse for exactly the reason the plan gave');
  assert.equal(fingerprint(f.home), before, 'and leave the fixture byte-identical');
});

test('D2c: a wrong engine version makes the dry run say no with the real version, and install refuses identically', (t) => {
  const f = skillsRootFixture(t);
  const engine = fixtureEngine(f.root, "export const ENGINE_VERSION = '99.0.0';\n");
  const before = fingerprint(f.home);
  const plan = captureMain(['--dry-run', '--skills-root', f.skills], { engine });
  assert.equal(plan.code, 0);
  assert.match(plan.out, /would install mmx-workflow .*: no — Unsupported engine 99\.0\.0; expected 0\.8\.1\./);
  assert.equal(fingerprint(f.home), before, 'the dry run wrote nothing');
  let thrown = null;
  try { installer.installSkill({ destination: f.destination, workRoot: f.work, engine }); }
  catch (error) { thrown = error; }
  assert.equal(thrown.message, 'Unsupported engine 99.0.0; expected 0.8.1.', 'the plan and the refusal are the same string');
  assert.equal(fingerprint(f.home), before);
  // The default CLI path is untouched: no override means the real workspace engine is used.
  const realPlan = captureMain(['--dry-run', '--skills-root', f.skills], {});
  assert.match(realPlan.out, /would install mmx-workflow .*: yes/);
});

// --- D3: pure checks run before any mkdir --------------------------------------------------------

test('D3a: a violating work root is refused even when the destination parent does not exist yet', (t) => {
  const f = skillsRootFixture(t);
  // A skills root whose mmx-workflow parent is about to be created from nothing.
  const freshRoot = join(f.root, 'fresh', 'skills');
  mkdirSync(dirname(freshRoot), { recursive: true });
  mkdirSync(freshRoot);
  const destination = join(freshRoot, 'mmx-workflow');
  const before = fingerprint(f.root);
  assert.throws(() => installer.installSkill({
    destination,
    workRoot: join(freshRoot, 'inside-work'), // a work root inside the scanned tree
  }), /outside the scanned skills tree/);
  assert.equal(fingerprint(f.root), before, 'the refused install created nothing at all');
  assert.equal(existsSync(destination), false, 'not even the destination parent');
});

test('D3b: a refusal decided before the first mkdir leaves a missing destination parent uncreated', (t) => {
  const f = skillsRootFixture(t);
  const freshRoot = join(f.root, 'fresh2', 'skills');
  mkdirSync(dirname(freshRoot), { recursive: true });
  assert.equal(existsSync(freshRoot), false, 'the parent really does not exist yet');
  // Set the decoy inputs up first, so the fingerprint covers everything except what the refusals
  // could possibly create.
  const badEngine = join(f.root, 'absent-engine.mjs');
  const wrongEngine = join(f.root, 'wrong-engine.mjs');
  writeFileSync(wrongEngine, "export const ENGINE_VERSION = '99.0.0';");
  const stranger = join(f.root, 'stranger-skill');
  mkdirSync(stranger);
  writeFileSync(join(stranger, 'SKILL.md'), '---\nname: not-ours\n---\nx\n');
  const before = fingerprint(f.root);
  // Each of these is a pure read or a lexical test, so each must refuse with the parent still absent.
  const attempts = [
    [/missing/i, { engine: badEngine }],
    [/unsupported/i, { engine: wrongEngine }],
    [/unrecognized|unrelated/i, { source: stranger }],
  ];
  for (const [pattern, extra] of attempts) {
    assert.throws(() => installer.installSkill({ destination: join(freshRoot, 'mmx-workflow'), workRoot: f.work, ...extra }), pattern);
    assert.equal(existsSync(freshRoot), false, 'a pre-mkdir refusal must not create the destination parent: ' + pattern);
    assert.equal(fingerprint(f.root), before, 'and must not change the fixture at all: ' + pattern);
  }
});

test('D3c: a legitimate new destination parent is still created and the install lands', (t) => {
  const f = skillsRootFixture(t);
  const freshRoot = join(f.root, 'fresh3', 'skills');
  assert.equal(existsSync(freshRoot), false, 'the parent really does not exist yet');
  const destination = join(freshRoot, 'mmx-workflow');
  const result = installer.installSkill({ destination, workRoot: installer.workRootFor(freshRoot) });
  assert.equal(result.destination, destination);
  assert.equal(readFileSync(join(destination, 'SKILL.md'), 'utf8'), SKILL);
  assert.ok(result.workRoot.startsWith(join(f.root, 'fresh3')), 'the work root is the fresh skills root\'s sibling');
  assert.ok(!result.workRoot.startsWith(freshRoot), 'and never inside the scanned tree');
});

test('D3d: the same-volume and link-hop safety checks still run after the parent is created', (t) => {
  const f = skillsRootFixture(t);
  const elsewhere = mkdtempSync(join(tmpdir(), 'mmx-wf-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const linked = join(elsewhere, 'linked-work');
  symlinkSync(f.skills, linked, 'junction');
  // What this case is really about: a work root that is only detectable AFTER the first mkdir. The
  // install is therefore allowed to have created the work root itself — that is the honest scope of
  // the guarantee. What it must never do is touch the scanned tree, activate a skill, or write
  // through the junction into the fixture. So the assertions are about the scanned tree and the
  // source, not about a whole-fixture byte comparison that would have to be faked.
  const scannedBefore = fingerprint(f.skills);
  const sourceBefore = readFileSync(SKILL_MD, 'utf8');
  assert.throws(() => installer.installSkill({ destination: f.destination, workRoot: linked }), /symbolic link|resolve to itself/i);
  assert.equal(existsSync(f.destination), false, 'no skill was installed');
  assert.equal(fingerprint(f.skills), scannedBefore, 'the scanned skills tree is byte-identical: nothing activated, no stage and no lock inside it');
  assert.deepEqual(readdirSync(f.skills), [], 'the scanned tree is still empty');
  assert.equal(readdirSync(f.skills).filter((n) => n.includes('.stage-')).length, 0, 'no staging tree inside the scanned tree');
  assert.equal(existsSync(join(f.skills, 'mmx-workflow.install.lock')), false, 'no lock file inside the scanned tree');
  assert.deepEqual(readdirSync(elsewhere), ['linked-work'], 'the junction was refused, not written through');
  assert.equal(readFileSync(SKILL_MD, 'utf8'), sourceBefore, 'the source skill was not modified');
});

// --- deterministic read-sequence tests for the park reader --------------------------------------
// These never touch the engine. They drive settleDocument with an explicit read sequence so the
// retry contract is proven without waiting for a race to happen by luck.

const GOOD_INDEX = JSON.stringify({ runId: 'parkrun', outstanding: 1, items: [{ callId: 'c000-0123abcd', seq: 2, phase: 'P', label: 'l', prompt: 'p' }] });
// A fixed sequence, replayed as a function: missing -> zero bytes -> half-written -> valid.
function sequence(values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

test('the park reader recovers from missing, zero-byte and half-written reads', async () => {
  // The injected read records what it was handed, so the retry contract is proved by the recorded
  // read sequence itself — four reads, in order, none skipped and none extra. A bare `attempts`
  // number would not show WHICH read came fourth.
  const reads = [];
  const next = sequence([null, '', GOOD_INDEX.slice(0, 12), GOOD_INDEX]);
  const result = await settleDocument(() => { const raw = next(); reads.push(raw); return raw; }, { validate: indexReady, attempts: 10, sleepMs: 0 });
  assert.equal(result.ok, true, 'a valid document must eventually be accepted');
  assert.equal(result.value.runId, 'parkrun');
  assert.equal(result.value.items[0].callId, 'c000-0123abcd');
  assert.equal(result.attempts, 4, 'it must have retried past all three bad reads');
  assert.deepEqual(reads, [null, '', GOOD_INDEX.slice(0, 12), GOOD_INDEX],
    'exactly four reads — missing, 0 bytes, half-written, then valid — in that order, with no extra read');
});

test('the park reader never treats a zero-byte or half-written file as a valid document', async () => {
  for (const bad of [null, '', '   ', GOOD_INDEX.slice(0, 30)]) {
    const result = await settleDocument(sequence([bad]), { validate: indexReady, attempts: 3, sleepMs: 0 });
    assert.equal(result.ok, false, 'must not accept ' + JSON.stringify(bad));
    assert.ok(result.lastError instanceof Error);
  }
});

test('the park reader times out on a permanently invalid document and keeps the last concrete reason', async () => {
  const result = await settleDocument(sequence(['{"runId":']), { validate: indexReady, attempts: 4, sleepMs: 0 });
  assert.equal(result.ok, false, 'a permanently broken file must not be retried into green');
  assert.equal(result.attempts, 4);
  assert.match(result.lastError.message, /partial JSON/, 'the timeout reports why, not a bare give-up: ' + result.lastError.message);

  const emptyItems = await settleDocument(sequence([JSON.stringify({ runId: 'r', outstanding: 0, items: [] })]), { validate: indexReady, attempts: 2, sleepMs: 0 });
  assert.equal(emptyItems.ok, false);
  assert.match(emptyItems.lastError.message, /items is still empty/);

  const noRunId = await settleDocument(sequence([JSON.stringify({ items: [{ callId: 'c000-0123abcd' }] })]), { validate: indexReady, attempts: 2, sleepMs: 0 });
  assert.equal(noRunId.ok, false);
  assert.match(noRunId.lastError.message, /no runId/);

  const missing = await settleDocument(sequence([null]), { validate: indexReady, attempts: 2, sleepMs: 0 });
  assert.equal(missing.ok, false);
  assert.match(missing.lastError.message, /missing/);

  // A document that PARSES is still not a ready document. The four falsy JSON values are the case
  // a truthiness check on the parse result silently drops: each must be named for what it is, never
  // accepted and never reported as "never read".
  for (const [literal, seen] of [['0', '0'], ['false', 'false'], ['null', 'null'], ['""', '""']]) {
    for (const [shapeName, shape] of [['indexReady', indexReady], ['perCallReady', perCallReady]]) {
      const falsy = await settleDocument(sequence([literal]), { validate: shape, attempts: 2, sleepMs: 0 });
      assert.equal(falsy.ok, false, literal + ' must not be accepted by ' + shapeName);
      assert.equal(falsy.value, null, literal + ' must yield no value under ' + shapeName);
      assert.match(falsy.lastError.message, /is not a JSON object but/, literal + ' under ' + shapeName + ' must give a shape reason: ' + falsy.lastError.message);
      assert.ok(falsy.lastError.message.includes(seen), literal + ' under ' + shapeName + ' must name the value it saw: ' + falsy.lastError.message);
      assert.doesNotMatch(falsy.lastError.message, /never read/, literal + ' under ' + shapeName + ' was read fine, so "never read" would be a lie');
    }
  }
});

test('a document that parses but is rejected by isReady keeps being retried, then reports why', async () => {
  let seen = 0;
  const result = await settleDocument(sequence([GOOD_INDEX]), {
    attempts: 3, sleepMs: 0, validate: () => (++seen >= 3 ? null : 'run not visible yet'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3, 'it must not settle on the first parseable-but-not-ready document');
});

test('a missing or not-ready index produces no value: readiness comes from the index alone', async () => {
  // Scope, stated honestly: this drives the in-memory read sequence only. It proves the reader
  // yields nothing when the index is absent, and (with the case above) when it is present but not
  // ready. It does NOT stand up a real stray per-call file on disk and watch the reader ignore it —
  // that on-disk property was proven once by a throwaway real-directory probe during review and is
  // not reproduced as a test here. The real parked-engine cases below do cover the ordinary path,
  // where index and per-call file both exist.
  const stray = JSON.stringify({ callId: 'c000-0123abcd', seq: 2, key: 'k', phase: 'P', label: 'l', prompt: 'p', requestedAt: 'now', model: null, agent: null, systemPrompt: null, cwd: null });
  const result = await settleDocument(sequence([null]), { validate: indexReady, attempts: 3, sleepMs: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.value, null, 'no value is produced from a missing index');
  // The stray document is complete and valid on its own, which is exactly why the reader is keyed
  // to the index: a per-call file must never be enough to dispatch from.
  assert.equal(JSON.parse(stray).callId, 'c000-0123abcd');
  assert.equal(perCallReady(JSON.parse(stray)), null, 'the stray alone WOULD pass the per-call shape rule, and is still not an index');
});

test('the engine writes the per-call file before the index, so index-first cannot miss a call', (t) => {
  // Structural, not timing: wf.mjs awaits the per-call write before flushing the index, so once the
  // index names a call, that call's file has already been fully written. This is the ordering the
  // index-first reader relies on, asserted against the engine source rather than a race.
  const source = readFileSync(ENGINE, 'utf8');
  const writeIndex = source.indexOf('await fsp.writeFile(pendingFile,');
  const flushIndex = source.indexOf('await flushPendingIndex(runDir);', writeIndex);
  assert.ok(writeIndex > 0 && flushIndex > writeIndex, 'the per-call write must precede the index flush in the engine');
  assert.match(source.slice(writeIndex, writeIndex + 60), /^await fsp\.writeFile\(pendingFile,/, 'and the per-call write is awaited, not fired and forgotten');
});

// --- 4. the file bridge, against a REAL parked engine call --------------------------------------
//
// Everything below reads files the workspace engine itself produced. The script calls agent() with
// every `wants` field set, the engine parks it, and the test reads the real pending.json index and
// the real pending/<callId>.json. No state, journal or progress file is hand-written, no real model
// task is dispatched (the child is never invoked; the park is simply observed and the process
// killed), and the engine is never modified.


// The checks the skill tells the host to perform, written out once so the test and the prose are
// the same procedure rather than two independent claims.
function validateBridge(index, perCall, expectedRunId, fileName) {
  if (index.runId !== expectedRunId) return 'index.runId ' + index.runId + ' is not ' + expectedRunId;
  const item = index.items.find((i) => i.callId === fileName.replace(/\.json$/, ''));
  if (!item) return 'index has no item for ' + fileName;
  if (!CALL_ID_RE.test(item.callId)) return 'callId ' + item.callId + ' fails the pattern';
  if (/[/\\.:]|\.\./.test(item.callId)) return 'callId ' + item.callId + ' is not a safe filename';
  if (perCall.callId !== item.callId) return 'per-call callId ' + perCall.callId + ' != index ' + item.callId;
  if (perCall.callId !== fileName.replace(/\.json$/, '')) return 'per-call callId does not match its own filename';
  if (perCall.prompt !== item.prompt) return 'per-call prompt differs from the index prompt';
  return null;
}

// Runs a script that parks one agent() call, waits for the real per-call file, and hands back the
// real index + per-call documents. The engine child is killed once the files are captured.
// Real engine park: the readiness signal is a parseable, non-empty pending.json index; the per-call
// file is located from item.callId, never by listing pending/. See test/lib/engine-park.mjs.
async function parkRealCall(t, prefix) {
  const root = tempRoot(t, prefix);
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const script = writeScript(cwd, 'park', [
    "export const meta = { name: 'park', description: 'd', whenToUse: 'w' };",
    "phase('P');",
    "return await agent('real prompt for the parked call', { model: 'vendor/model-x', agent: 'verifier', systemPrompt: 'be terse', cwd: 'C:/somewhere' });",
  ].join('\n'));
  const runId = 'parkrun';
  const dir = join(cwd, '.qoder', 'workflow-runs', runId);
  const captured = await captureParkedCall({ engine: ENGINE, cwd, script, runId, dir, timeoutMs: 30000 });
  return { root, cwd, dir, runId, index: captured.index, perCall: captured.perCall, file: captured.perCallFile };
}

test('a real parked call has exactly the keys the skill documents, and no runId in the per-call file', async (t) => {
  const p = await parkRealCall(t, 'mmx-wf-bridge-');
  assert.deepEqual(Object.keys(p.perCall).sort(),
    ['agent', 'callId', 'cwd', 'key', 'label', 'model', 'phase', 'prompt', 'requestedAt', 'seq', 'systemPrompt'],
    'the per-call file the engine wrote must match the keys the skill enumerates');
  assert.equal('runId' in p.perCall, false, 'the engine writes no runId per call; the skill must not require one');
  assert.deepEqual(Object.keys(p.index).sort(), ['items', 'outstanding', 'runId'], 'runId exists at the index top level');
  assert.equal(p.index.runId, p.runId, 'and it is the run id the engine was told to use');
  assert.deepEqual(Object.keys(p.index.items[0]).sort(), ['callId', 'label', 'phase', 'prompt', 'seq'],
    'the index item carries no wants — they exist only in the per-call file');
  // The wants the script asked for came back through the per-call file, unhidden.
  assert.equal(p.perCall.model, 'vendor/model-x');
  assert.equal(p.perCall.agent, 'verifier');
  assert.equal(p.perCall.systemPrompt, 'be terse');
  assert.equal(p.perCall.cwd, 'C:/somewhere');
  assert.equal(p.perCall.prompt, p.index.items[0].prompt);
});

test('the real bridge passes the skill\'s own validation, and the run stays parked with no answer invented', async (t) => {
  const p = await parkRealCall(t, 'mmx-wf-bridge-ok-');
  const fileName = p.file.split(/[\\/]/).pop();
  assert.equal(validateBridge(p.index, p.perCall, p.runId, fileName), null, 'an untouched real pair must validate clean');
  assert.deepEqual(readdirSync(join(p.dir, 'inbox')), [], 'nobody answered the parked call');
  assert.equal(existsSync(join(p.dir, 'out.json')), false, 'the run has not settled');
  // No hand-forged engine state: the files came from the engine, so their journal must exist.
  assert.equal(existsSync(join(p.dir, 'journal.jsonl')), true);
  assert.equal(existsSync(join(p.dir, 'state.json')), true);
});

test('an index whose runId is not the run we started is rejected', async (t) => {
  const p = await parkRealCall(t, 'mmx-wf-bridge-runid-');
  const fileName = p.file.split(/[\\/]/).pop();
  assert.equal(validateBridge(p.index, p.perCall, p.runId, fileName), null, 'the real pair is the baseline');
  // In-memory mutation of a real document: nothing is written back to disk.
  const wrongRunId = { ...p.index, runId: 'someone-elses-run' };
  assert.match(validateBridge(wrongRunId, p.perCall, p.runId, fileName), /index\.runId/);
  // The same run id must survive an unrelated mutation, so the rejection is specific.
  assert.equal(validateBridge({ ...p.index, outstanding: 99 }, p.perCall, p.runId, fileName), null);
  assert.equal(p.index.runId, p.runId, 'the real document on disk was never touched');
});

test('a per-call file whose callId or prompt disagrees with the index is rejected', async (t) => {
  const p = await parkRealCall(t, 'mmx-wf-bridge-mismatch-');
  const fileName = p.file.split(/[\\/]/).pop();
  const realCallId = p.perCall.callId;
  const wrongCallId = { ...p.perCall, callId: 'c999-deadbeef' };
  assert.match(validateBridge(p.index, wrongCallId, p.runId, fileName), /per-call callId .* != index/);
  const wrongPrompt = { ...p.perCall, prompt: 'a prompt the index never listed' };
  assert.match(validateBridge(p.index, wrongPrompt, p.runId, fileName), /prompt differs/);
  // A per-call body that disagrees with its own filename is also a mismatched pair.
  assert.match(validateBridge(p.index, p.perCall, p.runId, 'c001-01234567.json'), /no item for/);
  assert.equal(validateBridge(p.index, p.perCall, p.runId, fileName), null, 'the real pair is still the baseline');
  assert.equal(p.perCall.callId, realCallId, 'and the real per-call file on disk was never touched');
});

test('a callId that would escape the pending directory is refused by the bridge check', () => {
  const index = { runId: 'r', outstanding: 1, items: [{ callId: '../../etc/passwd', prompt: 'p' }] };
  const perCall = { callId: '../../etc/passwd', prompt: 'p' };
  assert.match(validateBridge(index, perCall, 'r', '../../etc/passwd.json'), /fails the pattern|not a safe filename/);
  const windowsish = { runId: 'r', outstanding: 1, items: [{ callId: 'c000-0123abcd', prompt: 'p' }] };
  assert.match(validateBridge(windowsish, { callId: 'c000-0123abcd', prompt: 'p' }, 'r', 'C:evil.json'), /no item for/);
  // The pattern itself: three-or-more digits, exactly eight lowercase hex.
  assert.ok(CALL_ID_RE.test('c001-0123abcd'));
  assert.ok(CALL_ID_RE.test('c1234-0123abcd'));
  assert.ok(CALL_ID_RE.test('q000-0123abcd'));
  assert.equal(CALL_ID_RE.test('c000-0123ABCD'), false, 'uppercase hex is not what the engine writes');
  assert.equal(CALL_ID_RE.test('c000-0123abcde'), false, 'a nine-hex tail is not a call id');
  assert.equal(CALL_ID_RE.test('c000-0123abc'), false, 'a seven-hex tail is not a call id');
  assert.equal(CALL_ID_RE.test('x000-0123abcd'), false, 'the prefix is c or q only');
});

// --- 3. the workspace engine, driven in isolation -----------------------------------------------

test('--backend file --yes starts a run with no confirmation left outstanding', (t) => {
  const root = tempRoot(t, 'mmx-wf-engine-');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const script = writeScript(cwd, 'return-only', [
    "export const meta = { name: 'return-only', description: 'd', whenToUse: 'w' };",
    "phase('Only');",
    'return { ok: true };',
  ].join('\n'));
  const result = runEngine(cwd, ['run', script, '--backend', 'file', '--yes', '--run-id', 'slice1']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = parse(result);
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.confirmation, { required: false, basis: 'flag' }, 'the authorized start must be recorded as such');
  assert.equal(out.agentDispatched, 0);
  assert.deepEqual(out.result, { ok: true });
  const dir = join(cwd, '.qoder', 'workflow-runs', 'slice1');
  assert.equal(existsSync(join(dir, 'out.json')), true, 'the run must really have produced out.json');
  assert.deepEqual(readdirSync(join(dir, 'inbox')), [], 'a return-only run dispatches nothing, so no answer is ever invented');
});

test('without --yes the engine still records that confirmation was owed', (t) => {
  const root = tempRoot(t, 'mmx-wf-gate-');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const script = writeScript(cwd, 'gated', [
    "export const meta = { name: 'gated', description: 'd', whenToUse: 'w' };",
    'return 1;',
  ].join('\n'));
  const result = runEngine(cwd, ['run', script, '--backend', 'file', '--run-id', 'slice2']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = parse(result);
  assert.equal(out.confirmation.required, true);
  assert.equal(out.confirmation.basis, 'first-run');
});

test('the hash trust record still exists after a --yes run, and editing a saved script still revokes it', (t) => {
  const root = tempRoot(t, 'mmx-wf-trust-');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const script = writeScript(cwd, 'trustable', [
    "export const meta = { name: 'trustable', description: 'd', whenToUse: 'w' };",
    'return 1;',
  ].join('\n'));
  assert.equal(runEngine(cwd, ['save', script, '--name', 'trustable', '--scope', 'project']).status, 0);
  const trusted = parse(runEngine(cwd, ['run', '--saved', 'trustable', '--backend', 'file', '--yes', '--run-id', 'slice3']));
  assert.deepEqual(trusted.confirmation, { required: false, basis: 'flag' });
  assert.equal(existsSync(join(cwd, '.qoder', 'dynamic-workflow-trust.json')), false, '--yes must not silently write a permanent trust record');

  assert.equal(runEngine(cwd, ['trust', 'trustable', '--scope', 'project']).status, 0);
  const trustFile = readJson(join(cwd, '.qoder', 'dynamic-workflow-trust.json'));
  assert.equal(trustFile.workflows.trustable.scope, 'project');
  assert.match(trustFile.workflows.trustable.sha256, /^[0-9a-f]{64}$/);
  const onList = parse(runEngine(cwd, ['run', '--saved', 'trustable', '--backend', 'file', '--run-id', 'slice4']));
  assert.equal(onList.confirmation.required, false);
  assert.equal(onList.confirmation.basis, 'trust-list');

  writeFileSync(join(cwd, '.qoder', 'dynamic-workflows', 'trustable.js'), readFileSync(join(cwd, '.qoder', 'dynamic-workflows', 'trustable.js'), 'utf8') + '\n// edited\n');
  const edited = parse(runEngine(cwd, ['run', '--saved', 'trustable', '--backend', 'file', '--yes', '--run-id', 'slice5']));
  assert.equal(edited.confirmation.basis, 'flag', 'an explicit --yes still answers this run once');
  const editedUnasked = parse(runEngine(cwd, ['run', '--saved', 'trustable', '--backend', 'file', '--run-id', 'slice6']));
  assert.equal(editedUnasked.confirmation.basis, 'script-changed', 'editing a trusted script must revoke the trust');
  assert.notEqual(editedUnasked.confirmation.trustedFrom, editedUnasked.confirmation.nowFrom);
});

test('a business ask() is parked for the user and never answered on their behalf', (t) => {
  const root = tempRoot(t, 'mmx-wf-ask-');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const script = writeScript(cwd, 'asker', [
    "export const meta = { name: 'asker', description: 'd', whenToUse: 'w' };",
    "const answer = await ask('是否继续？', { timeoutMs: 4000 });",
    'return { answer };',
  ].join('\n'));
  const result = runEngine(cwd, ['run', script, '--backend', 'file', '--yes', '--run-id', 'slice7'], { WF_PARK_TIMEOUT_MS: '4000' });
  const out = parse(result);
  assert.equal(out.status, 'failed', 'an unanswered business question must fail the run, not be auto-answered');
  assert.match(out.error, /q000-[0-9a-f]{8}/, 'the error must name the parked question id');
  assert.match(out.error, /no answer in inbox/, 'the failure must say the host stopped driving the handshake');
  const dir = join(cwd, '.qoder', 'workflow-runs', 'slice7');
  const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const dispatched = journal.find((event) => event.type === 'ask_dispatch');
  assert.ok(dispatched, 'the question must have been dispatched to the host');
  assert.equal(dispatched.question, '是否继续？');
  // A failed park does record an ask_result, but with ok:false and no answer: the point is that no
  // successful answer was ever produced on the user's behalf.
  const answered = journal.filter((event) => event.type === 'ask_result' && event.ok !== false);
  assert.deepEqual(answered, [], 'no answer may be recorded for a question the user never answered');
  assert.equal(journal.some((event) => event.type === 'ask_replay'), false, 'nothing may be replayed as if answered');
  assert.deepEqual(readdirSync(join(dir, 'inbox')), [], 'the run must not have written an answer file for the user');
});

test('a question parked by ask() is distinguishable from a subagent item, and the marker is in pending.json', (t) => {
  const root = tempRoot(t, 'mmx-wf-pending-');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const script = writeScript(cwd, 'asker2', [
    "export const meta = { name: 'asker2', description: 'd', whenToUse: 'w' };",
    "phase('Ask');",
    "return await ask('需要用户拍板的问题', { timeoutMs: 3000 });",
  ].join('\n'));
  // Poll pending.json while the run is still parked: this is exactly the file the host reads, and
  // the `kind` marker is what tells a business question apart from a subagent task.
  const child = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const { readFileSync, existsSync } = require('node:fs');
    const run = spawn(process.execPath, [${JSON.stringify(ENGINE)}, 'run', ${JSON.stringify(script)}, '--backend', 'file', '--yes', '--run-id', 'slice8'], { stdio: 'ignore' });
    const pending = ${JSON.stringify(join(cwd, '.qoder', 'workflow-runs', 'slice8', 'pending.json'))};
    const deadline = Date.now() + 20000;
    let seen = null;
    while (Date.now() < deadline) {
      if (existsSync(pending)) {
        try {
          const items = JSON.parse(readFileSync(pending, 'utf8')).items;
          if (items.length) { seen = items; break; }
        } catch {}
      }
    }
    run.kill();
    process.stdout.write(JSON.stringify(seen));
  `], { cwd, encoding: 'utf8', timeout: 40000, env: { ...process.env, WF_PARK_TIMEOUT_MS: '30000' } });
  const items = JSON.parse(child.stdout);
  assert.ok(Array.isArray(items) && items.length === 1, 'exactly one question must be outstanding: ' + child.stdout + child.stderr);
  assert.equal(items[0].kind, 'question', 'a business question must carry the kind marker the skill keys on');
  assert.equal(items[0].callId, items[0].qid ?? items[0].callId);
  assert.match(items[0].callId, /^q[0-9]{3}-[0-9a-f]{8}$/, 'a question id must be distinguishable from a c-prefixed call id');
  assert.equal(items[0].prompt, '需要用户拍板的问题');
  assert.equal(existsSync(join(cwd, '.qoder', 'workflow-runs', 'slice8', 'inbox', items[0].callId + '.json')), false,
    'nobody may have answered the question on the user\'s behalf');
});

test('guards still refuse: sandbox escape, unknown flag and a malformed origin are all rejected', (t) => {
  const root = tempRoot(t, 'mmx-wf-guards-');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const escape = writeScript(cwd, 'escape', [
    "export const meta = { name: 'escape', description: 'd', whenToUse: 'w' };",
    "return { fs: require('fs') };",
  ].join('\n'));
  const checked = runEngine(cwd, ['check', escape]);
  assert.equal(checked.status, 2);
  const diagnostics = parse(checked).diagnostics;
  assert.ok(diagnostics.some((d) => d.code === 'forbidden_module'), 'the sandbox must still refuse require()');

  const runnable = writeScript(cwd, 'ok', [
    "export const meta = { name: 'ok', description: 'd', whenToUse: 'w' };",
    'return 1;',
  ].join('\n'));
  const unknown = runEngine(cwd, ['run', runnable, '--backend', 'file', '--yes', '--nope', '1']);
  assert.equal(unknown.status, 2);
  assert.match(parse(unknown).errors[0], /unknown --nope/);

  const origin = runEngine(cwd, ['run', runnable, '--backend', 'file', '--yes', '--host-session', 'not-base64-json', '--run-id', 'guard1']);
  assert.equal(origin.status, 2);
  assert.match(parse(origin).error, /invalid --host-session/);
  assert.equal(existsSync(join(cwd, '.qoder', 'workflow-runs', 'guard1')), false, 'a refused origin must not leave a run directory behind');
});

test('a run id that could escape the run directory is refused', (t) => {
  const root = tempRoot(t, 'mmx-wf-runid-');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const script = writeScript(cwd, 'id', [
    "export const meta = { name: 'id', description: 'd', whenToUse: 'w' };",
    'return 1;',
  ].join('\n'));
  const escaped = runEngine(cwd, ['run', script, '--backend', 'file', '--yes', '--run-id', '..']);
  assert.match(escaped.stderr, /invalid --run-id/);
  assert.equal(existsSync(join(cwd, '.qoder', 'workflow-runs')), false, 'a refused run id must not create a run tree');
});
