import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import * as installer from '../install-skills.mjs';

// The installer ships the dedicated `mmx-workflow` skill: a directory only counts as replaceable
// when its SKILL.md frontmatter declares exactly that name (install-skills.mjs assertSkill /
// SKILL_NAME), and every transient (lock, stage, backup) lives in a work root derived from the
// skills root — a SIBLING of it, never inside the scanned tree. The fixture mirrors both rules.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-deploy-test-'));
  const source = join(root, 'source'), destination = join(root, 'installed');
  const workRoot = root + '-work';
  mkdirSync(join(source, 'runtime'), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), `---\nname: ${installer.SKILL_NAME}\n---\nengine`);
  writeFileSync(join(source, 'runtime/wf.mjs'), "export const ENGINE_VERSION = '0.8.1';\n");
  writeFileSync(join(source, 'data.txt'), 'new complete data');
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(workRoot, { recursive: true, force: true }); });
  return { root, source, destination, workRoot };
}
function oldInstall(f) {
  mkdirSync(join(f.destination, 'runtime'), { recursive: true });
  writeFileSync(join(f.destination, 'SKILL.md'), `---\nname: ${installer.SKILL_NAME}\n---\nold`);
  writeFileSync(join(f.destination, 'runtime/wf.mjs'), "export const ENGINE_VERSION = '0.7.1';\n");
  writeFileSync(join(f.destination, 'old.txt'), 'keep this old installation');
}

