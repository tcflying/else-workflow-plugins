// test/w5-mmx-inline-text-artifact.test.mjs — 1004.md §4 W5, MMX half: F06.
//
//   F06 (中) MMX 合法内联 text 产物只有元数据、无正文入口。
//        触发边界（原文）：`publish({title,kind:'text',text})` 无 path/url 是合法接口；引擎保存
//        并由 `/runs` 返回正文，卡片只有标题/图标，`openArtifact` 只走文件接口而 `404`。
//        **正文没丢**（可经 progress/journal/API 读），text 上限 4000 UTF-16 字符。
//
//   Root cause re-checked against the CURRENT source:
//     * engine `publish()` (plugins/.../runtime/wf.mjs) accepts `{title, kind, path?, url?, text?}`;
//       `text` is stored on the journal event and mirrored into progress.json's
//       `artifacts[].text` (capped at 4000 UTF-16 chars). `/runs` returns the whole progress
//       object, so the client already HAS the body.
//     * `artifactsHtml()` only offers a control for `a.url` (link) or `a.path` (data-act=
//       "artifact"). A pure inline text artifact falls through both branches and renders a bare
//       title span — metadata with no way into the body.
//     * `openArtifact()` unconditionally calls `/artifact`, and the sidecar answers
//       `404 'artifact is not a published file'` for an entry with no `path`
//       (sidecar.mjs serveArtifact), so even forcing the button could only produce an error.
//
//   最小改法 (1004.md): 纯内联 text 复用 modal/`pre` 以 `textContent` 展示，不请求文件接口。
//   安全 guard 保持: 不渲染 HTML（textContent only, never innerHTML）；不加依赖。
//
//   新增验证 (1004.md): **不带 path** 的纯内联 text 用例（现有用例 art-txt 带 path）。
//
// No third-party dependency, no host, no fixed Temp name, no real engine: the shared harness
// (test/lib/w2-client-harness.mjs) owns the DOM/fetch doubles and the fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, run } from './lib/w2-client-harness.mjs';

const P = 'mmxdwf';
const artifactFetches = (f) => f.requestLog.filter((r) => r.url.includes('/artifact?')).length;
// The HTML string /runs would hand the client for this artifact row (engine progress shape).
const inlineText = (over = {}) => ({ kind: 'text', title: '审查结论', text: '第一行结论\n第二行细节', ...over });

test('F06 MMX: a pure inline text artifact (no path, no url) offers a body entry point', async () => {
  const f = await boot('mmx', { runs: [run('f06-inline', 'completed', { artifacts: [inlineText()] })] });
  try {
    const c = f.doc.querySelector('[data-run="f06-inline"]');
    assert.ok(c, 'the card renders');
    assert.match(c.textContent, /审查结论/, 'the title is still shown as metadata');
    const btn = c.querySelectorAll('[data-act="artifact"]')[0];
    assert.ok(btn, '1004.md: 合法内联 text 产物只有元数据、无正文入口 — a body entry point must exist');
  } finally { f.stop(); }
});

test('F06 MMX: opening it shows the body as text and NEVER calls the file endpoint', async () => {
  const f = await boot('mmx', { runs: [run('f06-body', 'completed', { artifacts: [inlineText()] })] });
  try {
    f.doc.querySelector('[data-run="f06-body"]').querySelectorAll('[data-act="artifact"]')[0].dispatch('click');
    await f.flush();
    const body = f.doc.querySelector('.mmxdwf-mbody');
    assert.match(body.textContent, /第一行结论/, 'the inline body reaches the modal');
    assert.match(body.textContent, /第二行细节/);
    assert.equal(artifactFetches(f), 0,
      'the file endpoint can only answer 404 for a text artifact (no path) — it must not be called');
  } finally { f.stop(); }
});

test('F06 MMX: guard — the body is rendered as TEXT, never as HTML', async () => {
  const f = await boot('mmx', {
    runs: [run('f06-xss', 'completed', { artifacts: [inlineText({ text: '<img src=x onerror=alert(1)><b>粗体</b>' })] })],
  });
  try {
    f.doc.querySelector('[data-run="f06-xss"]').querySelectorAll('[data-act="artifact"]')[0].dispatch('click');
    await f.flush();
    const body = f.doc.querySelector('.mmxdwf-mbody');
    assert.match(body.textContent, /<img src=x/, 'the markup is shown literally');
    assert.equal(body.querySelectorAll('img').length, 0, 'no element is created from artifact text');
    assert.equal(body.querySelectorAll('b').length, 0);
  } finally { f.stop(); }
});

