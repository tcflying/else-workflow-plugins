// test/iso/iso-sidecar.mjs — isolated sidecar thin shell for UI verification.
//
// What it is: a long-lived test wrapper that imports the REAL sidecar primitives
// (createHostApi / startCdpInjector / buildInjectSource from ../../sidecar.mjs) and wires them to
// a NON-PRODUCTION, loopback-only endpoint pair. It exists because the production sidecar is
// fixed at API 4231 / CDP 9331 and belongs to the project lead's own instance: the isolation
// acceptance run must be able to point the client at a different host without touching that one.
//
// What it deliberately is NOT: it is not a launcher. It never starts, kills, reloads or restarts
// MiniMax Code, it never copies credentials, and it refuses --launch / kill flags outright. The
// project lead launches the isolated instance (test/iso/launch-isolated.ps1) and starts this
// wrapper under process-compose.
//
// Injection is owned here and nowhere else: the inspector is read-only, so this is the single
// place where a client bundle may reach a renderer.
//
// Run: node test/iso/iso-sidecar.mjs --cdp-port 19331 --root <dir>... [--manifest <file>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHostApi, startCdpInjector, buildInjectSource, requireNode22, connectCdp } from '../../sidecar.mjs';
import {
  parseStrictArgs, assertCdpPortAllowed, assertEphemeralApiPort, assertInjectedApiBase,
  assertInsideArtifacts, apiBaseFor, isDirectRun, readIsolationProof, ARTIFACTS, FIXTURES,
  CLIENT_SCRIPT, LAUNCH_STATE_FILE, IsolationRefused,
} from './iso-guard.mjs';
import { createObserver } from './iso-observer.mjs';

const SPEC = {
  '--cdp-port': String,
  '--root': [],
  '--launch-state': String,
  '--observe': String,
  '--manifest': String,
  '--poll-ms': String,
  '--require-attach': String,
  '--quiet': 'boolean',
};

const USAGE = `mmx UI-isolation sidecar (test-only thin shell)
  node test/iso/iso-sidecar.mjs --cdp-port <port> --root <dir> [--root <dir>...] [options]

  --cdp-port <port>  REQUIRED. The isolated MiniMax CDP port. 4231 / 9331 / 19080 are refused.
  --root <dir>       Optional, repeatable, and restricted to the isolation artifacts directory
                     (default test/artifacts/ui-isolation/fixtures). The real workspace's run
                     history is out of scope for this run, so --root cannot point outside it.
  --launch-state <file>
                     The launch report to gate on (default test/artifacts/ui-isolation/launch-isolated.json,
                     written by launch-isolated.ps1). Refused unless it proves backend isolation for
                     THIS live instance: backendIsolationProven true, pid alive, startTime taken from
                     Process.StartTime, and debugPort equal to --cdp-port. It ALSO requires a LIVE,
                     read-only identity observation (pid, actual UTC start time, exe, the pid that
                     owns the debug port right now, and the two isolation paths), all compared for
                     exact equality — a self-declared flag, a pid-existence probe or the report's own
                     historical listener snapshot would each accept a recycled pid. WITHOUT --observe
                     the run is REFUSED at that point rather than injecting on a weaker check.
  --observe <file>   Turns the live identity gate ON: it must name the SAME launch report as
                     --launch-state (two different reports could certify two different instances).
                     The observation itself is test/iso/iso-observer.mjs: one read-only
                     Get-CimInstance query for one pid, one read-only Get-NetTCPConnection query for
                     one port, and one bounded read-only directory scan. It starts nothing, stops
                     nothing and binds nothing. The identity is ALSO re-verified before every attach
                     and re-attach, so an instance that is replaced mid-run stops the injector
                     instead of injecting into whatever took its place.
  --poll-ms <n>      Injector target re-check interval (default 10000).
  --require-attach <ms>
                     Bounded wait (default 0 = off) for a REAL app://./archon target to register.
                     Startup is never success on its own: with no target the injector only retries
                     silently, so this flag makes a timeout exit 4 and say so in the manifest.
  --quiet            Suppress the per-line progress log.
  --help

The injected bundle is always the packaged client-inject.js; there is deliberately no flag to point
it at another file. The host API always binds 127.0.0.1:0 (ephemeral). The real port is read back
from the server and written to the manifest; production 4231 is never bound. This process never
launches or kills an application and never prints the capability.`;

