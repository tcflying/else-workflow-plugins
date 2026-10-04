// test/w5-mmx-cdp-registration-unknown.test.mjs — 1004.md §4 W5, MMX half: F20.
//
//   F20 (中) CDP 注册响应未知时，stop 可能错误报告清理成功。
//        触发边界（原文）：`Page.addScriptToEvaluateOnNewDocument` 可能已生效但 identifier 响应
//        超时/断连时，cleanup 跳过删除注册与 UI teardown，stop 仍 `cleaned:true, errors:[]`
//        （假传输下 `uiStillPresent=true, teardownEvaluations=0`）。**未连真实 CDP**；官方 Page
//        协议要求 identifier 才能删除，Chromium 断连也可能停止后续注入。
//        涉及源码：`sidecar.mjs:610-636,663-715`。
//
//   Root cause re-checked against the CURRENT source (sidecar.mjs startCdpInjector):
//     * `attach()` sets `handle.mayHaveUi = true` only AFTER `addScriptToEvaluateOnNewDocument`
//       answers with an identifier, and it never records "a registration command was sent".
//     * `send()` is `bounded(...)`, which REJECTS on `commandTimeoutMs`. If the response is late
//       or the socket dies first, `added` is never assigned, `handle.docScriptId` stays null and
//       the `!handle.docScriptId` throw unwinds into `finally { if (current !== handle) await
//       cleanup(handle) }`.
//     * `cleanup()` builds its task list from `handle.docScriptId` and `handle.mayHaveUi` — both
//       null/false — so it does nothing, pushes NO error, and only closes the socket.
//     * `stop()` then returns `{ cleaned: errors.length === 0, errors }` = `{ cleaned: true,
//       errors: [] }`: a clean bill of health for a page-side effect that may still be armed.
//     * `bounded(operation, label, late)` already has a `late(value)` hook that fires when the
//       operation settles AFTER the deadline — that is exactly the window in which a usable
//       identifier can still be salvaged, and it was never passed for this command.
//
//   最小改法 (1004.md): 注册发送前标记「可能生效」；无法确认撤销时返回 `cleaned:false` 及原生
//   页面重载提示；若仍可取晚到 identifier 则有界补偿。
//
//   安全 guard 保持:
//     * 关闭 socket 不等于撤销页面副作用 — the report says so instead of inferring from close().
//     * 不把假传输注册记录解释成真实浏览器「断连后永久残留」 — the wording is "may still be
//       armed, reload the page", never "is permanently leaked"; and a late identifier that IS
//       removed clears the error again.
//
// Fake CDP transport only — no real browser, no CDP port, no host. Node's test runner plus the
// real sidecar.mjs module (imported, not copied).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'client-inject.js');
const { startCdpInjector } = await import(new URL('../sidecar.mjs', import.meta.url).href);

