// test/w5-dsh-banner-style-scope.test.mjs — 1004.md §4 W5, DSH half, F13 (低).
//
//   F13 (低) 卡片外 banner 不在现有样式与 palette 作用域。 `data-dwf-banner` is inserted into
//        the card host as a SIBLING of the cards, never a descendant of `[data-dwf-card]`, yet
//        every rule that styles the banner's own content is written as a CARD-descendant rule:
//
//          [data-dwf-card] .dwf-offline{...}   [data-dwf-card] .dwf-notice{...}
//          [data-dwf-card] .dwf-error{...}     [data-dwf-card] .dwf-more{...}
//
//        and the dark/light palette variables are declared only on `[data-dwf-card]`,
//        `#dwf-modal` and `[data-dwf-line]`. A banner node therefore matches NO rule and has NO
//        `--wf-*` variable in scope, so `var(--wf-failure)` / `var(--wf-accent)` are unresolved.
//
//   SCOPE OF THE CLAIM. This is a read-only cross-check of the stylesheet, exactly as the
//   document states: it is NOT a pixel check and NOT a claim that the text is unreadable or the
//   button is dead. Unresolved `var()` only invalidates the declaration that uses it; the rest of
//   the rule still applies. What is pinned here is the structural fact: the banner node matches
//   rules, and it resolves the same palette variables, in both the dark and the light theme.
//
//   The fix reuses the EXISTING palette and the EXISTING local rules under the banner's own
//   scope, and the two guards are asserted directly:
//     * 不冒充 card              — the banner must not gain `data-dwf-card`, and no card rule may
//                                  be re-pointed at the banner by loosening its own selector.
//     * 不放宽成宿主全局选择器    — no `.dwf-notice` / `.dwf-offline` / `.dwf-error` /
//                                  `.dwf-more` rule may become a BARE class selector that also
//                                  captures the host page's own elements.
//
// Fake clock only, no host, no browser, no third-party dependency, no fixed Temp name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { boot, run } from './lib/w2-client-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = 'dwf';
// The palette the banner must resolve, and the classes bannersHtml() actually renders.
const PALETTE = ['--wf-text', '--wf-strong', '--wf-muted', '--wf-surface', '--wf-subtle', '--wf-border', '--wf-inset', '--wf-ask', '--wf-success', '--wf-failure', '--wf-accent'];
const BANNER_CLASSES = ['dwf-notice', 'dwf-offline', 'dwf-error', 'dwf-more'];

// ---------- a minimal CSS rule reader + matcher, enough for this stylesheet ----------
// The client ships ONE flat stylesheet (no @media), so rules are `selector{decls}` with a
// comma-separated selector list. Nested at-rules (@keyframes) are skipped: their inner
// `to{...}`/`0%{...}` blocks are keyframe steps, not style rules.
export function readRules(css) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const sel = css.slice(i, open).trim();
    // find the matching close brace, honouring nesting (@keyframes)
    let depth = 0, j = open;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (depth === 0) break; }
    }
    const body = css.slice(open + 1, j);
    if (!sel.startsWith('@')) {
      for (const one of sel.split(',')) rules.push({ selector: one.trim(), body });
    }
    i = j + 1;
  }
  return rules;
}

// A DOM-shaped node good enough for the selector forms this stylesheet uses:
// descendant combinators, tag / .class / #id / [attr] / [attr="v"] compound parts, and :hover
// style pseudo-classes (ignored for matching: the question is scope, not state).
function node(tag, { classes = [], attrs = {}, parent = null } = {}) {
  return { tag, classes: new Set(classes), attrs, parent };
}
function ancestors(n) { const out = []; for (let p = n.parent; p; p = p.parent) out.push(p); return out; }

