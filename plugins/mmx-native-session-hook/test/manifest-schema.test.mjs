// test/manifest-schema.test.mjs — 1004.md §4 W4 / F22 (mmx-native-session-hook).
//
// F22: "自有 mmx-native-session-hook 清单被 Desktop 3.1.0 读取链拒绝". The item is marked
// "历史审查快照，实施前重核", so the rules below were re-read, read-only, out of the CURRENT
// Desktop build (G:/MiniMax/MiniMax Code/resources/app.asar, `__MAVIS_VERSION__:"3.1.0"`):
//
//   node_modules/@mavis/local-runtime-v2/src/service/plugin-system/plugin/package/minimax-reader.ts
//     MANIFEST_FIELDS        : line 46   — an unknown field is a hard reject
//     PLUGIN_NAME / SEMVER   : lines 25-27
//     ICON_PATH              : line 28   — /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/u
//     APP/MCP/SKILL/HOOK/HOST_BINDING_PATH : lines 29-33
//     readManifest           : lines 295-312 (envelope -> identity -> icon -> darkIcon -> category
//                                  -> exampleQueries -> capabilities, in that order)
//     readManifestIdentity   : lines 326-347 — author is read by requiredString(), i.e. a
//                                  non-empty STRING; an object is rejected.
//     readManifestIcon       : lines 349-355 — `icon` is REQUIRED (no default).
//     readManifestCategory   : lines 357-368 — 'Tools' is a retired alias mapped to 'Other';
//                                  everything else must be an exact member of the enum.
//     requiredString/optionalString : lines 415-427
//     package/types.ts MARKETPLACE_CATEGORY_NAMES : lines 4-15
//   .../package/filesystem.ts resolvePluginFile (lines 31-45) and
//   .../package/package-readers.ts readImportedPluginPackage (lines 36-62)
//     — `icon` resolves from the PLUGIN ROOT (the directory that contains .minimax-plugin/),
//       must be a regular readable file, and the reader only stats it: it never decodes the image.
//   The reader's own positive fixture (package-readers.test.ts:1809-1857) uses
//   `icon: 'icon.png'` at the root, and the same host already accepts an installed
//   mmx-plug-test 0.1.1 with `"author":"tcflying"`, `"icon":"icon.png"`, `"category":"Code"`.
//
// What this file does NOT do, per F22's guards: it does not connect to the host, does not claim a
// successful host load, and does not read any live capability. "Other hook packages load" and
// "the directory exists" are not evidence for this package — the manifest is judged on its own.
// A real Desktop scan and a native-attribution read-back remain unverified (F22 真实验收：未测).
//
// The last case in this file judges the INSTALLED copy under ~/.minimax/plugins — the tree the
// host actually scans — read-only, and it is RED today: that copy is still the pre-fix manifest
// (author object, no icon, lower-case category, no icon.png), so the reader still rejects it. That
// red is the honest "pending deployment" exposure 1004.md §4 W4 F22 asks for ("对安装副本清单跑
// schema 断言"), not a product regression: the workspace source is fixed and green, and the host
// reads the installed tree, not the workspace. Disposition: same class as the 8 pre-existing
// deployment-safety reds — a DOCUMENTED red that turns green the moment the main session syncs
// ~/.minimax (deployment is explicitly out of this round's write scope; ~/.minimax is read-only
// here). The case skips itself when the copy is not deployed, so it never asserts about a tree
// that does not exist.
//
// No third-party dependency, no network, no host process, no Temp directory, no write outside
// this file: the workspace manifest and icon are read straight out of the package tree, and the
// installed tree is only ever READ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const PLUGINS_ROOT = join(PLUGIN_ROOT, '..');
const MANIFEST_REL = '.minimax-plugin/plugin.json';
// The copy the host actually scans, i.e. the one 1004.md §4 W4 F22 names for the offline schema
// assertion. READ-ONLY here: this round changes the workspace source, deployment is not in scope.
const INSTALLED_ROOT = 'C:/Users/datoo/.minimax/plugins/mmx-native-session-hook';

// --- the reader's rules, transcribed from minimax-reader.ts (see the header) ------------
const PLUGIN_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const ICON_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/u;
const APP_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.app\.json$/u;
const MCP_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mcp\.json$/u;
const SKILL_PATH = /^skills\/[A-Za-z0-9._-]+\/SKILL\.md$/u;
const HOOK_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/u;
const HOST_BINDING_PATH = /^bindings\/[A-Za-z0-9._-]+\.binding\.json$/u;
const MARKETPLACE_CATEGORY_NAMES = ['Office', 'Studio', 'Design & Sites', 'Code', 'Business', 'Sales', 'Productivity', 'Science & Healthcare', 'Education', 'Other'];
const MANIFEST_FIELDS = new Set(['$schema', 'schemaVersion', 'name', 'displayName', 'version', 'description', 'author', 'icon', 'darkIcon', 'category', 'exampleQueries', 'apps', 'mcpServers', 'skills', 'hooks', 'hostBindings']);

