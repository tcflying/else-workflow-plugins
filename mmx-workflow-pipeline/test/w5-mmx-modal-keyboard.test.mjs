// test/w5-mmx-modal-keyboard.test.mjs — 1004.md §4 W5, MMX half: F07.
//
//   F07 (中) MMX 弹窗与历史展开键盘闭环缺失。
//        触发边界（原文）：脚本/结果/历史 modal 不移入焦点、无 Escape、无 Tab 限制、无焦点恢复；
//        `focusInside=false, focusCalls=0, ariaModal=null`，合成 Escape 后 display 仍 flex。
//        **未做实际浏览器 Tab/屏幕阅读器验收**。
//
//   Root cause re-checked against the CURRENT source (client-inject.js):
//     * `ensureModal()` creates a `role="dialog"` overlay with a close button and appends it to
//       document.body, and `beginView()` calls it — but nothing ever moves focus into it, so a
//       keyboard user's focus stays on the card behind the overlay (focusInside=false) and the
//       overlay never announces itself (ariaModal=null).
//     * The ONLY dismissal paths are the × button and a click on the backdrop
//       (`if (ev.target === mEl || act === 'mclose') closeModal()`). There is no keydown listener
//       anywhere, so a synthetic Escape leaves `display` at 'flex'.
//     * No Tab containment: the overlay is `position:fixed; inset:0` over the whole page, so Tab
//       walks straight out of the dialog into the host's own controls.
//     * `closeModal()` only hides the element — focus is never returned, so it is dropped on
//       <body> and the user restarts their Tab traversal from the top of the page.
//     * `renderHistory()` attaches its expand handler to a plain `div.mmxdwf-hrow` and only
//       toggles `style.display`, so the per-run call list has no keyboard path at all.
//
//   最小改法 (1004.md): 补焦点进入/限制/Escape/恢复；history 展开改用原生 button 或
//   details/summary 复用现有 calls 逻辑.
//   安全 guard 保持: 真实隔离背景后才标 aria-modal（the isolation is real here — the overlay
//   covers the viewport and the Tab trap keeps focus inside, so the claim is earned, not asserted
//   on a non-isolated element）；不把 APG 指导等同认证 WCAG 违规 (this test asserts the
//   behaviour, and does not claim a certification).
//
//   新增验证 (1004.md): modal 焦点用例. 真实验收：未测（需真实 Tab 序）— the DOM double has no
//   real Tab order, so every assertion here is about the client's own focus bookkeeping.
//
// No third-party dependency, no host, no fixed Temp name, no real engine: the shared harness
// (test/lib/w2-client-harness.mjs) owns the DOM/fetch doubles and the fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run } from './lib/w2-client-harness.mjs';

const P = 'mmxdwf';
const modal = (f) => f.doc.getElementById(P + '-modal');
const isOpen = (f) => { const m = modal(f); return !!m && m.style.display === 'flex'; };
// A real browser resolves this; the double does not, so each call site is guarded.
const inside = (f, node) => {
  for (let e = node; e; e = e.parentNode) if (e === modal(f)) return true;
  return false;
};
const focusIn = (f) => inside(f, f.doc.activeElement);
const key = (node, k, extra = {}) => node.dispatch('keydown', { key: k, shiftKey: false, preventDefault() {}, ...extra });
const focusable = (f) => {
  const m = modal(f);
  if (!m) return [];
  return m.querySelectorAll('a,button,input,select,textarea,[tabindex]')
    .filter((el) => !el.disabled && el.getAttribute('tabindex') !== '-1');
};
// Assertions compare INDICES, never the nodes themselves: the DOM double keeps parent pointers,
// so a failed assert.equal on two Elements serialises a circular graph and takes minutes.
const focusedIndex = (f, items) => items.indexOf(f.doc.activeElement);
const describeFocus = (items) => items.map((el) => el.tagName + '[' + (el.getAttribute('data-act') || el.className || '') + ']').join(' ');

