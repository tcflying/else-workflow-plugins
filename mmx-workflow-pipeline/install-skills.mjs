#!/usr/bin/env node
// mmx-workflow-pipeline / install-skills.mjs
//
// Deploys exactly one skill — the workspace's own `mmx-workflow` Skill — into the MiniMax user
// skill tree. It deliberately does NOT install the generic Qoder-flavoured `dynamic-workflow` skill
// any more: that copy is byte-identical to the workspace source, is authored for a different host's
// tool names and confirmation gate, and its `name: dynamic-workflow` collides with the official
// marketplace skill of the same name (loader precedence unproven). The dedicated skill points at the
// workspace engine by absolute path instead of shipping a second engine copy.
//
// What this installer is allowed to do to a pre-existing deployment:
//   * move `dynamic-workflow` (and `dynamic-workflow.bak-*`) OUT of the skill tree, but only when a
//     sha256 manifest proves the tree is byte-identical to this project's own reference copy;
//   * anything it cannot prove stays exactly where it is and is reported as a conflict.
// Nothing is deleted, and no other skill is read, written or scanned.
//
// Ordering is a transaction, not a sequence of independent steps. The install is fully validated
// (engine version, source identity, lock, staged manifest) and completed BEFORE any legacy tree is
// moved, so a refused install — a wrong engine, a held lock, a missing --force — can never leave the
// generic `dynamic-workflow` skill gone. The quarantine step then runs with its own rollback: if a
// later candidate cannot be moved, the ones already moved are put back.
//
// Every transient this installer creates (lock file, staging tree, retained backup, failed-rename
// parking) lives in WORK_ROOT, which is outside the ~/.minimax/skills tree the host loader scans. A
// staging tree left behind by a hard kill used to sit next to the skill as `mmx-workflow.stage-*`
// carrying a `name: mmx-workflow` SKILL.md, i.e. a second skill with the same name in the scanned
// tree; that is exactly the collision this layout removes.
import { cpSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, realpathSync, mkdtempSync, openSync, closeSync, unlinkSync, statfsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, basename, resolve, relative, isAbsolute, sep, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// The dedicated MiniMax skill. Its only file is SKILL.md; it deliberately carries no engine copy.
export const SRC = join(HERE, 'skills', 'mmx-workflow');
// The workspace engine this skill drives, and the version it is written against.
const ENGINE = join(HERE, '..', 'plugins', 'dynamic-workflow', 'skills', 'dynamic-workflow', 'runtime', 'wf.mjs');
// Byte-identity reference for the legacy deployment this installer may quarantine.
const LEGACY_REFERENCE = join(HERE, '..', 'plugins', 'dynamic-workflow', 'skills', 'dynamic-workflow');
const HOME = 'C:/Users/datoo/.minimax';
export const DST = join(HOME, 'skills', 'mmx-workflow');
const LEGACY_NAME = 'dynamic-workflow';
// Retired trees are moved here, which is OUTSIDE ~/.minimax/skills so the host loader cannot scan
// them again, and is never pruned automatically.
const BACKUP_ROOT_NAME = 'mmx-workflow-skill-backups';
export function backupRootFor(skillsRoot) { return join(dirname(resolve(skillsRoot)), BACKUP_ROOT_NAME); }
export const BACKUP_ROOT = backupRootFor(join(HOME, 'skills'));
// Every transient (lock, staging, retained backup, failed-rename parking) also lives here, one level
// above the scanned tree. It is created on demand and only ever holds paths this installer created.
// The rule is "sibling of the skills root", derived from the skills root alone — so the real tree and
// a --skills-root fixture get the identical rule, and the work root is never inside the scanned tree.
const WORK_ROOT_NAME = 'mmx-workflow-skill-work';
export function workRootFor(skillsRoot) { return join(dirname(resolve(skillsRoot)), WORK_ROOT_NAME); }
export const WORK_ROOT = workRootFor(join(HOME, 'skills'));
const EXPECTED_ENGINE = '0.8.1';
const SKILL_NAME = 'mmx-workflow';

export function readEngineVersion(wfPath) {
  const match = readFileSync(wfPath, 'utf8').match(/ENGINE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}
export function readSkillName(skillPath) {
  const match = readFileSync(skillPath, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const name = match[1].match(/^name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m);
  return name ? name[1] : null;
}
function manifest(directory) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not accepted in a skill installation: ' + path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: relative(directory, path).split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
      else throw new Error('Unsupported installation entry: ' + path);
    }
  };
  walk(directory);
  return files;
}
export function manifestsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
// Ownership: a directory only counts as this skill when its SKILL.md frontmatter declares exactly
// the name it is supposed to be. Anything else — a missing file, a name mismatch, a symlink — is
// reported and left alone, including under --force.
function assertSkill(directory, expectedName) {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Unrecognized installation directory: ' + directory);
  const skill = join(directory, 'SKILL.md');
  if (!existsSync(skill)) throw new Error('Unrecognized or unrelated skill at ' + directory + '; it will not be replaced.');
  if (readSkillName(skill) !== expectedName) throw new Error('Unrecognized or unrelated skill at ' + directory + '; it will not be replaced.');
}
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)); };