// Throws the same shape the reader raises, so one assertion can state the rejection code.
class ReaderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (message) => { throw new ReaderError('MANIFEST_SCHEMA_INVALID', message); };
function optionalString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}
function requiredString(value, label) {
  const parsed = optionalString(value, label);
  if (!parsed) fail(`${label} is required`);
  return parsed;
}
function uniqueStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(`${label} must be a string array`);
  if (new Set(value).size !== value.length) fail(`${label} contains a duplicate`);
  return value;
}
function referenceArray(value, label, pattern) {
  const items = uniqueStringArray(value, label);
  if (items.some((item) => item.length > 512 || !pattern.test(item))) fail(`${label} contains an invalid path`);
  return items;
}

/** readManifest() — envelope, identity, icon, darkIcon, category, exampleQueries, capabilities. */
export function readManifest(value) {
  if (Object.keys(value).some((key) => !MANIFEST_FIELDS.has(key))) fail('MiniMax manifest contains an unknown field');
  if ((value.$schema !== undefined && typeof value.$schema !== 'string') || value.schemaVersion !== 1) {
    fail('MiniMax manifest schemaVersion must be 1');
  }
  const name = requiredString(value.name, 'name');
  if (name.length > 80 || !PLUGIN_NAME.test(name)) fail('MiniMax Plugin name is invalid');
  const version = requiredString(value.version, 'version');
  if (version.length > 128 || !SEMVER.test(version)) fail('MiniMax Plugin version is not semver');
  const displayName = optionalString(value.displayName, 'displayName');
  const description = requiredString(value.description, 'description');
  const author = requiredString(value.author, 'author');
  const icon = requiredString(value.icon, 'icon');
  if (icon.length > 512 || !ICON_PATH.test(icon)) fail('MiniMax Plugin icon path is invalid');
  const darkIcon = value.darkIcon === undefined ? undefined : requiredString(value.darkIcon, 'darkIcon');
  if (darkIcon !== undefined && (darkIcon.length > 512 || !ICON_PATH.test(darkIcon))) fail('MiniMax Plugin darkIcon path is invalid');
  // readManifestCategory: 'Tools' is the retired id 8 alias; anything else must be exact.
  const raw = value.category;
  const category = raw === 'Tools' ? 'Other' : raw;
  if (typeof category !== 'string' || !MARKETPLACE_CATEGORY_NAMES.includes(category)) fail('MiniMax Plugin category is invalid');
  const exampleQueries = uniqueStringArray(value.exampleQueries, 'exampleQueries');
  if (exampleQueries.some((q) => !q.trim())) fail('MiniMax Plugin example query is blank');
  return {
    name, displayName, version, description, author, icon, darkIcon, category, exampleQueries,
    apps: referenceArray(value.apps, 'apps', APP_PATH),
    mcpServers: referenceArray(value.mcpServers, 'mcpServers', MCP_PATH),
    skills: referenceArray(value.skills, 'skills', SKILL_PATH),
    hooks: value.hooks === undefined ? [] : referenceArray(value.hooks, 'hooks', HOOK_PATH),
    hostBindings: value.hostBindings === undefined ? [] : referenceArray(value.hostBindings, 'hostBindings', HOST_BINDING_PATH),
  };
}

/** resolvePluginFile(): the reference is read from the plugin root and must be a regular file. */
function resolvePluginFile(root, relativePath) {
  const path = join(root, relativePath);
  if (!lstatSync(path).isFile()) fail(`${relativePath} is not a regular file`);
  return readFileSync(path);
}

// Every .minimax-plugin/plugin.json in the workspace plugin tree: one copy today, and a second
// copy would be judged by the same rules instead of being silently skipped.
function workspaceManifests() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;             // the reader rejects a symlinked plugin root
      if (entry.isDirectory()) { walk(path); continue; }
      if (relative(PLUGINS_ROOT, path).split(sep).join('/') === 'mmx-native-session-hook/' + MANIFEST_REL) found.push(path);
    }
  };
  walk(join(PLUGINS_ROOT, 'mmx-native-session-hook'));
  return found;
}

const manifests = workspaceManifests();

test('F22: exactly one .minimax-plugin manifest copy exists in the workspace plugin tree', () => {
  assert.deepEqual(manifests, [join(PLUGIN_ROOT, MANIFEST_REL)]);
});