// Bounded shutdown: SIGINT/SIGTERM stop the injector (which revokes its page registration) and
// close the listener. If cleanup does not finish inside the deadline the exit code says so instead
// of pretending the renderer is clean.
const SHUTDOWN_DEADLINE_MS = 15000;

export function parseIsoArgs(argv) {
  const args = parseStrictArgs(argv, SPEC, { name: 'iso-sidecar' });
  if (args.help) return { help: true };
  if (!args['--cdp-port']) throw new IsolationRefused('iso-sidecar: --cdp-port is required; this suite refuses to guess a port');
  const cdpPort = assertCdpPortAllowed(args['--cdp-port']);
  // Scan roots stay inside the isolation artifacts. Reading the real workspace's run history is out
  // of scope for this run, so --root cannot be pointed anywhere else — including the repository root.
  const roots = (args['--root'].length ? args['--root'] : [FIXTURES]).map((root) => assertInsideArtifacts(root, 'scan root'));
  const pollMs = args['--poll-ms'] ? Number(args['--poll-ms']) : 10000;
  if (!Number.isFinite(pollMs) || pollMs < 1000 || pollMs > 60000) {
    throw new IsolationRefused('iso-sidecar: --poll-ms must be 1000..60000');
  }
  const manifest = args['--manifest']
    ? assertInsideArtifacts(args['--manifest'], 'manifest path')
    : assertInsideArtifacts(`${ARTIFACTS}/iso-sidecar.manifest.json`, 'manifest path');
  const requireAttachMs = args['--require-attach'] ? Number(args['--require-attach']) : 0;
  if (!Number.isInteger(requireAttachMs) || requireAttachMs < 0 || requireAttachMs > 120000) {
    throw new IsolationRefused('iso-sidecar: --require-attach must be 0..120000 ms');
  }
  const launchState = args['--launch-state']
    ? assertInsideArtifacts(args['--launch-state'], 'launch report path')
    : LAUNCH_STATE_FILE;
  const observeState = args['--observe']
    ? assertInsideArtifacts(args['--observe'], 'observed launch report path')
    : null;
  // The gate compares a live observation against the launch report. If the observation were read
  // from a DIFFERENT file, it would be describing a different instance and the comparison would be
  // meaningless — so the two paths must be the same one.
  if (observeState && !samePathString(observeState, launchState)) {
    throw new IsolationRefused(`iso-sidecar: --observe (${observeState}) must be the same launch report as --launch-state (${launchState}); two reports could describe two different instances`);
  }
  return {
    help: false,
    cdpPort,
    roots,
    // Fixed, not configurable: one injectable bundle, the packaged one.
    clientPath: CLIENT_SCRIPT,
    manifest,
    launchState,
    // null means "no live observer": the guard's own default refusal stands, unchanged.
    observeState,
    pollMs,
    requireAttachMs,
    quiet: args['--quiet'] === true,
  };
}