export function canonicalDestinationPath(destination) {
  const dst = resolve(destination);
  return join(realpathSync(dirname(dst)), basename(dst));
}

// Containment is checked LEXICALLY, on the path as given, before anything is created — a work root
// inside the scanned tree must be refused without first creating it. The symlink and same-volume
// checks can only run once it exists, so they run after the mkdir.
function assertWorkRootOutsideTrees(workRoot, skillsRoot, destination) {
  const target = resolve(workRoot);
  if (within(skillsRoot, target)) throw new Error('Work root must sit outside the scanned skills tree and will not be created: ' + target);
  if (within(destination, target) || within(target, destination)) {
    throw new Error('Work root must sit outside the destination tree and will not be created: ' + target);
  }
  return target;
}

// A transient root is only usable when it is a real directory this installer owns: it must resolve
// to itself (no symlink, no junction hop) and it must sit OUTSIDE the whole scanned skills root, not
// merely outside the one destination directory — a staging tree dropped inside the scanned tree is
// exactly the second `name: mmx-workflow` this layout exists to prevent. Same-volume is then checked
// when the platform can report it, so an activation rename cannot fail with EXDEV on Windows.
function assertWorkRootUsable(workRoot, skillsRoot, destination) {
  if (lstatSync(workRoot).isSymbolicLink()) throw new Error('Work root is a symbolic link and will not be used: ' + workRoot);
  const realWork = realpathSync(workRoot);
  if (resolve(realWork) !== resolve(workRoot)) throw new Error('Work root does not resolve to itself (a link hop is in the path) and will not be used: ' + workRoot);
  if (within(skillsRoot, realWork)) throw new Error('Work root must sit outside the scanned skills tree: ' + realWork);
  if (within(destination, realWork) || within(realWork, destination)) {
    throw new Error('Work root must sit outside the destination tree: ' + realWork);
  }
  try {
    const work = statfsSync(realWork), dest = statfsSync(existsSync(destination) ? destination : dirname(destination));
    if (work.dev !== dest.dev) throw new Error('Work root and destination are on different volumes (' + work.dev + ' vs ' + dest.dev + '); staging would need a cross-device copy: ' + realWork);
  } catch (error) {
    if (error && error.message && /different volumes/.test(error.message)) throw error;
    // statfs is best-effort: an unsupported platform falls back to a verified copy move, which is
    // what moveVerified() falls back to anyway. A real EXDEV at activation time is handled there.
  }
  return realWork;
}

// Rename when the platform allows it, otherwise copy-then-verify-then-remove. The fallback exists
// for Windows EXDEV and for injected transports in tests; it never deletes a tree it could not
// first reproduce byte for byte.
function moveVerified(from, to, { rename, copy, remove, expected }) {
  try { rename(from, to); return 'rename'; }
  catch (error) {
    if (!error || (error.code !== 'EXDEV' && !/cross-device|not the same drive/i.test(String(error.message)))) throw error;
  }
  copy(from, to, { recursive: true, errorOnExist: true, force: false });
  if (expected && !manifestsEqual(manifest(to), expected)) {
    remove(to, { recursive: true, force: true });
    throw new Error('Cross-device move could not be reproduced byte for byte; nothing was removed: ' + from);
  }
  remove(from, { recursive: true, force: false });
  return 'copy';
}

function acquireInstallLock(lockPath) {
  try { return openSync(lockPath, 'wx'); }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    let owner = 'Owner metadata unavailable.';
    try {
      const stat = lstatSync(lockPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
        const value = JSON.parse(readFileSync(lockPath, 'utf8'));
        const pid = Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : 'unknown';
        const startedAt = typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) ? new Date(value.startedAt).toISOString() : 'unknown';
        owner = `Recorded owner PID ${pid}, created ${startedAt}.`;
      }
    } catch {}
    throw Object.assign(new Error(`Installation lock exists: ${lockPath}. ${owner} Verify the owner before any manual cleanup; the lock was not changed.`, { cause }), { code: 'INSTALL_LOCKED' });
  }
}

