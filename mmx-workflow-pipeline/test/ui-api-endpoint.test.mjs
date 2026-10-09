// test/ui-api-endpoint.test.mjs — the injected bundle must address the API THIS sidecar listens
// on, so a UI acceptance run can be isolated on its own dynamic loopback port while production
// stays on the fixed 4231. Run: node --test test/ui-api-endpoint.test.mjs
//
// What this file deliberately does NOT do — these are the isolation guarantees, not omissions:
//   * it binds NO listener and opens NO socket: CDP is a hand-written fake client handed to
//     startCdpInjector's own `listTargets` / `connect` seams, so no window, no real debugger and
//     no host process is contacted;
//   * it never binds or connects to 4231 (production API), 9331 (production CDP) or 19080 — the
//     ports under test are ephemeral-shaped literals that are never bound, plus an assertion that
//     the constructed host API is still not listening;
//   * it starts no engine, writes no file, and prints no capability. The capability is asserted
//     to be per-start random and memory-only, exactly as the production path holds it.
//
// A pass here is a unit-level proof of the WIRING ONLY. It is not evidence that a card renders
// in a real MiniMax Code window: that still needs a live isolated instance, and a UI that is not
// attached must be reported as a missing UI, never as a completed end-to-end run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createHostApi, buildInjectSource, normalizeApiBase, listeningPort, startCdpInjector,
  newCapability, API_BASE_PLACEHOLDER, CAPABILITY_PLACEHOLDER, DEFAULT_API_BASE, API_PORT,
} from '../sidecar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(resolve(HERE, '..'), 'client-inject.js');
const RAW = readFileSync(CLIENT, 'utf8');
const CAP = 'ui-endpoint-capability-0123456789ab';

// An isolated dynamic port and an isolated CDP port, both plain literals — never bound here.
const ISO_API_PORT = 53124;
const ISO_CDP_PORT = 19331;
const ISO_API_BASE = `http://127.0.0.1:${ISO_API_PORT}`;

const apiAssignment = (source) => {
  const m = /var API = '([^']*)'/.exec(source);
  assert.ok(m, 'the bundle must declare a single-quoted var API');
  return m[1];
};

test('normalizeApiBase accepts only loopback http with an explicit port, and canonicalises it', () => {
  assert.equal(normalizeApiBase(undefined), `http://127.0.0.1:${API_PORT}`, 'no value means the fixed production base');
  assert.equal(normalizeApiBase(''), DEFAULT_API_BASE);
  assert.equal(normalizeApiBase(`http://127.0.0.1:${API_PORT}`), 'http://127.0.0.1:4231');
  assert.equal(normalizeApiBase(ISO_API_BASE), ISO_API_BASE, 'an isolated dynamic loopback port is allowed');
  assert.equal(normalizeApiBase(ISO_API_BASE + '/'), ISO_API_BASE, 'a bare trailing slash is canonicalised away, not appended twice');
});

test('normalizeApiBase refuses every endpoint that is not plain loopback http on an explicit port', () => {
  const refused = [
    ['https scheme', 'https://127.0.0.1:4231'],
    ['ws scheme', 'ws://127.0.0.1:4231'],
    ['file scheme', 'file:///C:/tmp'],
    ['javascript scheme', "javascript:fetch('//evil.example')"],
    ['external host', 'http://evil.example.com:4231'],
    ['external IP', 'http://10.0.0.5:4231'],
    ['localhost by name', 'http://localhost:4231'],
    ['IPv6 loopback by name', 'http://[::1]:4231'],
    ['credential in authority', 'http://user:pass@127.0.0.1:4231'],
    ['query string', 'http://127.0.0.1:4231?cap=abc'],
    ['fragment', 'http://127.0.0.1:4231#x'],
    ['path component', 'http://127.0.0.1:4231/runs'],
    ['traversal path', 'http://127.0.0.1:4231/../elsewhere'],
    ['no explicit port', 'http://127.0.0.1'],
    ['port zero', 'http://127.0.0.1:0'],
    ['port out of range', 'http://127.0.0.1:99999'],
    ['quoted injection', `http://127.0.0.1:4231';fetch('//evil.example`],
    ['uppercase scheme', 'HTTP://127.0.0.1:4231'],
    ['bearer-ish suffix', 'http://127.0.0.1:4231 @evil.example'],
    ['bare port number', 4231],
    ['bare host string', '127.0.0.1:4231'],
  ];
  for (const [label, value] of refused) {
    assert.throws(() => normalizeApiBase(value), /invalid workflow API base/, `must refuse: ${label} (${String(value)})`);
  }
});