test('installer accepts current engine without changing the source', (t) => {
  const f = fixture(t);
  const result = installer.installSkill(f);
  assert.equal(result.engineVersion, '0.8.1');
  assert.equal(readFileSync(join(f.destination, 'data.txt'), 'utf8'), 'new complete data');
  assert.equal(readFileSync(join(f.source, 'data.txt'), 'utf8'), 'new complete data');
});
test('installer refuses replacement unless force is explicit', (t) => {
  const f = fixture(t); oldInstall(f);
  assert.throws(() => installer.installSkill(f), /--force/);
  assert.equal(readFileSync(join(f.destination, 'old.txt'), 'utf8'), 'keep this old installation');
});
test('installer retains a complete backup after verified replacement', (t) => {
  const f = fixture(t); oldInstall(f);
  const result = installer.installSkill({ ...f, force: true });
  assert.equal(readFileSync(join(result.backupPath, 'old.txt'), 'utf8'), 'keep this old installation');
  assert.equal(readFileSync(join(f.destination, 'data.txt'), 'utf8'), 'new complete data');
});
test('staging failure leaves the original installation untouched', (t) => {
  const f = fixture(t); oldInstall(f);
  assert.throws(() => installer.installSkill({ ...f, force: true, operations: { copy: () => { throw new Error('COPY_FAILED'); } } }), /COPY_FAILED/);
  assert.equal(readFileSync(join(f.destination, 'old.txt'), 'utf8'), 'keep this old installation');
});
test('activation failure rolls back the original installation', (t) => {
  const f = fixture(t); oldInstall(f);
  assert.throws(() => installer.installSkill({ ...f, force: true, operations: {
    rename: (from, to) => { if (from.includes('.stage-') && to === f.destination) throw new Error('ACTIVATION_FAILED'); renameSync(from, to); },
  } }), /ACTIVATION_FAILED/);
  assert.equal(readFileSync(join(f.destination, 'old.txt'), 'utf8'), 'keep this old installation');
  assert.equal(existsSync(join(f.destination, 'data.txt')), false);
});
test('installer refuses unrelated destination even with force', (t) => {
  const f = fixture(t); mkdirSync(f.destination); writeFileSync(join(f.destination, 'private.txt'), 'unrelated');
  assert.throws(() => installer.installSkill({ ...f, force: true }), /unrecognized|unrelated/i);
  assert.equal(readFileSync(join(f.destination, 'private.txt'), 'utf8'), 'unrelated');
});
test('installer rejects unsupported engine before creating destination', (t) => {
  const f = fixture(t);
  // The engine version is read from the configured engine (the workspace wf.mjs), not from the
  // skill tree, so the fixture's unsupported engine must be handed over as that engine.
  const engine = join(f.source, 'runtime/wf.mjs');
  writeFileSync(engine, "const ENGINE_VERSION = '99.0.0';");
  assert.throws(() => installer.installSkill({ ...f, engine }), /unsupported|expected/i);
  assert.equal(existsSync(f.destination), false);
  assert.deepEqual(readdirSync(f.root), ['source']);
  assert.equal(existsSync(f.workRoot), false);
});
test('installer CLI validates unknown flags instead of ignoring them', () => {
  assert.throws(() => installer.parseInstallArgs(['--typo']), /unknown/i);
  assert.equal(installer.parseInstallArgs(['--force']).force, true);
});
test('canonical destination preserves a basename immediately beneath a drive root', (t) => {
  const f = fixture(t);
  const destination = join(parse(f.root).root, 'workflow-installer-path-test');
  assert.equal(installer.canonicalDestinationPath(destination), resolve(destination));
});
test('an existing installation lock is reported and never removed or overwritten', (t) => {
  const f = fixture(t); oldInstall(f);
  // The lock lives in the work root (outside the scanned skills tree), named after the skill.
  mkdirSync(f.workRoot);
  const lockPath = join(f.workRoot, installer.SKILL_NAME + '.install.lock');
  const content = JSON.stringify({ pid: 424242, startedAt: '2001-02-03T04:05:06.000Z', exe: 'test-owner.exe' });
  writeFileSync(lockPath, content);
  assert.throws(() => installer.installSkill({ ...f, force: true }), (error) => {
    assert.equal(error.code, 'INSTALL_LOCKED');
    assert.ok(error.message.includes(lockPath));
    assert.match(error.message, /424242/);
    assert.match(error.message, /2001-02-03T04:05:06.000Z/);
    return true;
  });
  assert.equal(readFileSync(lockPath, 'utf8'), content);
  assert.equal(readFileSync(join(f.destination, 'old.txt'), 'utf8'), 'keep this old installation');
  assert.equal(readdirSync(f.root).some((name) => name.includes('.stage-')), false);
});
test('installation lock records its owner and excludes a concurrent installer process', (t) => {
  const f = fixture(t);
  const lockPath = join(f.workRoot, installer.SKILL_NAME + '.install.lock');
  let heldLock;
  installer.installSkill({ ...f, operations: { copy: (source, stage, options) => {
    heldLock = readFileSync(lockPath, 'utf8');
    const owner = JSON.parse(heldLock);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.exe, process.execPath);
    assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
    const entry = new URL('../install-skills.mjs', import.meta.url).href;
    // A concurrent installer only collides when it derives the SAME work root, which the real CLI
    // always does (workRootFor(skillsRoot)); the competitor is given the same one.
    const script = `import { installSkill } from ${JSON.stringify(entry)};
      try { installSkill({ source: process.argv[1], destination: process.argv[2], workRoot: process.argv[3] }); process.exitCode = 2; }
      catch (error) { console.log(error.code); process.exitCode = error.code === 'INSTALL_LOCKED' ? 0 : 3; }`;
    const competing = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.source, f.destination, f.workRoot], { encoding: 'utf8', timeout: 15000 });
    assert.equal(competing.status, 0, competing.stdout + competing.stderr);
    assert.match(competing.stdout, /INSTALL_LOCKED/);
    assert.equal(readFileSync(lockPath, 'utf8'), heldLock);
    assert.equal(existsSync(f.destination), false);
    cpSync(source, stage, options);
  } } });
  assert.equal(existsSync(lockPath), false);
  assert.equal(readFileSync(join(f.destination, 'data.txt'), 'utf8'), 'new complete data');
});