test('F06 MMX: a full-length (4000-char) inline body is shown in full, not truncated away', async () => {
  // The engine caps `text` at 4000 UTF-16 characters. The modal's own bound is far higher, so a
  // maximum-size body must come through WHOLE — a "truncated" notice here would mean the client
  // was clipping legal engine output.
  const long = 'x'.repeat(4000);
  const f = await boot('mmx', { runs: [run('f06-long', 'completed', { artifacts: [inlineText({ text: long })] })] });
  try {
    f.doc.querySelector('[data-run="f06-long"]').querySelectorAll('[data-act="artifact"]')[0].dispatch('click');
    await f.flush();
    const text = f.doc.querySelector('.mmxdwf-mbody').textContent;
    assert.ok(text.includes(long.slice(0, 200)), 'a long inline body is displayed');
    assert.ok(text.includes(long.slice(-200)), 'and comes through whole — nothing legal is clipped');
    assert.doesNotMatch(text, /已截断/, 'a maximum-size engine body is not a truncation case');
    assert.equal(artifactFetches(f), 0);
  } finally { f.stop(); }
});

test('F06 MMX: guard — a file artifact still goes through the authenticated file endpoint', async () => {
  // The pre-existing behaviour must be untouched by the inline branch: `art-txt` in the existing
  // suite carries a path, and that path must keep using /artifact.
  const f = await boot('mmx', { runs: [run('f06-file', 'completed', { artifacts: [{ kind: 'text', title: 'notes', path: 'G:/x/notes.txt' }] })] });
  try {
    f.doc.querySelector('[data-run="f06-file"]').querySelectorAll('[data-act="artifact"]')[0].dispatch('click');
    await f.flush();
    assert.equal(artifactFetches(f), 1, 'a path artifact keeps using the authenticated file API');
  } finally { f.stop(); }
});

test('F06 MMX: guard — a remote url artifact stays a link and never gains a body button', async () => {
  const f = await boot('mmx', { runs: [run('f06-url', 'running', { artifacts: [{ kind: 'document', title: '看板', url: 'https://example.com/a' }] })] });
  try {
    const c = f.doc.querySelector('[data-run="f06-url"]');
    assert.equal(c.querySelectorAll('a').length, 1, 'an https artifact is a link');
    assert.equal(c.querySelectorAll('[data-act="artifact"]').length, 0, 'and gets no inline body button');
  } finally { f.stop(); }
});

test('F06 MMX: an inline artifact without a body at all degrades to metadata, not to a dead button', async () => {
  // `publish()` allows text to be absent; the card must not then offer a button that opens an
  // empty modal, and must certainly not call the file endpoint.
  const f = await boot('mmx', { runs: [run('f06-empty', 'completed', { artifacts: [{ kind: 'text', title: '空产物', text: null }] })] });
  try {
    const c = f.doc.querySelector('[data-run="f06-empty"]');
    assert.match(c.textContent, /空产物/);
    assert.equal(c.querySelectorAll('[data-act="artifact"]').length, 0, 'no dead control for a body-less artifact');
    assert.equal(artifactFetches(f), 0);
  } finally { f.stop(); }
});

test('F06 MMX: an inline artifact alongside a file artifact keeps each control distinct', async () => {
  const f = await boot('mmx', {
    runs: [run('f06-mix', 'completed', { artifacts: [
      inlineText({ title: '内联正文' }),
      { kind: 'file', title: 'report', path: 'G:/x/report.txt' },
    ] })],
  });
  try {
    const arts = f.doc.querySelector('[data-run="f06-mix"]').querySelectorAll('[data-act="artifact"]');
    assert.equal(arts.length, 2, 'both artifacts keep their own control');
    arts[0].dispatch('click');
    await f.flush();
    assert.match(f.doc.querySelector('.mmxdwf-mbody').textContent, /第一行结论/);
    assert.equal(artifactFetches(f), 0, 'the inline one is index-correct and served locally');
    arts[1].dispatch('click');
    await f.flush();
    assert.equal(artifactFetches(f), 1, 'the file one still goes through /artifact');
  } finally { f.stop(); }
});
