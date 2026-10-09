// test/iso/iso-inspect.mjs — bounded, read-only CDP forensics for the isolation run.
//
// Answers one question with evidence: is the EXPECTED FIXTURE's workflow card actually present in
// the CHAT surface, with a named stage list and concrete task labels? Everything reported comes from
// the rendered DOM of the renderer it was pointed at.
//
// Hard boundaries (each one is a refusal or an omission, not a convention):
//   * it connects ONLY to the CDP port the caller names, and only to a target whose URL is exactly
//     app://./archon (hash/search variants included) on that same port — the check reuses the
//     sidecar's own isInjectableTarget, so a helper page or a foreign ws host is never inspected;
//   * every CDP command is deadline-bounded; no unbounded wait, no poll loop;
//   * it READS. No DOM mutation, no localStorage/sessionStorage access of any kind (not even a
//     read), no click, no scroll, no navigation, and it creates no run. Injection is the sidecar
//     thin shell's job (test/iso/iso-sidecar.mjs). The result / "允许结果" entry is clicked by the
//     project lead in the isolated instance, never by this tool; re-running this afterwards is how
//     that click gets evidenced;
//   * PASS requires an EXACT fixture identity match (the expected run id inside data-run plus the
//     non-business marker inside the run name). Any other card does not pass, and the global history
//     entry is explicitly not chat evidence;
//   * it reads NO conversation body and NO host identity: only counts, selectors and the workflow
//     card's own labels. The result panel is reduced to a character count instead of its text;
//   * if the surface shows a password input (a login screen), the screenshot is NOT written at all
//     and the report degrades to counts, so no credential surface is captured to disk;
//   * raw CDP traffic is never printed; the capability is not part of any query.
//
// A missing message-list, a missing in-conversation card, or a card that is not the expected
// fixture yields verdict BLOCKED (exit 3). It never fabricates DOM to manufacture a pass.
//
// Run: node test/iso/iso-inspect.mjs --cdp-port 19331 --expect-fixture-id ui-iso-fixture-0001
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectCdp, pickPageTarget, isInjectableTarget, runKeyFor } from '../../sidecar.mjs';
import {
  parseStrictArgs, assertCdpPortAllowed, assertInsideArtifacts, assertFixtureId, isDirectRun,
  redact, ARTIFACTS, FIXTURES, FIXTURE_LABEL, IsolationRefused,
} from './iso-guard.mjs';

const SPEC = {
  '--cdp-port': String,
  '--expect-fixture-id': String,
  '--fixture-root': String,
  '--out': String,
  '--timeout-ms': String,
  '--quiet': 'boolean',
};

const USAGE = `mmx UI-isolation inspector (read-only)
  node test/iso/iso-inspect.mjs --cdp-port <port> --expect-fixture-id <id> [--out <dir>] [--timeout-ms <ms>]

  --cdp-port <port>        REQUIRED. Isolated MiniMax CDP port. 4231 / 9331 / 19080 are refused.
  --expect-fixture-id <id> REQUIRED. Only this fixture may produce PASS.
  --fixture-root <dir>   Fixtures root, default test/artifacts/ui-isolation/fixtures; must stay inside
                         the isolation artifacts directory. The expected runKey is DERIVED from it
                         with the sidecar's own runKeyFor() — never guessed from a hash pattern.
  --out <dir>              Screenshot directory (default test/artifacts/ui-isolation).
  --timeout-ms <n>         Per-command deadline, 500..30000 (default 8000).
  --quiet                  Do not print the JSON summary (the screenshot is still written).

Exit: 0 verdict PASS, 2 refused/failed, 3 verdict BLOCKED.`;

export function parseInspectArgs(argv) {
  const args = parseStrictArgs(argv, SPEC, { name: 'iso-inspect' });
  if (args.help) return { help: true };
  if (!args['--cdp-port']) throw new IsolationRefused('iso-inspect: --cdp-port is required; this tool never guesses an endpoint');
  if (!args['--expect-fixture-id']) {
    throw new IsolationRefused('iso-inspect: --expect-fixture-id is required; without an expected identity any card could pass and that would prove nothing');
  }
  const timeoutMs = args['--timeout-ms'] ? Number(args['--timeout-ms']) : 8000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) {
    throw new IsolationRefused('iso-inspect: --timeout-ms must be 500..30000');
  }
  return {
    help: false,
    cdpPort: assertCdpPortAllowed(args['--cdp-port']),
    expectFixtureId: assertFixtureId(args['--expect-fixture-id']),
    fixtureRoot: args['--fixture-root'] ? assertInsideArtifacts(args['--fixture-root'], 'fixtures root') : FIXTURES,
    expectLabel: FIXTURE_LABEL,
    out: args['--out'] ? assertInsideArtifacts(args['--out'], 'out directory') : ARTIFACTS,
    timeoutMs,
    quiet: args['--quiet'] === true,
  };
}

