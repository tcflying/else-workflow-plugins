// test/host-0.2.0-rc.2-contract.test.mjs — pins this plugin against the DSH Desktop 2.0.17
// host running `@deepseek-ai/dsh` 0.2.0-rc.2, instead of the 0.1.5-rc.2 baseline the plugin
// was last accepted on.
//
// Zero third-party dependencies, no host writes, no UI, no network. The host tree is read
// read-only; when it is not visible (a machine without DSH Desktop, or a Linux CI box) the
// host-grep group SKIPS explicitly with the reason, following the if-exists precedent in
// plugins/mmx-native-session-hook/test/engine-entry-alignment.test.mjs:126.
//
// THREE GROUPS:
//   (1) a faithful replica of the host's `parseDshClient` manifest validator, which must
//       accept this plugin's `dsh.client` and must REJECT deliberately broken manifests —
//       the non-vacuity self-proof, because a validator that accepts everything would make
//       group (1) meaningless;
//   (2) the browser-side registration shape: `window.__ModuleLoader__.load({id, factory})`
//       with the right id, and no top-level side effect escaping into registration time;
//   (3) the DOM/service contract points client.js depends on, each grep-verified against the
//       real 0.2.0-rc.2 install tree when it is present.
//
// HOST SOURCE OBSERVED 2026-10-10, all paths under
//   C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/
//   dsh-client-modules/lib/index.js:47-75   optionalStringArray() + parseDshClient()
//   dsh-client-modules/lib/index.js:395-404 graphRow() — inject/external/immediately onto the wire row
//   dsh-client-modules/lib/index.js:701-731 resolveMeta() — manifest → meta, platform !== "web" ⇒ not a client package
//   dsh-client-modules/lib/index.js:415-437 orderByModuleGraph() — walks `external` ONLY, never `inject`
//   dsh-client-modules/lib/client.js:644-661 arriveGraphRow() — inject targets absent from the graph are skipped
//   dsh-client-modules/lib/index.js:454-467 bootInjections() — the queue-mode `window.__ModuleLoader__` stub
//   dsh-client-ui-workspace/lib/client.js:1592   emits `data-row-key` = `session:${node.id}`
//   dsh-client-ui-workspace/lib/client.js:2446-2450 rowKeys: `workspace:` / `session:` / `overflow:` / `empty`
//   dsh-client-ui-conversation/lib/client.js:16414-16415 emits the `viewArea` class on the conversation root
//   dsh-api-session-controller/lib/client.js:3192 provides the `sessions` service client.js reads as ctx.sessions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = readFileSync(join(ROOT, 'client.js'), 'utf8');
const PKG_PATH = join(ROOT, 'package.json');
const PKG = JSON.parse(readFileSync(PKG_PATH, 'utf8'));

// The read-only host tree. Probed, never written.
const HOST_TREE = 'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai';
const HOST_VISIBLE = existsSync(HOST_TREE) && existsSync(join(HOST_TREE, 'dsh-client-modules', 'lib', 'index.js'));
const SKIP_REASON = HOST_VISIBLE
  ? null
  : `host install tree not visible at ${HOST_TREE} (checked 2026-10-10); host-grep assertions skipped`;