for (const manifestPath of manifests) {
  const label = relative(PLUGINS_ROOT, manifestPath).split(sep).join('/');
  // packageRoot for readMiniMaxPluginPackage(): the directory that contains .minimax-plugin/.
  const pluginRoot = dirname(dirname(manifestPath));
  // Read inside each test, not at collection time, so one rejection cannot hide the other cases.
  const load = () => readManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

  test(`F22: ${label} passes the Desktop manifest reader rules`, () => {
    const raw = load();
    assert.equal(raw.name, 'mmx-native-session-hook');
    assert.equal(typeof raw.author, 'string');
    assert.ok(raw.author.length > 0, 'author must be a non-empty string (an object is rejected)');
    assert.ok(MARKETPLACE_CATEGORY_NAMES.includes(raw.category), 'category must be an exact enum member: ' + raw.category);
    assert.notEqual(raw.category, 'Tools', "'Tools' is the retired alias, not a category this package declares");
  });

  test(`F22: ${label} icon is a real, readable image file at the plugin root`, () => {
    const bytes = resolvePluginFile(pluginRoot, load().icon);
    assert.ok(bytes.length > 0, 'the icon is not an empty placeholder');
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      'PNG signature — the reader only stats this file, so a real image is on us');
    assert.equal(bytes.subarray(12, 16).toString('latin1'), 'IHDR', 'the first chunk is a PNG header');
    assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, 'the PNG declares non-zero dimensions');
  });

  test(`F22: ${label} declared hooks resolve to real files`, () => {
    const raw = load();
    assert.ok(raw.hooks.length > 0, 'the package declares its PreToolUse hook');
    for (const hook of raw.hooks) {
      const parsed = JSON.parse(resolvePluginFile(pluginRoot, hook).toString('utf8'));
      assert.ok(parsed && parsed.hooks && parsed.hooks.PreToolUse, hook + ' carries the PreToolUse relay');
    }
  });
}

test('F22: the replicated rules still reject every pre-fix shape (the replication is not vacuous)', () => {
  const base = JSON.parse(readFileSync(manifests[0], 'utf8'));
  // (1) author as an object — the original defect
  assert.throws(() => readManifest({ ...base, author: { name: 'tcflying' } }), (e) => e instanceof ReaderError && e.code === 'MANIFEST_SCHEMA_INVALID');
  // (2) author missing entirely
  const noAuthor = { ...base }; delete noAuthor.author;
  assert.throws(() => readManifest(noAuthor), (e) => e.message === 'author is required');
  // (3) no icon
  const noIcon = { ...base }; delete noIcon.icon;
  assert.throws(() => readManifest(noIcon), (e) => e.message === 'icon is required');
  // (4) a lower-case category
  assert.throws(() => readManifest({ ...base, category: 'productivity' }), (e) => e.message === 'MiniMax Plugin category is invalid');
  // (5) an icon the reader's path rule would not accept
  assert.throws(() => readManifest({ ...base, icon: 'icon.svg' }), (e) => e.message === 'MiniMax Plugin icon path is invalid');
  // (6) an unknown manifest field
  assert.throws(() => readManifest({ ...base, extra: 1 }), (e) => e.message === 'MiniMax manifest contains an unknown field');
  // (7) the retired alias is accepted but normalised, so 'Tools' is not a free pass to stay
  assert.equal(readManifest({ ...base, category: 'Tools' }).category, 'Other');
});

test('F22: the icon the manifest names is the file the tree actually ships', () => {
  const raw = readManifest(JSON.parse(readFileSync(manifests[0], 'utf8')));
  assert.equal(raw.icon, 'icon.png', 'a bare root-relative name, the shape the reader resolves');
  assert.ok(statSync(join(PLUGIN_ROOT, raw.icon)).isFile());
  assert.equal(raw.hooks[0], 'hooks/hooks.json');
});

// The installed copy is the tree the host scans, so the same rules are run against it, read-only.
// RED until the main session syncs ~/.minimax — see the note in this file's header.
test('F22: the installed copy the host scans passes the same reader rules', (t) => {
  if (!existsSync(INSTALLED_ROOT)) return t.skip('not deployed on this machine: nothing to claim');
  const manifestPath = join(INSTALLED_ROOT, MANIFEST_REL);
  let raw;
  try {
    raw = readManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    // The rejection IS the finding: the host's reader chain refuses this tree today.
    assert.fail('installed copy pending deployment; host still rejects it: ' + (error && error.message));
  }
  assert.equal(raw.name, 'mmx-native-session-hook', 'the deployed package is this one');
  assert.equal(typeof raw.author, 'string', 'deployed author must be a non-empty string');
  assert.ok(raw.author.length > 0);
  assert.ok(MARKETPLACE_CATEGORY_NAMES.includes(raw.category), 'deployed category must be an exact enum member, got: ' + raw.category);
  const bytes = resolvePluginFile(INSTALLED_ROOT, raw.icon);
  assert.ok(bytes.length > 0, 'the deployed icon is a real file, not an empty placeholder');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'deployed icon is a real PNG');
  for (const hook of raw.hooks) {
    const parsed = JSON.parse(resolvePluginFile(INSTALLED_ROOT, hook).toString('utf8'));
    assert.ok(parsed && parsed.hooks && parsed.hooks.PreToolUse, 'deployed ' + hook + ' carries the PreToolUse relay');
  }
});