// The identity of the fixture under inspection, derived the same way the host API derives it.
// client-inject.js identity() is `(run.runKey || run.runId)` and the host API attaches a sha256
// runKey computed from the run directory's real path, so data-run in a real reading is that 64-hex
// key — not a composite string and not the runId. So the expected key is computed here with the
// sidecar's own runKeyFor() and compared for exact equality; nothing is inferred from a hash shape.
export function expectedFixtureIdentity({ fixtureId, fixtureRoot = FIXTURES }) {
  assertFixtureId(fixtureId);
  const root = assertInsideArtifacts(fixtureRoot, 'fixtures root');
  const dir = assertInsideArtifacts(join(root, '.qoder', 'workflow-runs', fixtureId), 'fixture run directory');
  return {
    fixtureId,
    dir,
    exists: existsSync(join(dir, 'progress.json')),
    runKey: runKeyFor(dir),
    runName: `${FIXTURE_LABEL}·${fixtureId}`,
  };
}

// One pure DOM read. Rendered nodes and attributes only: no write, no storage call, no navigation,
// and it returns counts plus workflow labels — never conversation text and never host identity.
export const PROBE_EXPRESSION = `(() => {
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '');
  const attr = (el, name) => (el && el.getAttribute ? (el.getAttribute(name) || '') : '');
  const messageList = document.querySelector('[data-testid="message-list"]');
  const cards = Array.from(document.querySelectorAll('[data-mmxdwf-card]'));
  return {
    route: String(location.protocol + '//' + location.host + location.pathname),
    installed: window.__mmxDwfInstalled === true,
    version: typeof window.__mmxDwfVersion === 'number' ? window.__mmxDwfVersion : 0,
    passwordInputCount: document.querySelectorAll('input[type="password"]').length,
    messageListCount: document.querySelectorAll('[data-testid="message-list"]').length,
    messageListChildCount: messageList ? messageList.children.length : 0,
    globalEntryCount: document.querySelectorAll('#mmxdwf-global-entry').length,
    cardHostCount: document.querySelectorAll('#mmxdwf-run-card').length,
    cardCount: cards.length,
    cards: cards.slice(0, 8).map((c) => {
      const agents = Array.from(c.querySelectorAll('.mmxdwf-ag'));
      const phases = Array.from(c.querySelectorAll('.mmxdwf-pcol'));
      const resultEl = c.querySelector('.mmxdwf-result');
      return {
        run: attr(c, 'data-run'),
        inConversation: !!c.closest('[data-testid="message-list"]'),
        title: txt(c.querySelector('.mmxdwf-title')).slice(0, 80),
        runName: txt(c.querySelector('.mmxdwf-runname')).slice(0, 120),
        stats: txt(c.querySelector('.mmxdwf-stats')).slice(0, 120),
        unbound: !!c.querySelector('.mmxdwf-unbound'),
        subtaskCount: agents.length,
        subtasks: agents.slice(0, 12).map((a) => ({
          label: txt(a.querySelector('.mmxdwf-lb')).slice(0, 80),
          state: txt(a.querySelector('.mmxdwf-agst')).slice(0, 24),
        })),
        phaseCount: phases.length,
        phases: phases.slice(0, 12).map((p) => {
          const m = /\\b(done|now|failed|rejected|partial)\\b/.exec(p.className || '');
          return {
            name: txt(p.querySelector('.mmxdwf-pname')).slice(0, 80),
            counts: txt(p.querySelector('.mmxdwf-pc')).slice(0, 40),
            state: m ? m[1] : 'unknown',
          };
        }),
        hasResultPanel: !!resultEl,
        resultChars: resultEl ? txt(resultEl).length : 0,
        notices: Array.from(c.querySelectorAll('.mmxdwf-error, .mmxdwf-notice')).map((n) => txt(n).slice(0, 120)),
        actions: Array.from(c.querySelectorAll('[data-act]')).map((b) => attr(b, 'data-act')).slice(0, 12),
      };
    }),
  };
})()`;

// A label with no readable task name is a generic glyph, not progress evidence.
const GENERIC_LABEL = /^[\s\p{P}\p{S}]*$/u;