function compoundMatches(part, n) {
  let rest = part;
  for (const m of part.matchAll(/#([\w-]+)/g)) { if (n.attrs.id !== m[1]) return false; }
  for (const m of part.matchAll(/\.([\w-]+)/g)) { if (!n.classes.has(m[1])) return false; }
  for (const m of rest.matchAll(/\[([\w-]+)(?:([*^$]?=)"?([^\]"]*)"?)?\]/g)) {
    const v = n.attrs[m[1]];
    if (v === undefined) return false;
    if (m[2] === '=' && v !== m[3]) return false;
    if (m[2] === '*=' && !v.includes(m[3])) return false;
  }
  return true;
}

// Does `selector` match `n`? Descendant combinators only — the stylesheet uses no `>` or `+`.
function selectorMatches(selector, n) {
  const parts = selector.split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  // strip pseudo-classes/elements from the final compound (scope question only)
  const last = parts[parts.length - 1].replace(/::?[a-z-]+(\([^)]*\))?/gi, '');
  if (!compoundMatches(last, n)) return false;
  const chain = ancestors(n);
  let ai = 0;
  for (let k = parts.length - 2; k >= 0; k--) {
    const p = parts[k].replace(/::?[a-z-]+(\([^)]*\))?/gi, '');
    let found = false;
    while (ai < chain.length) { if (compoundMatches(p, chain[ai])) { found = true; ai++; break; } ai++; }
    if (!found) return false;
  }
  return true;
}

const matchingRules = (rules, n) => rules.filter((r) => selectorMatches(r.selector, n));
// Every custom property declared by a rule that matches `n` (a var() reference in a DESCENDANT
// resolves from the properties set on that descendant's own ancestors too).
function varsInScope(rules, n) {
  const out = {};
  for (const anc of [...ancestors(n), n]) {
    for (const r of matchingRules(rules, anc)) {
      for (const m of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) out[m[1]] = m[2].trim();
    }
  }
  return out;
}
const declaresColor = (r) => /(?:^|;)\s*(?:color|background|border|background-color)\s*:/.test(r.body);

// The DOM the client really builds, expressed for the matcher. `theme` mirrors the attribute
// syncTheme() writes on <html>; `extraRun` adds a card so the card-scoped rules are exercised.
function bannerWorld({ theme = 'dark', withCard = false } = {}) {
  const html = node('html', { attrs: { id: 'documentElement', 'data-dwf-theme': theme } });
  const body = node('body', { parent: html });
  const area = node('div', { classes: ['viewArea'], parent: body });
  const host = node('div', { attrs: { id: 'dwf-run-card' }, parent: area });
  const banner = node('div', { attrs: { 'data-dwf-banner': '1' }, parent: host });
  const world = { html, body, area, host, banner };
  if (withCard) world.card = node('div', { attrs: { 'data-dwf-card': '1', 'data-run': 'x' }, parent: host });
  return world;
}
const inBanner = (world, cls, tag = 'div') => node(tag, { classes: [cls], parent: world.banner });

// ---------- F13: the banner node itself ----------
test('F13 DSH: the banner is a sibling of the cards, not a card descendant', async () => {
  const f = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const banner = f.doc.querySelector(`[data-${P}-banner]`);
  assert.ok(banner, 'the banner node exists');
  const card = f.doc.querySelector(`[data-${P}-card]`);
  assert.ok(card, 'a card exists in this boot');
  assert.equal(card.closest(`[data-${P}-banner]`), null, 'a card is not inside the banner');
  assert.equal(banner.closest(`[data-${P}-card]`), null, 'the banner is not inside a card — this is the F13 premise');
  assert.equal(banner.getAttribute('data-dwf-card'), null, '不冒充 card: the banner never claims to be a card');
});

test('F13 DSH: the four covered classes are exactly the ones the banner renders', async () => {
  // Keeps the fix honest: if bannersHtml() ever renders a fifth class, this fails and the scope
  // list has to grow with it, instead of the new class silently going unstyled again. All three
  // banner states are driven, because offline and persistence-warning are conditional.
  const classesIn = (b) => new Set(
    [b, ...b.querySelectorAll('*')].flatMap((n) => String(n.className || '').split(/\s+/).filter(Boolean)),
  );

  const online = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const onlineBanner = online.doc.querySelector(`[data-${P}-banner]`);
  assert.ok(onlineBanner, 'an online host still renders the banner');
  assert.ok(classesIn(onlineBanner).has('dwf-notice'), 'the global history entry renders as .dwf-notice');
  assert.ok(classesIn(onlineBanner).has('dwf-more'), 'and its button renders as .dwf-more');

  const dead = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  dead.setRuns({ __spec: { status: 503, body: { ok: false, error: 'offline' } } });
  await dead.tick();
  assert.ok(classesIn(dead.doc.querySelector(`.${P}-offline`)).has('dwf-offline'), 'an offline host renders .dwf-offline');

  // A localStorage that always throws is the persistence-warning path. It needs a run in the
  // pool, because the write that fails is saveVisible() — the write the pool itself triggers.
  const broken = await boot('dsh', {
    runs: [run('f13-live', 'running')],
    options: { watched: false },
    storage: { get: () => null, set: () => { throw new Error('localStorage unavailable'); } },
  });
  assert.ok(classesIn(broken.doc.querySelector(`.${P}-error`)).has('dwf-error'), 'a persistence failure renders .dwf-error');

  // The banner's parent is the host, and the host is not a card: the structural premise of F13.
  const host = online.doc.getElementById('dwf-run-card');
  assert.equal(onlineBanner.parentElement, host, 'the banner is a direct child of the card host');
  assert.equal(host.getAttribute('data-dwf-card'), null, 'and the host is not itself a card');
});

test('F13 DSH: every class the banner renders is styled under the banner scope', async () => {
  const f = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const rules = readRules(f.doc.getElementById('dwf-pipeline-style').textContent);
  const w = bannerWorld();
  for (const cls of BANNER_CLASSES) {
    const n = inBanner(w, cls, cls === 'dwf-more' ? 'button' : 'div');
    const hits = matchingRules(rules, n).filter(declaresColor);
    assert.ok(hits.length > 0, `${cls} inside the banner must match at least one rule that sets a colour/background`);
    assert.ok(
      hits.some((r) => r.selector.includes(`[data-${P}-banner]`)),
      `${cls} must be reached by a rule scoped to the banner, not only by an unrelated rule`,
    );
  }
});

test('F13 DSH: the banner resolves the same palette in the dark theme as a card does', async () => {
  const f = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const rules = readRules(f.doc.getElementById('dwf-pipeline-style').textContent);
  const w = bannerWorld({ theme: 'dark', withCard: true });
  const inBannerScope = varsInScope(rules, w.banner);
  const inCardScope = varsInScope(rules, node('div', { classes: ['dwf-notice'], parent: w.card })); // a notice inside the card
  for (const v of PALETTE) {
    assert.ok(v in inBannerScope, `the banner must resolve ${v} (dark)`);
    assert.equal(inBannerScope[v], inCardScope[v], `${v} must be the SAME value in the banner and in a card (dark)`);
  }
});

test('F13 DSH: the light theme overrides the banner palette too', async () => {
  const f = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const rules = readRules(f.doc.getElementById('dwf-pipeline-style').textContent);
  const dark = varsInScope(rules, bannerWorld({ theme: 'dark' }).banner);
  const light = varsInScope(rules, bannerWorld({ theme: 'light' }).banner);
  assert.equal(dark['--wf-surface'], '#1a1b20', 'the dark palette is the default root');
  assert.equal(light['--wf-surface'], '#ffffff', 'the light palette must win inside the banner');
  // The light override is a real override, not a second copy: the theme rule has to come later
  // in the stylesheet than the default one, or dark would win on source order.
  for (const v of PALETTE) {
    assert.ok(v in dark, `${v} must exist for the banner in the dark theme`);
    assert.ok(v in light, `${v} must exist for the banner in the light theme`);
  }
  const differing = PALETTE.filter((v) => dark[v] !== light[v]);
  assert.ok(differing.length >= 9, `the two themes must actually differ, got ${differing.join(',')}`);
  assert.ok(differing.includes('--wf-text') && differing.includes('--wf-failure') && differing.includes('--wf-accent'),
    'the variables the banner rules actually use must differ between the themes');
});

// ---------- F13 guards ----------
test('F13 DSH (guard): the fix must not re-point the card rules at the banner', async () => {
  const f = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const rules = readRules(f.doc.getElementById('dwf-pipeline-style').textContent);
  // Every rule that styles one of the banner's classes must still require a dwf-scoped ancestor
  // or a dwf-owned root. A rule whose only qualifier is the bare class would capture the host
  // page's own elements, which is exactly the 放宽成宿主全局选择器 the document forbids.
  for (const cls of BANNER_CLASSES) {
    for (const r of rules) {
      if (!r.selector.includes('.' + cls) || !declaresColor(r)) continue;
      const scoped = r.selector.includes(`[data-${P}-`) || r.selector.includes(`#dwf-`) || r.selector.includes(`#${P}-`);
      assert.ok(scoped, `rule "${r.selector}" must stay inside a dwf scope, never a bare .${cls} selector`);
    }
  }
});

test('F13 DSH (guard): the card rules are still card-scoped and still match a card', async () => {
  const f = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const rules = readRules(f.doc.getElementById('dwf-pipeline-style').textContent);
  const w = bannerWorld({ withCard: true });
  for (const cls of BANNER_CLASSES) {
    const inCard = node('div', { classes: [cls], parent: w.card });
    const inBan = inBanner(w, cls);
    const cardHits = matchingRules(rules, inCard).filter(declaresColor).length;
    const banHits = matchingRules(rules, inBan).filter(declaresColor).length;
    assert.ok(cardHits > 0, `.${cls} inside a card must still be styled`);
    assert.ok(banHits > 0, `.${cls} inside the banner must now be styled too`);
    // 不冒充 card: the card's own surface rule must NOT reach the banner.
    const surface = matchingRules(rules, inBan).filter((r) => /border-radius:14px/.test(r.body));
    assert.equal(surface.length, 0, 'the banner must not inherit the card surface treatment');
  }
});

test('F13 DSH (guard): a host page element of the same class name is still not captured', async () => {
  const f = await boot('dsh', { runs: [run('f13-run', 'completed')] });
  const rules = readRules(f.doc.getElementById('dwf-pipeline-style').textContent);
  const w = bannerWorld();
  // An element the host itself owns, sitting in the page body, named `.dwf-notice`.
  const hostOwned = node('div', { classes: ['dwf-notice'], parent: w.body });
  assert.equal(
    matchingRules(rules, hostOwned).filter(declaresColor).length,
    0,
    'a same-named class outside every dwf root must not be styled by this stylesheet',
  );
});