const samePathString = (a, b) => {
  const norm = (p) => {
    const s = resolve(String(p));
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
};

// The manifest is how process-compose and the inspector learn the ephemeral API port without
// anybody parsing a log line. It carries endpoints and paths only — never the capability.
export function manifestPayload({ pid, apiPort, cdpPort, apiBase, roots, clientPath, attached = null, identity = null, identityRevoked = null }) {
  return {
    kind: 'mmx-ui-isolation-sidecar',
    isolated: true,
    pid,
    apiPort,
    apiBase,
    cdpPort,
    roots,
    clientPath,
    // null = unknown / still waiting. Startup is NOT success: with no app://./archon target the
    // injector only retries silently, so this field is the honest registration state.
    attached,
    // The live identity the injector last attached under, or null when no observer was supplied.
    // Non-secret identity facts only, exactly the set the gate compares.
    identity,
    // Set when a re-verification revoked the identity mid-run. A non-null value means the injector
    // was stopped rather than left retrying against whatever took the instance's place.
    identityRevoked,
    productionPortsRefused: [4231, 9331, 19080],
    note: 'ephemeral loopback host API + isolated CDP; no launcher, no capability in this file',
    startedAt: new Date().toISOString(),
  };
}

/**
 * Wrap the CDP connector so the live identity is RE-VERIFIED before every attach and re-attach.
 *
 * Why here and not once at startup: the injector outlives the check. A target can appear minutes
 * later, the socket can drop and be re-established, and the instance behind the port can be stopped
 * and replaced by another process in between. A proof taken once at startup authorises an injection
 * that happens arbitrarily much later, which is the recycled-pid failure the whole gate exists to
 * prevent. `connect` is the last call the injector makes before a single byte can reach a renderer,
 * so this is the narrowest place a re-proof can still stop it.
 *
 * The re-verification is SYNCHRONOUS and it rethrows. The injector wraps connect() in a bounded()
 * helper that converts any throw into a rejection, which is exactly what we want: no socket is
 * opened, no renderer is contacted, and the injector falls back to its retry path.
 */
export function createRevalidatedConnector({ launchState, cdpPort, observe, connect, onVerified = () => {}, onRevoked = () => {} } = {}) {
  const connectImpl = connect || connectCdp;
  return (wsUrl, options) => {
    let proof;
    try {
      proof = readIsolationProof(launchState, { cdpPort, observe });
    } catch (error) {
      onRevoked(error);
      throw error;
    }
    onVerified(proof);
    return connectImpl(wsUrl, options);
  };
}

// Bounded, real confirmation that a renderer actually REGISTERED the bundle. Polls the injector's
// own attached target — the same handle the injector sets only after Page.addScript… was confirmed
// and window.__mmxDwfInstalled read back true — instead of treating process startup as success.
async function waitForAttachedTarget(injector, timeoutMs, pollMs = 250, revoked = () => null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const target = injector.target;
    if (target) return target;
    // A revoked identity ends the wait immediately: there is nothing left that could legitimately
    // register, and waiting out the full timeout would report a symptom instead of the cause.
    if (revoked()) return null;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

export async function startIsoSidecar(options, host = process, deps = {}) {
  const { cdpPort, roots, clientPath, manifest, pollMs, requireAttachMs, launchState, observeState, quiet } = options;
  requireNode22();
  const log = (...a) => { if (!quiet) console.log('[iso-sidecar]', ...a); };

  // The observer is the CLI's answer to the gate. `--observe <report>` builds the real one; a test
  // may inject its own. With neither, `observe` stays null and the guard's DEFAULT refusal stands —
  // that default is a guard and this line does not weaken it.
  const observe = deps.observe || (observeState ? createObserver({ launchState: observeState, cdpPort }) : null);

  // The proof runs BEFORE anything is created: no listener, no capability, no injection. Launching
  // the isolated instance does not need this tool, so a launcher-only run stays possible.
  const proof = readIsolationProof(launchState, { cdpPort, observe });
  log(`live identity verified (pid ${proof.pid}, started ${proof.startTimeUtc})`);

  const createApi = deps.createHostApi || createHostApi;
  const startInjector = deps.startCdpInjector || startCdpInjector;
  const api = createApi({ roots, scriptPath: clientPath, quiet: true });
  let injector = null;
  try {
    // 127.0.0.1:0 — the OS picks, then we re-check the result. A lucky draw of a reserved port
    // aborts here instead of serving on production's port.
    const server = await api.start(0);
    const apiPort = assertEphemeralApiPort(server.address().port, cdpPort);
    const apiBase = apiBaseFor(apiPort);
    log(`host API listening on ${apiBase} (roots: ${roots.join(', ')})`);

    // Prove the retarget before a single byte reaches a renderer: build the exact source the
    // injector will send — same scriptPath, same builder, same capability — and refuse if it still
    // points at production.
    const built = buildInjectSource(readFileSync(clientPath, 'utf8'), api.capability, apiBase);
    assertInjectedApiBase(built, apiBase);

    // The manifest is written BEFORE the attach wait and BEFORE the injector exists, so neither a
    // timeout nor a crash can leave a previous run's manifest (which may still say attached)
    // sitting on disk as if it described this one.
    const identity = { pid: proof.pid, startTimeUtc: proof.startTimeUtc, exe: proof.exe };
    const state = { identityRevoked: null };
    const writeManifest = (attachedState) => {
      mkdirSync(dirname(manifest), { recursive: true });
      writeFileSync(manifest, JSON.stringify(manifestPayload({
        pid: host.pid, apiPort, cdpPort, apiBase, roots, clientPath, attached: attachedState,
        identity, identityRevoked: state.identityRevoked,
      }), null, 2) + '\n');
    };
    writeManifest(requireAttachMs > 0 ? false : null);

    injector = startInjector({
      port: cdpPort,
      scriptPath: clientPath,
      capability: api.capability,
      apiBase,
      quiet: true,
      pollMs,
      // Every attach re-proves the identity. This is the real option name the injector reads, not a
      // same-shaped lookalike.
      connect: createRevalidatedConnector({
        launchState, cdpPort, observe, connect: deps.connect,
        onRevoked: (error) => {
          if (state.identityRevoked) return;
          state.identityRevoked = error.message;
          // Loud even under --quiet: a revoked identity is the reason a run died, and a silent run
          // that stops injecting looks exactly like a run that is merely idle.
          console.error('[iso-sidecar] IDENTITY REVOKED — the injector has been stopped:', error.message);
          try { writeManifest(false); } catch {}
          // Deferred on purpose: injector.stop() awaits the in-flight attach, and this callback
          // runs FROM inside that attach. Calling it synchronously would deadlock on itself.
          const timer = setTimeout(() => { try { injector && injector.stop(); } catch {} }, 0);
          timer.unref?.();
        },
      }),
    });

    // Registration confirmation. Off by default so the wrapper can start before the app exists;
    // the project lead turns it on for acceptance runs, where a missing target must fail loudly.
    let attached = null;
    if (requireAttachMs > 0) {
      attached = await waitForAttachedTarget(injector, requireAttachMs, 250, () => state.identityRevoked);
      if (!attached) {
        writeManifest(false);
        const error = state.identityRevoked
          ? new Error(`IDENTITY_REVOKED: ${state.identityRevoked}`)
          : new Error(`NO_TARGET_REGISTERED: no app://./archon target on CDP ${cdpPort} registered the client within ${requireAttachMs}ms; the injector is only retrying silently and this run proves nothing`);
        error.exitCode = state.identityRevoked ? 5 : 4;
        throw error;
      }
      log(`renderer target registered: ${attached}`);
    }
    writeManifest(attached);
    log(`manifest written: ${manifest}`);

    let closing = null;
    const shutdown = () => closing ||= (async () => {
      const errors = [];
      try { await injector.stop(); } catch (error) { errors.push(String(error && error.message || error)); }
      try { await api.close(); } catch (error) { errors.push(String(error && error.message || error)); }
      if (state.identityRevoked) errors.push(`IDENTITY_REVOKED: ${state.identityRevoked}`);
      if (errors.length) throw new AggregateError(errors, 'isolation sidecar cleanup did not finish completely');
      return { cleaned: true, errors: [], identityRevoked: state.identityRevoked };
    })();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      host.on(signal, () => {
        const timer = setTimeout(() => { host.exitCode = 1; }, SHUTDOWN_DEADLINE_MS);
        timer.unref?.();
        shutdown()
          .then(() => { clearTimeout(timer); host.exitCode = state.identityRevoked ? 5 : 0; })
          .catch((error) => { console.error('[iso-sidecar] shutdown:', error.message); host.exitCode = 1; });
      });
    }
    return { api, injector, apiBase, apiPort, cdpPort, manifest, attached, identity, shutdown };
  } catch (error) {
    try { if (injector) await injector.stop(); } catch {}
    await api.close().catch(() => {});
    throw error;
  }
}

if (isDirectRun(import.meta.url)) {
  let options = null;
  try { options = parseIsoArgs(process.argv.slice(2)); }
  catch (error) {
    // A synchronous refusal (a bad flag, an escaping path) must not escape as an unhandled throw.
    console.error('[iso-sidecar]', error.name === 'IsolationRefused' ? 'REFUSED:' : 'failed:', error.message);
    process.exitCode = 2;
  }
  if (options && options.help) { console.log(USAGE); }
  else if (options) {
    startIsoSidecar(options).catch((error) => {
      console.error('[iso-sidecar]', error.name === 'IsolationRefused' ? 'REFUSED:' : 'failed:', error.message);
      process.exitCode = error.exitCode || 2;
    });
  }
}