// A runKey is a directory hash, not a secret. The report keeps enough of it to PROVE the match —
// a stable prefix and suffix plus the boolean — instead of a redaction that would erase the evidence.
export const maskRunKey = (key) => {
  const k = String(key ?? '');
  return /^[0-9a-f]{64}$/.test(k) ? `${k.slice(0, 8)}…${k.slice(-8)}` : '(not a 64-hex runKey)';
};

// Exact identity, not "some card", and not a substring:
//   1. data-run must equal the runKey computed by runKeyFor() for this fixture's run directory —
//      character for character. A different run, a lookalike id, or a prefix/suffix variant fails;
//   2. the run NAME must equal the fixture name character for character, so `…-0001-evil` cannot
//      satisfy it either.
export function cardMatchesIdentity(card, expect) {
  if (!card || !expect || !expect.fixtureId || !expect.runKey) return false;
  if (String(card.run ?? '') !== expect.runKey) return false;
  const expectedName = expect.runName || (expect.label ? `${expect.label}·${expect.fixtureId}` : String(expect.fixtureId));
  return String(card.runName ?? '') === expectedName;
}

// The verdict is a pure function of (probe, expect) so the negative cases are unit-testable. There
// is exactly one way to PASS and it is narrow: client installed, a real conversation surface, and
// the EXPECTED fixture card inside that surface with a named stage and at least one concrete task
// label. Everything short of that is BLOCKED with a stated reason.
export function classify(probe, expect = {}) {
  const reasons = [];
  const p = probe || {};
  const cards = Array.isArray(p.cards) ? p.cards : [];
  const chatCards = cards.filter((c) => c && c.inConversation);
  if (!expect.fixtureId) reasons.push('EXPECT_IDENTITY_REQUIRED: no expected fixture id was supplied, so no card could be accepted as proof');
  if (!expect.runKey) reasons.push('EXPECT_RUNKEY_REQUIRED: no expected runKey was derived from the fixture directory, so data-run could not be compared for exact equality');
  if (!p.installed) reasons.push('CLIENT_NOT_INSTALLED: window.__mmxDwfInstalled is not true in this renderer');
  if (!(Number(p.messageListCount) > 0)) reasons.push(`NO_MESSAGE_LIST: [data-testid="message-list"] count=${Number(p.messageListCount) || 0} — this route has no conversation surface, so chat rendering is unproven`);
  if (!cards.length) reasons.push(`NO_CARD: [data-mmxdwf-card] count=0`);
  if (cards.length && !chatCards.length) {
    reasons.push('CARD_NOT_IN_CONVERSATION: a card exists but none is inside [data-testid="message-list"] (the global history entry is not chat evidence)');
  }
  const matched = chatCards.filter((c) => cardMatchesIdentity(c, expect));
  if (expect.fixtureId && chatCards.length && !matched.length) {
    reasons.push(`IDENTITY_MISMATCH: ${chatCards.length} in-conversation card(s), none whose data-run equals the runKey derived for ${expect.fixtureId}; another card cannot stand in for it`);
  }
  const card = matched[0] || null;
  const phaseNames = (card?.phases || []).map((x) => x && x.name).filter(Boolean).filter((n) => !GENERIC_LABEL.test(n));
  const taskLabels = (card?.subtasks || []).map((x) => x && x.label).filter(Boolean).filter((l) => !GENERIC_LABEL.test(l));
  if (card && !phaseNames.length) reasons.push('NO_NAMED_STAGE: the fixture card shows no stage name, so progress cannot be identified');
  if (card && !taskLabels.length) reasons.push('NO_TASK_LABEL: the fixture card shows no concrete task label (glyphs/icons only), so per-task progress cannot be identified');
  return {
    verdict: reasons.length ? 'BLOCKED' : 'PASS',
    reasons,
    expectedFixtureId: expect.fixtureId || null,
    expectedRunKey: expect.runKey ? maskRunKey(expect.runKey) : null,
    evidence: {
      installed: p.installed === true,
      version: Number(p.version) || 0,
      messageListCount: Number(p.messageListCount) || 0,
      messageListChildCount: Number(p.messageListChildCount) || 0,
      cardCount: Number(p.cardCount) || 0,
      chatCardCount: chatCards.length,
      identityMatchedCardCount: matched.length,
      globalEntryCount: Number(p.globalEntryCount) || 0,
      cardRunKeys: chatCards.map((c) => maskRunKey(c.run)),
      matchedRunKeyMatchesExpected: Boolean(card) && String(card.run) === String(expect.runKey),
      matchedRunKey: card ? maskRunKey(card.run) : null,
      matchedRunName: card ? redact(card.runName, 120) : null,
      unbound: card ? card.unbound === true : null,
      phaseNames: [...new Set(phaseNames)],
      taskLabels: [...new Set(taskLabels)],
      hasResultPanel: card ? card.hasResultPanel === true : null,
      resultChars: card ? Number(card.resultChars) || 0 : null,
    },
  };
}