const target = (id) => ({ type: 'page', title: 'MiniMax Code', url: 'app://./archon', id, webSocketDebuggerUrl: `ws://127.0.0.1:9331/devtools/page/${id}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, what, budgetMs = 2000) => {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(5);
  }
};
// The teardown expressions PRELUDE sends, i.e. what a real page would run to take the UI down.
const isTeardown = (p) => p && p.expression && /__mmxDwfTeardown/.test(p.expression);

// ------------------------------------------------------------------ the unconfirmed case
test('F20 MMX: an unconfirmed document registration is NOT reported as a clean stop', async () => {
  const t = target('F20-timeout');
  const calls = [];
  const client = {
    calls,
    // The registration command never answers: the command deadline fires first.
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return new Promise(() => {});
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const inj = startCdpInjector({
    scriptPath: CLIENT, capability: 'f20-capability-123456789', quiet: true,
    commandTimeoutMs: 40, pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [t],
    connect: async () => client,
  });
  try {
    await inj.attempt();
    await waitFor(() => calls.some(([m]) => m === '__close'), 'the half-attached socket to close');
    const out = await inj.stop();
    assert.equal(out.cleaned, false,
      '1004.md: stop 仍 cleaned:true — a registration whose identifier never came back cannot be called clean');
    assert.ok(out.errors.length > 0, 'and the reason must be reported, not swallowed');
    assert.match(out.errors.join(' '), /addScriptToEvaluateOnNewDocument|identifier/i);
  } finally { await inj.stop(); }
});

test('F20 MMX: a dropped socket after the registration send is equally unconfirmed', async () => {
  const t = target('F20-drop');
  const calls = [];
  const client = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      // The command reaches the browser and the connection dies before the identifier returns.
      if (method === 'Page.addScriptToEvaluateOnNewDocument') { const e = new Error('CDP WebSocket closed'); throw e; }
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const inj = startCdpInjector({
    scriptPath: CLIENT, quiet: true, commandTimeoutMs: 40, pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [t], connect: async () => client,
  });
  try {
    await inj.attempt();
    await waitFor(() => calls.some(([m]) => m === '__close'), 'cleanup of the dead handle');
    const out = await inj.stop();
    assert.equal(out.cleaned, false, 'closing a socket does not revoke a page-side registration');
  } finally { await inj.stop(); }
});

test('F20 MMX: the report asks for a native page reload instead of implying certainty', async () => {
  const t = target('F20-wording');
  const calls = [];
  const client = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return new Promise(() => {});
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const inj = startCdpInjector({
    scriptPath: CLIENT, quiet: true, commandTimeoutMs: 40, pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [t], connect: async () => client,
  });
  try {
    await inj.attempt();
    await waitFor(() => calls.some(([m]) => m === '__close'), 'cleanup');
    const out = await inj.stop();
    const text = out.errors.join(' ');
    assert.match(text, /reload/i, 'the user is told the concrete remedy: reload the native page');
    // guard: 不把假传输注册记录解释成真实浏览器「断连后永久残留」
    assert.doesNotMatch(text, /permanent|永久|leak(ed)?\b/i,
      'the wording must stay "may still be armed", not "permanently leaked"');
  } finally { await inj.stop(); }
});

// ------------------------------------------------------------------ the late-identifier case
test('F20 MMX: a late identifier is still salvaged and removed (bounded compensation)', async () => {
  const t = target('F20-late');
  const calls = [];
  let releaseRegistration;
  const client = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return new Promise((resolve) => { releaseRegistration = () => resolve({ identifier: 'late-doc-1' }); });
      }
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const inj = startCdpInjector({
    scriptPath: CLIENT, quiet: true, commandTimeoutMs: 40, pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [t], connect: async () => client,
  });
  try {
    await inj.attempt();
    await waitFor(() => calls.some(([m]) => m === '__close'), 'cleanup of the timed-out attach');
    // The answer finally lands, after the deadline and after cleanup already gave up on it.
    assert.equal(typeof releaseRegistration, 'function', 'the registration command really is still in flight');
    releaseRegistration();
    await waitFor(() => calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument'),
      'the compensating removal of the late identifier');
    const removal = calls.find(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument');
    assert.equal(removal[1].identifier, 'late-doc-1', 'and it removes exactly the identifier that arrived');
  } finally { await inj.stop(); }
});

test('F20 MMX: a confirmed registration is still fully clean (no false alarm)', async () => {
  const t = target('F20-ok');
  const calls = [];
  const client = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'doc-ok-1' };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const inj = startCdpInjector({
    scriptPath: CLIENT, quiet: true, commandTimeoutMs: 500, pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [t], connect: async () => client,
  });
  try {
    await waitFor(() => inj.target === 'F20-ok', 'the attach to complete');
    const out = await inj.stop();
    assert.equal(out.cleaned, true, 'a fully confirmed lifecycle is still reported as clean');
    assert.deepEqual(out.errors, []);
    assert.ok(calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p.identifier === 'doc-ok-1'));
    assert.ok(calls.filter(([m, p]) => m === 'Runtime.evaluate' && isTeardown(p)).length >= 1,
      'and the renderer UI is torn down through the same path');
  } finally { await inj.stop(); }
});

test('F20 MMX: stop before the registration is sent stays clean (nothing to revoke)', async () => {
  const t = target('F20-early');
  const calls = [];
  let releaseEnable;
  const client = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.enable') await new Promise((r) => { releaseEnable = r; });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'never' };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const inj = startCdpInjector({
    scriptPath: CLIENT, quiet: true, commandTimeoutMs: 200, pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [t], connect: async () => client,
  });
  try {
    await sleep(20);
    const sp = inj.stop();
    releaseEnable();
    await sp;
    assert.equal(calls.some(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument'), false,
      'the registration was never sent, so there is nothing that could be armed');
    const out = await inj.stop();
    assert.equal(out.cleaned, true, 'and stop stays honest about that');
  } finally { await inj.stop(); }
});

test('F20 MMX: an answered registration that carries no identifier is also unconfirmed', async () => {
  const t = target('F20-noid');
  const calls = [];
  const client = {
    calls,
    send: async (method, params) => {
      calls.push([method, params]);
      // The host answers, but without the field the Page protocol requires for removal.
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return {};
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
    close: () => calls.push(['__close']),
  };
  const inj = startCdpInjector({
    scriptPath: CLIENT, quiet: true, commandTimeoutMs: 200, pollMs: 3.6e6, retryMs: 3.6e6,
    listTargets: async () => [t], connect: async () => client,
  });
  try {
    await inj.attempt();
    await waitFor(() => calls.some(([m]) => m === '__close'), 'cleanup');
    const out = await inj.stop();
    assert.equal(out.cleaned, false, 'a reply without an identifier cannot be used to revoke the registration');
  } finally { await inj.stop(); }
});
