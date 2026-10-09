// test/relay-stdin-framing.test.mjs — the stdin framing the host ACTUALLY uses.
//
// Measured 2026-10-09: the MiniMax Code host writes the PreToolUse payload and does NOT close the
// hook process' stdin pipe (hooks/hooks.json declares "timeout": 2). The relay used to read stdin as
// `for await (const chunk of process.stdin)`, i.e. it waited for an EOF that never arrives — so every
// host-side trigger ended in HOOK_TIMEOUT + fail-open and the --host-session flag was never actually
// delivered. Same payload through `echo` (immediate EOF) worked, which is why this went unnoticed.
//
// These tests spawn the real relay over a real pipe and pin the framing rules the host relies on:
//   * one complete JSON object, pipe left open  -> answer on that chunk, exit 0, long before 2s
//   * the same object split across chunks     -> reassembled, same answer
//   * a silent pipe                           -> fail open at the self-deadline, inside the 2s budget
//   * an immediate EOF                        -> the original path, unchanged
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const relay = fileURLToPath(new URL('../scripts/relay.mjs', import.meta.url));
const ENGINE_CMD = 'node "G:/mmx-project/zcode动态工作流-原else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs" run task.mjs --run-id demo';
// The host kills the hook at hooks/hooks.json "timeout": 2 — the relay must always beat that itself.
const HOST_BUDGET_MS = 2000;
const DEADLINE_MS = 1200;
const SESSION = 'sess-mm-framing';

const preToolUse = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'bash', session_id: SESSION,
  cwd: 'G:/mmx-project/zcode动态工作流-原else', tool_input: { command }, ...extra,
});

// Real child process, real pipe. Unless `eof` is set, the parent's write end is deliberately LEFT
// OPEN — that is the host behaviour under test, so nothing here may depend on stdin being closed.
const spawnRelay = ({ writes = [], eof = false, budgetMs = HOST_BUDGET_MS }) => new Promise((resolve, reject) => {
  const started = Date.now();
  const child = spawn(process.execPath, [relay], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', timer;
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.on('error', () => {});            // EPIPE after an early child exit must not fail the run
  child.on('error', reject);
  child.on('close', (code) => {
    clearTimeout(timer);
    child.stdin.destroy();                       // release our write end so the test process can exit
    resolve({ code, out, err, elapsedMs: Date.now() - started });
  });
  timer = setTimeout(() => {
    child.kill();
    reject(new Error(`relay did not exit within ${budgetMs}ms (out=${JSON.stringify(out)})`));
  }, budgetMs);
  for (const w of writes) {
    if (typeof w === 'string') child.stdin.write(w);
    else setTimeout(() => child.stdin.write(w.text), w.afterMs);   // force a genuinely separate chunk
  }
  if (eof) child.stdin.end();
});

const flaggedCommand = (out) => JSON.parse(out).hookSpecificOutput.updatedInput.command;
const sessionOf = (out) => {
  const m = out.match(/--host-session (\S+)/);
  return m ? JSON.parse(Buffer.from(m[1], 'base64url')) : null;
};
const assertAttributed = (result, note) => {
  assert.equal(result.code, 0, note + ': exit 0');
  assert.equal(result.err, '', note + ': nothing on stderr');
  assert.equal(flaggedCommand(result.out).startsWith(ENGINE_CMD + ' '), true,
    note + ': the original command text is preserved byte-for-byte');
  assert.deepEqual(sessionOf(result.out), { host: 'mmx', sessionId: SESSION, source: 'native-hook' },
    note + ': the exact native session is attached');
};

test('a complete payload is answered on its first chunk although the host never closes stdin', async () => {
  const result = await spawnRelay({ writes: [JSON.stringify(preToolUse(ENGINE_CMD))] });
  assertAttributed(result, 'open pipe');
  assert.ok(result.elapsedMs < 1000,
    `answered in ${result.elapsedMs}ms, not after waiting for an EOF that never arrives`);
});

test('a payload split across chunks is reassembled and answered the same way', async () => {
  // Nested objects/braces and a cut INSIDE a string literal: the chunk scanner must track depth
  // and string state, not just count braces.
  const payload = JSON.stringify(preToolUse(ENGINE_CMD, { nested: { deep: { list: [1, 2, 3] } } }));
  const cut = payload.indexOf('task.mjs') + 4;
  assert.ok(cut > 0 && cut < payload.length - 1, 'the payload really is cut in two');
  const result = await spawnRelay({ writes: [payload.slice(0, cut), { text: payload.slice(cut), afterMs: 40 }] });
  assertAttributed(result, 'split payload');
  assert.ok(result.elapsedMs < 1000, `answered in ${result.elapsedMs}ms`);
});

test('a payload split into three chunks is still reassembled', async () => {
  const payload = JSON.stringify(preToolUse(ENGINE_CMD));
  const third = Math.floor(payload.length / 3);
  const result = await spawnRelay({
    writes: [payload.slice(0, third), { text: payload.slice(third, 2 * third), afterMs: 30 },
      { text: payload.slice(2 * third), afterMs: 60 }],
  });
  assertAttributed(result, 'three chunks');
});

test('a completely silent stdin fails open at the self-deadline, inside the host 2s budget', async () => {
  const result = await spawnRelay({ writes: [] });
  assert.equal(result.code, 0, 'fail-open is exit 0, never a hook error');
  assert.equal(result.out, '', 'fail-open is empty stdout');
  assert.equal(result.err, '', 'nothing on stderr');
  assert.ok(result.elapsedMs >= DEADLINE_MS - 200,
    `waited ${result.elapsedMs}ms — the self-deadline, not an accidental early exit`);
  assert.ok(result.elapsedMs < HOST_BUDGET_MS,
    `${result.elapsedMs}ms still fits inside the host's ${HOST_BUDGET_MS}ms hook timeout`);
});

test('a truncated payload also fails open at the deadline instead of hanging on the open pipe', async () => {
  const truncated = JSON.stringify(preToolUse(ENGINE_CMD)).slice(0, 60);   // never balanced
  const result = await spawnRelay({ writes: [truncated] });
  assert.equal(result.code, 0);
  assert.equal(result.out, '');
  assert.ok(result.elapsedMs < HOST_BUDGET_MS, `${result.elapsedMs}ms fits the host budget`);
});

test('non-JSON and non-matching stdin stay silent and exit 0 without spending the whole budget', async () => {
  for (const [writes, note] of [
    [['not json at all'], 'garbage'],
    [[JSON.stringify(preToolUse('node other.mjs run x'))], 'non-matching command'],
    [[JSON.stringify({ ...preToolUse(ENGINE_CMD), hook_event_name: 'PostToolUse' })], 'other event'],
  ]) {
    const result = await spawnRelay({ writes });
    assert.equal(result.code, 0, note);
    assert.equal(result.out.trim(), '', note + ': no output');
    assert.ok(result.elapsedMs < 1000,
      `${note}: decided in ${result.elapsedMs}ms, it did not wait for the deadline`);
  }
});

test('the immediate-EOF path is unchanged', async () => {
  const result = await spawnRelay({ writes: [JSON.stringify(preToolUse(ENGINE_CMD))], eof: true });
  assertAttributed(result, 'immediate EOF');
  const silent = await spawnRelay({ writes: ['not json at all'], eof: true });
  assert.equal(silent.code, 0);
  assert.equal(silent.out, '', 'malformed stdin under immediate EOF is still silent');
});