// The pre-MUTATION half of installSkill's checks, gathered here so the dry-run plan and the real
// install cannot drift apart: a plan can never say "would install" for an install that is about to
// be refused. Everything in here is a pure read or a purely lexical containment test, so it is valid
// before any directory exists and it never writes. It is NOT the whole precondition set: lock
// acquisition, the post-create realpath / same-volume checks, the staged-manifest comparison and the
// re-checks that guard against a destination appearing mid-flight all happen later in installSkill,
// after the first mkdir. It returns a reason string instead of throwing, so a caller that only wants
// to explain (the dry run) does not have to catch.
function preflight({ source, destination, workRoot, engine, expectedEngine, skillName, force }) {
  if (!existsSync(engine)) return { ok: false, reason: 'Workspace engine is missing: ' + engine };
  const engineVersion = readEngineVersion(engine);
  if (engineVersion !== expectedEngine) return { ok: false, reason: `Unsupported engine ${engineVersion}; expected ${expectedEngine}.` };
  try { assertSkill(source, skillName); }
  catch (error) { return { ok: false, reason: error.message }; }
  const src = realpathSync(resolve(source)), dst = resolve(destination);
  if (within(src, dst) || within(dst, src)) return { ok: false, reason: 'Source and destination must not overlap.' };
  if (existsSync(dst)) {
    try { assertSkill(dst, skillName); }
    catch (error) { return { ok: false, reason: error.message }; }
    if (!force) return { ok: false, reason: 'An installation already exists; inspect it and use --force to replace it with a retained backup.' };
  }
  // Lexical, so it is valid even when the destination parent does not exist yet. Must run before
  // ANY mkdir: a work root inside the scanned tree is refused without first creating the parent.
  try { assertWorkRootOutsideTrees(workRoot, dirname(dst), dst); }
  catch (error) { return { ok: false, reason: error.message }; }
  return { ok: true, reason: 'engine ' + engineVersion + ' verified, destination free' };
}