test('F07 MMX: opening a modal moves focus into it', async () => {
  const f = await boot('mmx', { runs: [run('f07-a', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-a"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    assert.ok(isOpen(f));
    assert.ok(focusIn(f), '1004.md focusInside=false — focus must land inside the dialog, not stay on the card behind it');
    assert.ok(focusedIndex(f, focusable(f)) >= 0, 'and it lands on something focusable');
  } finally { f.stop(); }
});

test('F07 MMX: the dialog announces itself only while it is genuinely open and isolating', async () => {
  const f = await boot('mmx', { runs: [run('f07-aria', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-aria"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    assert.equal(modal(f).getAttribute('aria-modal'), 'true',
      'guard 真实隔离背景后才标 aria-modal: the overlay covers the viewport and the trap holds focus, so the claim is earned');
    f.doc.querySelector('[data-act="mclose"]').dispatch('click');
    assert.equal(modal(f).getAttribute('aria-modal'), null,
      'a hidden dialog must not keep claiming to be modal');
  } finally { f.stop(); }
});

test('F07 MMX: Escape closes the modal (a synthetic keydown, as 1004.md measures it)', async () => {
  const f = await boot('mmx', { runs: [run('f07-esc', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-esc"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    assert.ok(isOpen(f));
    // 1004.md: 合成 Escape 后 display 仍 flex — that was the measured failure.
    key(f.doc.activeElement, 'Escape');
    assert.equal(isOpen(f), false, 'Escape must close the dialog');
  } finally { f.stop(); }
});

test('F07 MMX: Escape works from anywhere inside the dialog, not only from the close button', async () => {
  const f = await boot('mmx', { runs: [run('f07-esc2', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-esc2"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    const row = f.doc.querySelector('.mmxdwf-hrow');
    row.focus();
    assert.ok(focusIn(f));
    key(row, 'Escape');
    assert.equal(isOpen(f), false);
  } finally { f.stop(); }
});

test('F07 MMX: Tab and Shift+Tab wrap inside the dialog instead of escaping to the host', async () => {
  // Two runs, so the history dialog has at least three focusable controls and the "middle" one
  // this test exercises really is an interior control rather than an edge the trap owns.
  const f = await boot('mmx', { runs: [run('f07-tab-a', 'completed'), run('f07-tab-b', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-tab-a"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    const items = focusable(f);
    assert.ok(items.length >= 3, 'the history dialog has several focusable controls; order was ' + describeFocus(items));

    // Tab off the LAST control wraps to the first rather than leaving the dialog.
    items[items.length - 1].focus();
    key(items[items.length - 1], 'Tab');
    assert.equal(focusedIndex(f, items), 0, 'Tab from the last control wraps to the first; order was ' + describeFocus(items));
    assert.ok(focusIn(f), 'focus never leaves the dialog');

    // Shift+Tab off the FIRST control wraps to the last.
    key(items[0], 'Tab', { shiftKey: true });
    assert.equal(focusedIndex(f, items), items.length - 1, 'Shift+Tab from the first control wraps to the last; order was ' + describeFocus(items));
    assert.ok(focusIn(f));

    // Tab in the middle is left alone — the trap only owns the two edges.
    const mid = items[Math.floor(items.length / 2)];
    mid.focus();
    key(mid, 'Tab');
    assert.equal(focusable(f).indexOf(f.doc.activeElement), focusable(f).indexOf(mid),
      'a mid-dialog Tab is the browser\'s own, not ours');
  } finally { f.stop(); }
});

test('F07 MMX: a keydown that is not Tab/Escape is left to the host', async () => {
  const f = await boot('mmx', { runs: [run('f07-keys', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-keys"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    const row = f.doc.querySelector('.mmxdwf-hrow');
    row.focus();
    key(row, 'a');
    key(row, 'ArrowDown');
    assert.ok(isOpen(f), 'ordinary typing and arrow keys must not be swallowed by the dialog');
  } finally { f.stop(); }
});

test('F07 MMX: closing returns focus to the control that opened the dialog', async () => {
  const f = await boot('mmx', { runs: [run('f07-focus', 'completed')] });
  try {
    const opener = f.doc.querySelector('[data-run="f07-focus"]').querySelectorAll('[data-act="history"]')[0];
    opener.focus();
    const before = f.doc.activeElement;
    opener.dispatch('click');
    await f.flush();
    assert.ok(focusIn(f), 'focus moved into the dialog');
    key(f.doc.activeElement, 'Escape');
    assert.equal(f.doc.activeElement === before, true,
      'guard 无焦点恢复: focus must come back to the opener, not be dropped on <body>');
  } finally { f.stop(); }
});

test('F07 MMX: the × button also restores focus, and a second Escape does not re-open anything', async () => {
  const f = await boot('mmx', { runs: [run('f07-close', 'completed')] });
  try {
    const opener = f.doc.querySelector('[data-run="f07-close"]').querySelectorAll('[data-act="history"]')[0];
    opener.focus();
    const before = f.doc.activeElement;
    opener.dispatch('click');
    await f.flush();
    f.doc.querySelector('[data-act="mclose"]').dispatch('click');
    assert.equal(f.doc.activeElement === before, true, 'closing by mouse restores focus too');
    key(f.doc.activeElement, 'Escape');
    assert.equal(isOpen(f), false, 'Escape on a closed dialog is inert, not an error');
  } finally { f.stop(); }
});

test('F07 MMX: every modal kind gets the same keyboard closure (script / result / history)', async () => {
  const f = await boot('mmx', {
    runs: [run('f07-kinds', 'running', { calls: [{ callId: 'c1', label: '审计', state: 'done' }] })],
  });
  try {
    const card = f.doc.querySelector('[data-run="f07-kinds"]');
    for (const act of ['script', 'result', 'history']) {
      card.querySelectorAll('[data-act="' + act + '"]')[0].dispatch('click');
      await f.flush();
      assert.ok(isOpen(f), act + ' opens the dialog');
      assert.ok(focusIn(f), act + ' moves focus in');
      key(f.doc.activeElement, 'Escape');
      assert.equal(isOpen(f), false, act + ' closes on Escape');
    }
  } finally { f.stop(); }
});

test('F07 MMX: switching views inside an open dialog re-asserts focus (it stays trapped)', async () => {
  const f = await boot('mmx', { runs: [run('f07-switch', 'running')] });
  try {
    const card = f.doc.querySelector('[data-run="f07-switch"]');
    card.querySelectorAll('[data-act="script"]')[0].dispatch('click');
    await f.flush();
    assert.ok(focusIn(f));
    card.querySelectorAll('[data-act="result"]')[0].dispatch('click');
    await f.flush();
    assert.ok(isOpen(f));
    assert.ok(focusIn(f), 'a second view in the same dialog must not leave focus behind it');
  } finally { f.stop(); }
});

// ---------------------------------------------------------------- history expansion
test('F07 MMX: the history row exposes a real button, not a div with a click handler', async () => {
  const f = await boot('mmx', { runs: [run('f07-row', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-row"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    const row = f.doc.querySelector('.mmxdwf-hrow');
    const toggle = row.querySelectorAll('button[data-act="htoggle"]')[0];
    assert.ok(toggle, 'the expand control is a native <button>: focusable and Enter/Space operable by the platform');
    assert.equal(toggle.getAttribute('type'), 'button');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'and it reports its own state');
  } finally { f.stop(); }
});

test('F07 MMX: the toggle expands the call list and keeps aria-expanded in step', async () => {
  const f = await boot('mmx', {
    runs: [run('f07-calls', 'completed', { calls: [{ callId: 'c1', label: '审计', state: 'done' }] })],
  });
  try {
    f.doc.querySelector('[data-run="f07-calls"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    const toggle = f.doc.querySelector('.mmxdwf-hrow').querySelectorAll('button[data-act="htoggle"]')[0];
    const list = f.doc.querySelectorAll('.mmxdwf-hcalls')[0];
    assert.equal(list.style.display, 'none');

    toggle.dispatch('click');
    assert.equal(list.style.display, 'block', 'the existing calls logic still runs');
    assert.match(list.textContent, /审计/, 'and still renders the same content');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');

    toggle.dispatch('click');
    assert.equal(list.style.display, 'none', 'it toggles back');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  } finally { f.stop(); }
});

test('F07 MMX: the bind buttons next to the row still work and never toggle the call list', async () => {
  // The row and its bind button share one click path, so the existing "don't toggle when a bind
  // control was clicked" guard has to keep working. A persisted manual binding is what renders a
  // bind control without a current session, so the guard is exercised on 解除绑定.
  const f = await boot('mmx', {
    runs: [run('f07-bind', 'completed')],
    storage: new Map([['mmxdwf-session-bindings', JSON.stringify({
      'f07-bind': { host: 'mmx', source: 'mmx-oneclick', sessionId: 'sess-f07' },
    })]]),
  });
  try {
    f.doc.querySelector('[data-run="f07-bind"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    const bind = f.doc.querySelector('[data-act="unbindcurrent"]');
    assert.ok(bind, 'the row still offers a bind control');
    const toggle = f.doc.querySelector('[data-act="htoggle"]');
    const calls = f.doc.querySelector('.mmxdwf-hcalls');
    bind.dispatch('click');
    await f.flush();
    assert.equal(f.doc.querySelectorAll('.mmxdwf-hcalls').length, 1, 'the bind control did not add a call list of its own');
    assert.equal(f.doc.querySelector('.mmxdwf-hcalls').style.display, 'none', 'and it did not expand the existing one');
    assert.equal(f.doc.querySelector('[data-act="htoggle"]').getAttribute('aria-expanded'), 'false');
    assert.equal(f.doc.querySelector('[data-act="unbindcurrent"]'), null, 'the bind actually happened');
    assert.ok(toggle && calls, 'the row and its call list were still there to be guarded');
  } finally { f.stop(); }
});

test('F07 MMX: a run with no calls still gets a toggle that explains itself', async () => {
  const f = await boot('mmx', { runs: [run('f07-nocalls', 'completed')] });
  try {
    f.doc.querySelector('[data-run="f07-nocalls"]').querySelectorAll('[data-act="history"]')[0].dispatch('click');
    await f.flush();
    const toggle = f.doc.querySelector('.mmxdwf-hrow').querySelectorAll('button[data-act="htoggle"]')[0];
    assert.ok(toggle, 'the control is present and honest about being empty');
    toggle.dispatch('click');
    assert.match(f.doc.querySelectorAll('.mmxdwf-hcalls')[0].textContent, /无调用记录/);
  } finally { f.stop(); }
});