/** Read a host file once; `null` when the host tree is invisible (never throws). */
function hostRead(relPath) {
  if (!HOST_VISIBLE) return null;
  const file = join(HOST_TREE, ...relPath.split('/'));
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

// ---------------------------------------------------------------------------
// (1) A replica of the host's parseDshClient / optionalStringArray.
//     Transcribed from dsh-client-modules/lib/index.js:47-75 on 2026-10-10.
//     The host half and the roster generator share this one validator.
// ---------------------------------------------------------------------------

function optionalStringArray(subject, field, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`);
  }
  return value;
}

function parseDshClient(pkgName, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
  }
  const decl = value;
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject);
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external);
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
  }
  return {
    platform: decl.platform,
    ...inject !== undefined ? { inject } : {},
    ...external !== undefined ? { external } : {},
    ...decl.immediately !== undefined ? { immediately: decl.immediately } : {},
  };
}

test('F15 host: the replicated parseDshClient accepts this plugin dsh.client (0.2.0-rc.2)', () => {
  const parsed = parseDshClient(PKG.name, PKG.dsh.client);
  assert.deepEqual(parsed, { platform: 'web', inject: [], immediately: true });
});

test('F15 host (guard): the replica rejects deliberately broken manifests', () => {
  // Non-vacuity: if any of these ever stop throwing, group (1) proves nothing.
  assert.throws(() => parseDshClient('p', { inject: [] }), /platform must be a string/,
    'platform missing must be refused — host requires a string');
  assert.throws(() => parseDshClient('p', { platform: 1, inject: [] }), /platform must be a string/,
    'a non-string platform must be refused');
  assert.throws(() => parseDshClient('p', { platform: 'web', inject: [1] }), /inject must be a string array/,
    'a non-string inject member must be refused');
  assert.throws(() => parseDshClient('p', { platform: 'web', inject: 'x' }), /inject must be a string array/,
    'a non-array inject must be refused');
  assert.throws(() => parseDshClient('p', { platform: 'web', external: [null] }), /external must be a string array/,
    'a non-string external member must be refused');
  assert.throws(() => parseDshClient('p', { platform: 'web', immediately: 'true' }), /immediately must be a boolean/,
    'a non-boolean immediately must be refused');
  assert.throws(() => parseDshClient('p', 'nope'), /non-object dsh\.client declaration/,
    'a non-object declaration must be refused');
  assert.throws(() => parseDshClient('p', null), /non-object dsh\.client declaration/,
    'a null declaration must be refused');

  // The absent-field path still passes (the shape a minimal manifest would have).
  assert.deepEqual(parseDshClient('p', { platform: 'web' }), { platform: 'web' },
    'platform alone is a legal declaration');
  assert.equal(parseDshClient('p', undefined), undefined, 'an absent declaration yields undefined');
});

test('F15 host: resolveMeta only treats a package as a client package when platform === "web"', () => {
  // dsh-client-modules/lib/index.js:714 — `decl === undefined || decl.platform !== "web"` ⇒ not a client package.
  assert.equal(PKG.dsh.client.platform, 'web',
    'this plugin must stay on platform "web" or the host stops scanning it as a client package');
});

test('F15 host: the plugin exports a ./client bundle, which resolveMeta requires', () => {
  // dsh-client-modules/lib/index.js:718-719 throws when dsh.client is declared without a ./client export.
  assert.equal(PKG.exports['./client'], './client.js',
    'the host locates the bundle through exports["./client"]');
  assert.ok(existsSync(join(ROOT, 'client.js')), 'that export target exists on disk');
});

test('F15 host: dsh.client.inject names no package that 0.2.0-rc.2 dropped', () => {
  // @deepseek-ai/dsh-client-runtime was removed from the 0.2.0-rc.2 install tree (the module
  // system was folded into dsh-client-modules), so the old inject target was a dead reference.
  assert.deepEqual(PKG.dsh.client.inject, [], 'inject carries no dead package reference');
  if (HOST_VISIBLE) {
    assert.equal(existsSync(join(HOST_TREE, 'dsh-client-runtime')), false,
      '@deepseek-ai/dsh-client-runtime is genuinely absent from this host tree');
    assert.ok(existsSync(join(HOST_TREE, 'dsh-client-modules')), 'and dsh-client-modules is the package that replaced it');
  }
});

test('F15 host: no manifestVersion field is declared, because 0.2.0-rc.2 reads none', () => {
  // Adding dsh.manifestVersion on a guess would be self-declared metadata with no reader.
  assert.equal(PKG.dsh.manifestVersion, undefined, 'no self-declared manifestVersion');
  if (HOST_VISIBLE) {
    for (const rel of ['dsh-client-modules/lib/index.js', 'dsh-client-modules/lib/client.js',
      'dsh-package-manifest/lib/index.js', 'dsh-app-boot/lib/index.js']) {
      const src = hostRead(rel);
      if (src === null) continue;
      assert.ok(!src.includes('manifestVersion'),
        `${rel} must not read manifestVersion in 0.2.0-rc.2`);
    }
  }
});

// ---------------------------------------------------------------------------
// (2) Browser-side registration shape.
// ---------------------------------------------------------------------------

test('F15 host: client.js registers through window.__ModuleLoader__.load({id, factory})', () => {
  // The banner comment may precede the registration; nothing else may.
  const firstStatement = CLIENT_SRC.split('\n').find((line) => line.trim() !== '' && !line.trim().startsWith('//'));
  assert.equal(firstStatement.trim(), 'window.__ModuleLoader__.load({',
    'the first executable statement is the lazy registration, not an eager bundle body');
  assert.match(CLIENT_SRC, /id:\s*'@dsh-external\/dsh-workflow-pipeline'/,
    'the registered id is the package name');
  assert.match(CLIENT_SRC, /factory:\s*\(require\)\s*=>/,
    'the module body is a factory closure (lazy-CJS contract)');
  assert.match(CLIENT_SRC, /return module\.exports;\s*\}\s*,?\s*\}\);\s*$/,
    'the bundle ends by returning the factory result');
});

test('F15 host: executing client.js only registers a factory — no side effect at registration time', () => {
  // The host's lazy model: "executing a plugin bundle only REGISTERS its factory
  // (window.__ModuleLoader__.load({id, factory})); every module body side effect ... lives
  // inside the factory closure and runs at materialization, not at script execution"
  // (dsh-client-modules/lib/index.js:16-23).
  const registrations = [];
  const effects = [];
  const document = {
    addEventListener: () => effects.push('document.addEventListener'),
    querySelector: () => { effects.push('document.querySelector'); return null; },
    querySelectorAll: () => { effects.push('document.querySelectorAll'); return []; },
    createElement: () => { effects.push('document.createElement'); return null; },
    getElementById: () => { effects.push('document.getElementById'); return null; },
    body: { appendChild: () => effects.push('document.body.appendChild'), remove: () => {} },
    head: { appendChild: () => effects.push('document.head.appendChild') },
    documentElement: { style: {}, appendChild: () => {} },
  };
  const sandbox = {
    document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => { effects.push('setTimeout'); return 0; },
    clearTimeout() {},
    setInterval: () => { effects.push('setInterval'); return 0; },
    clearInterval() {},
    queueMicrotask: () => effects.push('queueMicrotask'),
    fetch: () => { effects.push('fetch'); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
    location: { href: '' },
  };
  sandbox.window = {
    __ModuleLoader__: {
      mode: 'queue',
      pendingQueue: registrations,
      load: (registration) => registrations.push(registration),
    },
    addEventListener: () => effects.push('window.addEventListener'),
    location: { href: '' },
    document,
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'client.js' });

  assert.equal(registrations.length, 1, 'exactly one module registration');
  assert.equal(registrations[0].id, '@dsh-external/dsh-workflow-pipeline', 'and it carries the package id');
  assert.equal(typeof registrations[0].factory, 'function', 'and a factory function');
  assert.deepEqual(effects, [],
    'no DOM, timer, microtask or network side effect may run at registration time');
});

test('F15 host: the factory never calls require, so inject is pure ordering metadata', () => {
  // Zero require() calls means the plugin needs no graph dependency; `inject` only ever
  // influenced arrival ORDER, never module resolution.
  const body = CLIENT_SRC.slice(CLIENT_SRC.indexOf('factory:'));
  assert.equal(/\brequire\s*\(/.test(body), false,
    'the factory body must contain no require() call');
  assert.equal(/\brequire\.async\s*\(/.test(body), false,
    'nor any dynamic require.async() chunk request');
});

// ---------------------------------------------------------------------------
// (3) DOM / service contract points, grep-verified against the real host tree.
// ---------------------------------------------------------------------------

// Each point is a contract client.js DEPENDS ON, paired with the host file that must still
// carry the matching emission. `clientLine` is matched against the trimmed, non-comment
// source lines so a re-indent cannot silently void the assertion.
const CLIENT_CODE_LINES = new Set(
  CLIENT_SRC.split('\n').map((line) => line.replace(/\t+/g, ' ').trim())
    .filter((line) => line !== '' && !line.startsWith('//'))
);

const CONTRACT_POINTS = [
  {
    point: 'session row identity: [data-row-key] with a `session:` prefix',
    clientLines: ["var SESSION_ROW_KEY_ATTR = 'data-row-key';", "var SESSION_ROW_KEY_PREFIX = 'session:';"],
    host: 'dsh-client-ui-workspace/lib/client.js',
    needles: ['data-row-key', '`session:${node.id}`', '`session:${row.id}`'],
    why: 'rowSessionId() only accepts the `session:` form; workspace:/overflow:/empty rows resolve to ""',
  },
  {
    point: 'the non-session row kinds that must NOT claim a progress line',
    clientLines: ["if (key.lastIndexOf(SESSION_ROW_KEY_PREFIX, 0) !== 0) return '';"],
    host: 'dsh-client-ui-workspace/lib/client.js',
    needles: ['`workspace:${group.key}`', '`overflow:${group.key}`', '"empty"'],
    why: 'these siblings prove data-row-key is a kind-tagged identity, not a session id',
  },
  {
    point: 'sessionRow class (the pre-0.2.0 fallback row selector)',
    clientLines: ["var SESSION_ROW_SEL = '[class*=\"sessionRow\"]';"],
    host: 'dsh-client-ui-workspace/lib/client.js',
    needles: ['sessionRow'],
    why: 'still emitted, but hashed (…_sessionRow) so it cannot identify a row on its own',
  },
  {
    point: 'viewArea anchor for the in-conversation card',
    clientLines: ["var areas = document.querySelectorAll('[class*=\"viewArea\"]');"],
    host: 'dsh-client-ui-conversation/lib/client.js',
    needles: ['viewArea'],
    why: 'findAnchor() picks the tallest viewArea and claims position:relative on it',
  },
  {
    point: 'the `sessions` service client.js reads as ctx.sessions',
    clientLines: ["rec.sessionsRoot = ctx.sessions;"],
    host: 'dsh-api-session-controller/lib/client.js',
    needles: ['provide("sessions"', 'retainInfo'],
    why: 'main-session identity and the per-seat retain watch both come from this service',
  },
  {
    point: 'ctx.effect, the host lifecycle seam client.js registers its teardown on',
    clientLines: ["ctx.effect(() => start(ctx), 'dsh-workflow-pipeline: live-ui');"],
    host: 'dsh-client-modules/lib/client.js',
    needles: ['ctx.effect'],
    why: 'activation/dispose generation depends on ctx.effect running the cleanup',
  },
];

test('F15 host: every DOM/service contract point client.js uses still exists in 0.2.0-rc.2', (t) => {
  if (!HOST_VISIBLE) return t.skip(SKIP_REASON);
  for (const cp of CONTRACT_POINTS) {
    const src = hostRead(cp.host);
    assert.ok(src !== null, `${cp.host} must be present in the host tree`);
    for (const line of cp.clientLines) {
      assert.ok(CLIENT_CODE_LINES.has(line),
        `client.js must still carry the contract point ${JSON.stringify(line)} — ${cp.point}`);
    }
    for (const needle of cp.needles) {
      assert.ok(src.includes(needle),
        `${cp.host} must still contain ${JSON.stringify(needle)} — ${cp.point} (${cp.why})`);
    }
  }
});

test('F15 host: data-session-id is NOT emitted by 0.2.0-rc.2 (the legacy branch stays inert)', (t) => {
  if (!HOST_VISIBLE) return t.skip(SKIP_REASON);
  // The comment in client.js calls this "purely defensive"; this test pins that claim so it
  // cannot silently rot into a false statement.
  const offenders = [];
  for (const pkg of ['dsh-client-ui-workspace', 'dsh-client-ui-sidebar', 'dsh-client-ui-session',
    'dsh-client-ui-conversation']) {
    const src = hostRead(pkg + '/lib/client.js');
    if (src !== null && src.includes('data-session-id')) offenders.push(pkg);
  }
  assert.deepEqual(offenders, [],
    'no official 0.2.0-rc.2 client package emits data-session-id; only data-row-key is real');
  assert.ok(CLIENT_SRC.includes("var SESSION_ID_ATTR = 'data-session-id';"),
    'client.js still keeps the legacy attribute as an inert fallback');
});

test('F15 host: the module face declares the cordis services it consumes, separately from the manifest inject', (t) => {
  // TWO different "inject" fields, often confused:
  //   dsh.client.inject (package.json) — graph ARRIVAL ORDER between bundles. Dead metadata
  //     for us: zero require() calls. Now [].
  //   exports.inject (client.js module face) — cordis SERVICE injection, consumed by
  //     cordis/lib/index.js:1452-1474. This is the one that makes ctx.sessions resolvable;
  //     without it cordis/lib/index.js:676 throws `cannot get property "sessions" without inject`.
  assert.ok(CLIENT_CODE_LINES.has("exports.inject = ['sessions'];"),
    'the module face must declare its service dependency');
  assert.ok(CLIENT_CODE_LINES.has('exports.apply = function (ctx) {'),
    'and the cordis apply hook the host calls');
  if (!HOST_VISIBLE) return t.skip(SKIP_REASON);
  const cordis = hostRead('cordis/lib/index.js');
  assert.ok(cordis !== null, 'cordis/lib/index.js must be present in the host tree');
  assert.ok(cordis.includes('without inject'),
    'cordis still refuses an undeclared service access — exports.inject is load-bearing');
});

test('F15 host (guard): the row-key resolver accepts only `session:` and rejects every other kind', () => {
  // Mirrors rowSessionId() in client.js so the strictness survives a selector rewrite.
  const rowSessionId = (attrs) => {
    const key = attrs['data-row-key'];
    if (typeof key === 'string' && key) {
      if (key.lastIndexOf('session:', 0) !== 0) return '';
      return key.slice('session:'.length);
    }
    return attrs['data-session-id'] || '';
  };
  assert.equal(rowSessionId({ 'data-row-key': 'session:abc' }), 'abc');
  assert.equal(rowSessionId({ 'data-row-key': 'workspace:w1' }), '', 'workspace rows never claim a line');
  assert.equal(rowSessionId({ 'data-row-key': 'overflow:w1' }), '', 'overflow rows never claim a line');
  assert.equal(rowSessionId({ 'data-row-key': 'empty' }), '', 'the empty placeholder never claims a line');
  assert.equal(rowSessionId({ 'data-row-key': '' }), '', 'an empty key falls through, it does not slice');
  assert.equal(rowSessionId({ 'data-row-key': 'xsession:abc' }), '', 'the prefix must be anchored, not a substring');
  assert.equal(rowSessionId({ 'data-session-id': 'legacy' }), 'legacy', 'the legacy branch still resolves');
});

// ---------------------------------------------------------------------------
// inject consumption: the read-code conclusion this release is built on.
// ---------------------------------------------------------------------------

test('F15 host: the host skips an inject target that is absent from the graph', (t) => {
  if (!HOST_VISIBLE) return t.skip(SKIP_REASON);
  const src = hostRead('dsh-client-modules/lib/client.js');
  // arriveGraphRow() (client.js:656-659) guards the dependency lookup, so a dead inject target
  // is skipped rather than awaited. This is why clearing inject was a cleanup, not a bugfix.
  assert.match(src, /for \(const packageName of row\.inject\) \{\s*const dependency = this\.graphRows\.get\(packageName\);\s*if \(dependency !== void 0\)/,
    'arriveGraphRow must guard the inject dependency lookup');
  const node = hostRead('dsh-client-modules/lib/index.js');
  assert.match(node, /for \(const name of entry\.external \?\? \[\]\)/,
    'orderByModuleGraph orders by external only — inject never participates in graph ordering');
});

test('F15 host: the plugin version and client half are coherent with the 0.2.0-rc.2 baseline', () => {
  assert.equal(PKG.version, '0.2.7', 'the manifest is bumped to 0.2.7 for this baseline');
  assert.equal(PKG.dsh.bundle.patch, './cordis.patch.yml', 'the node half still declares its bundle patch');
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')), 'and that patch file exists');
});