export function installSkill({ source = SRC, destination = DST, workRoot = WORK_ROOT, force = false, operations = {}, engine = ENGINE, expectedEngine = EXPECTED_ENGINE, skillName = SKILL_NAME } = {}) {
  const src = realpathSync(resolve(source)), dst = resolve(destination);
  // Scope of the guarantee, stated precisely. A refusal that happens before the first mkdir
  // (everything preflight covers) changes nothing on disk. A refusal BELOW that line can still leave
  // an empty destination parent or an empty work root behind, and if a rollback itself fails the
  // previous installation is left at its backup path with an AggregateError naming both errors —
  // it is never silently discarded, and nothing is deleted to tidy up. What no failure path does is
  // replace a skill with something unverified: activation is manifest-checked, and a failed
  // activation is rolled back or parked with its content intact.

  const ready = preflight({ source, destination, workRoot, engine, expectedEngine, skillName, force });
  if (!ready.ok) throw new Error(ready.reason);
  const expected = manifest(src);
  mkdirSync(dirname(dst), { recursive: true });
  const canonicalDestination = canonicalDestinationPath(dst);
  if (within(src, canonicalDestination) || within(canonicalDestination, src)) throw new Error('Source and destination must not overlap through a link.');
  // Transients live outside the scanned skills tree, so a hard kill can never leave a
  // `mmx-workflow.stage-*` directory carrying a `name: mmx-workflow` SKILL.md next to the real one.
  mkdirSync(workRoot, { recursive: true });
  const realWork = assertWorkRootUsable(workRoot, dirname(dst), dst);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const lockPath = join(realWork, SKILL_NAME + '.install.lock');
  const lock = acquireInstallLock(lockPath);
  const rename = operations.rename || renameSync;
  const copy = operations.copy || cpSync;
  const remove = operations.remove || rmSync;
  const mkdir = operations.mkdir || mkdirSync;
  let stage, backupPath = null, movedBackup = false, activated = false, parkPath = null;
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), exe: process.execPath }) + '\n');
    stage = mkdtempSync(join(realWork, SKILL_NAME + '.stage-'));
    copy(src, stage, { recursive: true, errorOnExist: true, force: false });
    assertSkill(stage, skillName);
    if (!manifestsEqual(manifest(stage), expected)) throw new Error('Staged installation verification failed; the current installation was not changed.');
    if (existsSync(dst)) {
      assertSkill(dst, skillName);
      if (!force) throw new Error('Destination appeared during staging; use --force only after inspecting it.');
      backupPath = join(realWork, SKILL_NAME + '.bak-' + stamp + '-' + randomUUID());
      moveVerified(dst, backupPath, { rename, copy, remove, expected: manifest(dst) });
      movedBackup = true;
    }
    moveVerified(stage, dst, { rename, copy, remove, expected });
    activated = true;
    if (!manifestsEqual(manifest(dst), expected)) throw new Error('Activated installation verification failed.');
    return { engineVersion: readEngineVersion(engine), destination: dst, backupPath, workRoot: realWork, files: expected };
  } catch (error) {
    if (movedBackup) {
      try {
        if (activated && existsSync(dst)) { parkPath = join(realWork, SKILL_NAME + '.failed-' + randomUUID()); moveVerified(dst, parkPath, { rename, copy, remove }); }
        if (existsSync(dst)) throw new Error('Destination exists unexpectedly; no files were overwritten.');
        moveVerified(backupPath, dst, { rename, copy, remove, expected: manifest(backupPath) });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Install failed; rollback could not finish. The original installation is retained at ${backupPath}.`);
      }
    } else if (activated && existsSync(dst)) {
      moveVerified(dst, join(realWork, SKILL_NAME + '.failed-' + randomUUID()), { rename, copy, remove });
    }
    throw error;
  } finally {
    if (stage && existsSync(stage)) remove(stage, { recursive: true, force: false });
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

// --- legacy deployment quarantine -------------------------------------------------------------
// Only two directory names are ever considered, both of which this project's own installer created.
// Everything else under the skill tree is never enumerated, read or touched. A candidate is moved
// only when its full sha256 manifest equals this project's reference copy; an unprovable candidate
// is left untouched and reported.
//
// dryRun performs the whole proof and computes every target path, but performs no mkdir, no rename
// and no write of any kind. The caller gets the same would-move/would-conflict answer it would get
// from a real run, which is the only way a "report only" mode can be trusted.
//
// The move is a transaction: if a later candidate fails mid-way, every candidate already moved in
// this same call is put back where it was, and the error is rethrown with both errors attached.

export function legacyCandidates(skillsRoot) {
  return [LEGACY_NAME, ...readdirSync(skillsRoot)
    .filter((name) => name.startsWith(LEGACY_NAME + '.bak-'))
    .sort()]
    .map((name) => join(skillsRoot, name))
    .filter((path) => { try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); } catch { return false; } });
}

export function quarantineLegacyDeployments({ skillsRoot = dirname(DST), reference = LEGACY_REFERENCE, backupRoot, now = new Date(), dryRun = false, rename = renameSync, mkdir = mkdirSync } = {}) {
  // Derived from the skills root, never from a global: a --skills-root run must not be able to move
  // a tree into the real ~/.minimax tree, and must report the path it would really use.
  const targetRoot = backupRoot || backupRootFor(skillsRoot);
  if (!existsSync(reference)) throw new Error('Reference copy is missing; nothing was moved: ' + reference);
  const expected = manifest(reference);
  const moved = [], conflicts = [];
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let backupRootReady = false;
  try {
    for (const [index, candidate] of legacyCandidates(skillsRoot).entries()) {
      const name = basename(candidate);
      let actual;
      try { actual = manifest(candidate); }
      catch (error) { conflicts.push({ path: candidate, reason: 'unreadable: ' + error.message }); continue; }
      if (!manifestsEqual(actual, expected)) {
        conflicts.push({ path: candidate, reason: 'sha256 manifest differs from this project\'s reference copy; left in place' });
        continue;
      }
      // Target names are derived from the caller's own id space, never from directory contents.
      const target = join(targetRoot, name + '.' + stamp + '-' + index + '-' + randomUUID());
      if (dryRun) { moved.push({ from: candidate, to: target, applied: false }); continue; }
      if (!backupRootReady) { mkdir(targetRoot, { recursive: true }); backupRootReady = true; }
      rename(candidate, target);
      moved.push({ from: candidate, to: target, applied: true });
    }
  } catch (error) {
    if (!dryRun) {
      for (const entry of moved) {
        try { rename(entry.to, entry.from); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError],
            `Quarantine failed and rollback could not restore ${entry.to}; that tree is retained there. Nothing was deleted.`);
        }
      }
    }
    throw error;
  }
  return { moved, conflicts, dryRun };
}

export function parseInstallArgs(argv) {
  const args = { force: false, help: false, skillsRoot: null, skipLegacy: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--force') args.force = true;
    else if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--skip-legacy') args.skipLegacy = true;
    else if (flag === '--skills-root') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('--skills-root needs a directory argument');
      args.skillsRoot = value;
    } else throw new Error('Unknown installer argument: ' + flag);
  }
  return args;
}
const USAGE = `Install the ${SKILL_NAME} Skill for MiniMax Code (engine ${EXPECTED_ENGINE}).

  node install-skills.mjs [--force] [--dry-run] [--skip-legacy] [--skills-root DIR]

  --skills-root DIR   install into DIR/${SKILL_NAME} instead of ${DST}. Bounded to that one
                      subdirectory; it never becomes a general-purpose system copy.
  --force             replace an existing ${SKILL_NAME} installation, retaining a verified backup.
  --dry-run           report what would be installed or quarantined, using the same preflight the real
                      install uses. Writes nothing at all:
                      no lock, no staging tree, no backup root, no move.
  --skip-legacy       do not touch a pre-existing \`${LEGACY_NAME}\` deployment at all.

Order: the install is validated and completed first, so a refused install (wrong engine, held lock,
missing --force) can never leave the generic \`${LEGACY_NAME}\` skill already removed. The legacy
quarantine runs second and rolls its own moves back if a later candidate fails.

Every transient (lock file, staging tree, retained backup, failed-rename parking) lives in
${WORK_ROOT} — outside the skills tree the host loader scans — so a hard kill can never leave a
second \`name: ${SKILL_NAME}\` directory inside the scanned tree.

Legacy \`${LEGACY_NAME}\` deployments are moved to ${BACKUP_ROOT}, also outside the tree, but only
when a sha256 manifest proves they are byte-identical to this project's reference copy. Anything
unprovable stays in place and is reported. Nothing is ever deleted.`;

// `overrides` exists only so a test can point the plan at a fixture engine. The CLI passes nothing,
// so the default path is byte-for-byte the one a user gets.
export function main(argv, overrides = {}) {
  const args = parseInstallArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  const skillsRoot = args.skillsRoot ? resolve(args.skillsRoot) : dirname(DST);
  if (!existsSync(skillsRoot)) throw new Error('Skill root does not exist: ' + skillsRoot);
  const destination = join(skillsRoot, SKILL_NAME);
  const workRoot = workRootFor(skillsRoot);
  const engine = overrides.engine || ENGINE;
  const expectedEngine = overrides.expectedEngine || EXPECTED_ENGINE;

  if (args.dryRun) {
    // Proof and reporting only. The install half runs the SAME preflight the real install runs, so
    // a missing or wrong-version engine is reported as the refusal it will be, never as
    // "would install". quarantineLegacyDeployments({dryRun:true}) hashes every candidate and
    // computes every target path but performs no mkdir, rename or write. Nothing below writes.
    const plan = args.skipLegacy ? { moved: [], conflicts: [] } : quarantineLegacyDeployments({ skillsRoot, dryRun: true });
    const installPlan = preflight({ source: SRC, destination, workRoot, engine, expectedEngine, skillName: SKILL_NAME, force: args.force });
    console.log('[install-skills] dry run: nothing was written (no lock, no staging, no backup root, no move).');
    console.log(`[install-skills] would install ${SKILL_NAME} at ${destination}: ${installPlan.ok ? 'yes — ' + installPlan.reason : 'no — ' + installPlan.reason}`);
    for (const entry of plan.moved) console.log('[install-skills] would quarantine legacy deployment:', entry.from, '->', entry.to);
    for (const entry of plan.conflicts) console.log('[install-skills] legacy conflict, left in place:', entry.path, '-', entry.reason);
    return 0;
  }

  const result = installSkill({ destination, workRoot, force: args.force, engine, expectedEngine });
  console.log(`[install-skills] installed ${SKILL_NAME} for engine ${result.engineVersion}: ${result.files.length} verified files at ${result.destination}`);
  if (result.backupPath) console.log('[install-skills] retained original:', result.backupPath);

  if (!args.skipLegacy) {
    const legacy = quarantineLegacyDeployments({ skillsRoot });
    for (const entry of legacy.moved) console.log('[install-skills] quarantined legacy deployment:', entry.from, '->', entry.to);
    for (const entry of legacy.conflicts) console.log('[install-skills] legacy conflict, left in place:', entry.path, '-', entry.reason);
  }
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error('[install-skills] FATAL:', error.message); process.exitCode = 1; }
}
export { SKILL_NAME, EXPECTED_ENGINE, LEGACY_NAME, WORK_ROOT_NAME, BACKUP_ROOT_NAME };