// A bounded send: the deadline is enforced here, so a wedged renderer cannot hang the tool.
function bounded(client, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    client.send(method, params).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// The real network dependency. Named distinctly from the local binding below: a default that closed
// over its own name would recurse into itself instead of reaching this function.
export async function fetchTargets(port, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// Selects the dependencies, so the DEFAULT (no injected deps) path is explicit rather than a
// self-referential closure. Exported so the default wiring itself is unit-testable — asserting only
// an injected `deps` would never exercise this selection.
export function selectDeps(deps = {}) {
  return {
    listTargets: deps.listTargets || fetchTargets,
    connect: deps.connect || ((wsUrl, options) => connectCdp(wsUrl, options)),
  };
}

export async function inspect(options, deps = {}) {
  const { cdpPort, out, timeoutMs } = options;
  // Derive the expected identity from the fixture directory itself, with the sidecar's own
  // runKeyFor() — so both the fixture writer and this inspector agree on the path by construction.
  const identity = expectedFixtureIdentity({ fixtureId: options.expectFixtureId, fixtureRoot: options.fixtureRoot });
  const expect = { fixtureId: identity.fixtureId, label: options.expectLabel, runKey: identity.runKey, runName: identity.runName };
  const { listTargets, connect } = selectDeps(deps);
  const list = await listTargets(cdpPort, timeoutMs);
  const target = pickPageTarget(list, { port: cdpPort });
  if (!target || !isInjectableTarget(target, cdpPort)) {
    return {
      ok: false, verdict: 'BLOCKED', cdpPort,
      reasons: ['NO_ARCHON_TARGET: no app://./archon target on the named isolated CDP port'],
      evidence: { targetFound: false },
      targetsSeen: (Array.isArray(list) ? list : []).map((t) => redact(t && t.url, 120)),
    };
  }
  const client = await connect(target.webSocketDebuggerUrl, { timeoutMs, onError: () => {}, onClose: () => {} });
  try {
    const evaluated = await bounded(client, 'Runtime.evaluate', {
      expression: PROBE_EXPRESSION, returnByValue: true, awaitPromise: false,
    }, timeoutMs);
    if (evaluated?.exceptionDetails) throw new Error('probe raised an exception in the page');
    const probe = evaluated?.result?.value || {};
    const verdict = classify(probe, expect);
    let screenshot = null, screenshotBytes = 0, screenshotSkipped = null;

    // A login / credential surface is never written to disk. Counts only.
    if (Number(probe.passwordInputCount) > 0) {
      screenshotSkipped = 'CREDENTIAL_SURFACE: the target shows a password input (login screen); no screenshot was captured';
    } else {
      const shot = await bounded(client, 'Page.captureScreenshot', { format: 'png' }, timeoutMs);
      const data = shot && shot.data;
      if (typeof data !== 'string' || !data) throw new Error('Page.captureScreenshot returned no image data');
      mkdirSync(out, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(out, `iso-inspect-${stamp}.png`);
      const png = Buffer.from(data, 'base64');
      writeFileSync(file, png);
      screenshot = file;
      screenshotBytes = png.length;
    }
    return {
      ok: verdict.verdict === 'PASS',
      cdpPort,
      route: redact(probe.route, 120),
      screenshot,
      screenshotBytes,
      screenshotSkipped,
      ...verdict,
      cards: (Array.isArray(probe.cards) ? probe.cards : []).map((c) => ({
        run: redact(c.run, 80), inConversation: c.inConversation, title: redact(c.title, 80),
        runName: redact(c.runName, 120), stats: redact(c.stats, 120), unbound: c.unbound,
        subtaskCount: c.subtaskCount, phaseCount: c.phaseCount,
        hasResultPanel: c.hasResultPanel, resultChars: c.resultChars,
        actions: c.actions, notices: (c.notices || []).map((n) => redact(n, 120)),
      })),
    };
  } finally {
    try { client.close(); } catch {}
  }
}

if (isDirectRun(import.meta.url)) {
  const options = parseInspectArgs(process.argv.slice(2));
  if (options.help) { console.log(USAGE); }
  else {
    inspect(options).then((report) => {
      if (!options.quiet) console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.verdict === 'PASS' ? 0 : 3;
    }).catch((error) => {
      console.error('[iso-inspect]', error.name === 'IsolationRefused' ? 'REFUSED:' : 'failed:', error.message);
      process.exitCode = 2;
    });
  }
}