test('the real client bundle carries exactly one API base placeholder', () => {
  assert.equal(RAW.split(API_BASE_PLACEHOLDER).length - 1, 1, 'exactly one API base placeholder occurrence');
  assert.equal(apiAssignment(RAW), API_BASE_PLACEHOLDER, 'the shipped bundle defers its API base to the sidecar');
  assert.equal(RAW.split(CAPABILITY_PLACEHOLDER).length - 1, 1, 'the capability placeholder count is unchanged');
});

test('the default two-argument call is unchanged: production still injects 4231', () => {
  const injected = buildInjectSource(RAW, CAP);
  assert.equal(apiAssignment(injected), 'http://127.0.0.1:4231', 'the production default must not drift');
  assert.ok(!injected.includes(API_BASE_PLACEHOLDER));
  assert.ok(!injected.includes(CAPABILITY_PLACEHOLDER));
  assert.ok(injected.includes(CAP));
});

test('an isolated base reaches the real client source, and the capability still does not', () => {
  const injected = buildInjectSource(RAW, CAP, ISO_API_BASE);
  assert.equal(apiAssignment(injected), ISO_API_BASE, 'the bundle is wired to the isolated API');
  assert.ok(injected.includes(CAP), 'the real capability is inside the closure');
  assert.ok(!injected.includes(API_BASE_PLACEHOLDER));
  assert.ok(!injected.includes(CAPABILITY_PLACEHOLDER));
  // Requests must still concatenate a relative path onto the substituted base, never re-embed
  // an endpoint of their own.
  assert.ok(injected.includes('API + '), 'requests still concatenate a relative path');
  assert.ok(!/fetch\(\s*['"]http/.test(injected), 'no request re-embeds a literal endpoint');
});

test('an unsafe API base is refused even when the source has no capability placeholder', () => {
  // The old implementation returned early on a missing capability placeholder, which skipped the
  // API substitution entirely; validation must no longer depend on the capability placeholder.
  const source = "var API = '" + API_BASE_PLACEHOLDER + "';";
  assert.equal(apiAssignment(buildInjectSource(source, CAP, ISO_API_BASE)), ISO_API_BASE,
    'the API base is still substituted when there is no capability placeholder');
  assert.throws(() => buildInjectSource(source, CAP, 'http://evil.example.com:80'), /invalid workflow API base/);
  assert.throws(() => buildInjectSource('no placeholders at all', CAP, 'https://127.0.0.1:4231'), /invalid workflow API base/);
  assert.equal(buildInjectSource('no placeholders here', CAP), 'no placeholders here', 'a plain source is returned unchanged');
});

test('an unsafe API base is refused by startCdpInjector before any target is contacted', () => {
  let listed = 0;
  assert.throws(() => startCdpInjector({
    port: ISO_CDP_PORT, scriptPath: CLIENT, apiBase: 'http://evil.example.com:4231', quiet: true,
    listTargets: async () => { listed++; return []; },
    connect: () => { throw new Error('UNEXPECTED_CONNECT'); },
  }), /invalid workflow API base/);
  assert.equal(listed, 0, 'the injector must fail at start, not on first attach');
});

// --- fake CDP: no socket, no window, no host process -------------------------------
function fakeCdpClient() {
  const calls = [];
  return {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'doc-' + calls.length };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
}

const archonTarget = (id, cdpPort) => ({
  type: 'page', title: 'MiniMax Code', url: 'app://./archon', id,
  webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/${id}`,
});

const waitForTarget = async (inj, id) => {
  const deadline = Date.now() + 2000;
  while (inj.target !== id) {
    assert.ok(Date.now() < deadline, `injector never attached to ${id}`);
    await new Promise((r) => setTimeout(r, 10));
    await inj.attempt();
  }
};

test('the source delivered to the isolated renderer uses the isolated API base on a non-production CDP port', async () => {
  const client = fakeCdpClient();
  const injector = startCdpInjector({
    port: ISO_CDP_PORT, scriptPath: CLIENT, apiBase: ISO_API_BASE, quiet: true,
    pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [archonTarget('iso', ISO_CDP_PORT)],
    connect: () => Promise.resolve(client),
  });
  try {
    await waitForTarget(injector, 'iso');
    const registered = client.calls.filter(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument');
    assert.equal(registered.length, 1, 'one document script registered');
    const source = registered[0][1].source;
    assert.equal(apiAssignment(source), ISO_API_BASE, 'the registered bundle points at the isolated API');
    assert.ok(!source.includes(API_BASE_PLACEHOLDER) && !source.includes(CAPABILITY_PLACEHOLDER));
    assert.ok(source.includes(injector.capability), 'this start\'s own capability is the one in the bundle');
    assert.ok(!source.includes('http://127.0.0.1:4231/runs'), 'no production API path is left in the bundle');
    // The immediate evaluation must carry the very same source, not a second, different one.
    const evaluated = client.calls.filter(([m]) => m === 'Runtime.evaluate').map(([, p]) => p.expression);
    assert.ok(evaluated.includes(source), 'the isolated source is what is evaluated now');
  } finally { await injector.stop(); }
});

test('the CDP port gate still holds: a target on another port is never injected into', async () => {
  // Guards the production 9331 rail: an isolated run must not become a way to inject into a
  // window belonging to a different debugging endpoint.
  let listed = 0;
  const injector = startCdpInjector({
    port: ISO_CDP_PORT, scriptPath: CLIENT, apiBase: ISO_API_BASE, quiet: true,
    pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => { listed++; return [archonTarget('production', 9331), archonTarget('iso', ISO_CDP_PORT)]; },
    connect: (ws) => Promise.resolve({ ...fakeCdpClient(), ws }),
  });
  try {
    await waitForTarget(injector, 'iso');
    assert.ok(listed > 0, 'targets were enumerated');
    assert.ok(injector.target === 'iso', 'only the target whose ws port matches this injector is attached');
  } finally { await injector.stop(); }
});

test('every start gets its own random capability, held in memory only', async () => {
  const caps = [newCapability(), newCapability()];
  assert.notEqual(caps[0], caps[1], 'two capabilities are never equal');
  for (const cap of caps) assert.match(cap, /^[A-Za-z0-9_-]{16,256}$/);

  const first = startCdpInjector({ port: ISO_CDP_PORT, scriptPath: CLIENT, apiBase: ISO_API_BASE, quiet: true, pollMs: 3.6e6, retryMs: 3.6e6, listTargets: async () => [] });
  const second = startCdpInjector({ port: ISO_CDP_PORT, scriptPath: CLIENT, apiBase: ISO_API_BASE, quiet: true, pollMs: 3.6e6, retryMs: 3.6e6, listTargets: async () => [] });
  try {
    assert.notEqual(first.capability, second.capability, 'two injectors do not share a capability');
    assert.match(first.capability, /^[A-Za-z0-9_-]{16,256}$/);
    assert.ok(!newCapability().includes(ISO_API_BASE), 'the capability never carries the endpoint');
  } finally { await first.stop(); await second.stop(); }
});

test('constructing the host API binds nothing and hands out a fresh capability', async () => {
  const api = createHostApi({ roots: [], quiet: true });
  const other = createHostApi({ roots: [], quiet: true });
  try {
    assert.equal(api.server.listening, false, 'constructing the API must not bind a port');
    assert.equal(other.server.listening, false);
    assert.notEqual(api.capability, other.capability, 'each host API start gets its own capability');
    assert.match(api.capability, /^[A-Za-z0-9_-]{16,256}$/);
  } finally {
    await api.close();
    await other.close();
  }
});

test('listeningPort reports the port actually bound, and falls back only for an address-less double', () => {
  assert.equal(listeningPort({ address: () => ({ port: ISO_API_PORT }) }, API_PORT), ISO_API_PORT,
    'the real bound port wins over the requested one');
  assert.equal(listeningPort(null, API_PORT), API_PORT, 'a double with no address falls back to the requested port');
  assert.throws(() => listeningPort({ address: () => ({ port: 0 }) }, API_PORT), /listening port/);
  assert.throws(() => listeningPort(null, 'nonsense'), /listening port/);
});
