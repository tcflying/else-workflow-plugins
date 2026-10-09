#!/usr/bin/env node
// mmx-native-session-hook / PreToolUse relay (candidate, not installed).
//
// Reads exactly one JSON object on stdin (the MiniMax native hook contract). When the model is
// about to run THIS workspace's workflow engine (a bash tool invocation referencing the exact
// engine path below with the `run` subcommand), the relay appends an explicit
// --host-session <base64url> flag so the engine records the exact native session the run
// belongs to. Everything else passes through untouched: no permissionDecision is ever emitted
// (this relay must not grant or deny anything), non-matching tools/commands produce no output,
// and any internal error fails open (empty stdout, exit 0) per the hook contract.
//
// WHY STDIN IS READ INCREMENTALLY (measured 2026-10-09): the MiniMax Code host does NOT close the
// hook process' stdin pipe after writing the payload — on that date every host-side trigger of this
// relay (and of mmx-plug-test) ended in HOOK_TIMEOUT + fail-open, and a local repro agreed: spawning
// this relay, writing a complete JSON event and leaving stdin open left the process alive with no
// output past 1.5s, while the same payload through `echo` (immediate EOF) returned the attribution
// flag in 0.127s and exit 0. A `for await (const chunk of process.stdin)` reader therefore waits for
// an EOF that never arrives, burns the host's own 2s budget (hooks/hooks.json "timeout": 2) and
// gets killed — so the flag was NEVER actually delivered in production. Hence the buffer is
// re-scanned on every chunk and answered the instant one complete JSON object is available, with a
// 1200ms self-deadline (comfortably inside the host's 2s) after which the relay fails open instead
// of waiting. Split payloads are reassembled, EOF keeps the original whole-text path, and both
// routes funnel through the same handle() so the observable contract is unchanged.
import { createHash } from 'node:crypto';

// Exact engine of this workspace (REPAIR-024 boundary: only our own engine is ever modified).
const ENGINE_RESOLVED = 'g:/mmx-project/zcode动态工作流-原else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs';

// Hard self-deadline. MUST stay below the host-declared 2s hook timeout, otherwise the host kills
// the relay before it can fail open on its own terms.
const STDIN_DEADLINE_MS = 1200;

// String-aware scan for the end of the first complete JSON object in the buffer, tolerating a
// payload split across chunks and braces/escapes inside string literals.
// Returns null while the buffer is still incomplete; otherwise the slice to hand to handle().
const scanForJson = (text) => {
  const start = text.search(/\S/);
  if (start === -1) return null;                          // whitespace only so far
  if (text[start] !== '{') return { text };               // not an object -> let handle() decide, now
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { text: text.slice(start, i + 1) };
  }
  return null;                                            // still incomplete
};

// Resolves with the payload text as soon as it is usable — one chunk carrying a complete JSON
// object is enough — or '' at the deadline, so the host's 2s budget is never spent waiting for an
// EOF that may never come. Never rejects: every failure mode degrades to the fail-open path.
const readStdin = () => new Promise((resolve) => {
  let buf = '';
  let settled = false;
  let timer;
  const settle = (text) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    process.stdin.off('data', onData);
    process.stdin.off('end', onEnd);
    process.stdin.off('error', onEnd);
    process.stdin.off('close', onEnd);
    process.stdin.on('error', () => {});   // tearing the pipe down must not raise an uncaught error
    try { process.stdin.pause(); process.stdin.destroy(); } catch { /* stdin already gone */ }
    resolve(text);
  };
  const onData = (chunk) => {
    buf += chunk;
    const hit = scanForJson(buf);
    if (hit) settle(hit.text);
  };
  const onEnd = () => settle(buf);          // EOF (or a broken pipe): the original whole-text path
  process.stdin.setEncoding('utf8');        // keeps multi-byte chars intact across chunk boundaries
  process.stdin.on('data', onData);
  process.stdin.once('end', onEnd);
  process.stdin.once('error', onEnd);
  process.stdin.once('close', onEnd);
  timer = setTimeout(() => settle(''), STDIN_DEADLINE_MS);
});

export function buildHostSessionFlag(sessionId) {
  // sessionId comes from the native hook stdin; it is attribution metadata, not a credential,
  // and the engine re-validates the decoded value before a run directory is created.
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) return null;
  return '--host-session ' + Buffer.from(JSON.stringify({ host: 'mmx', sessionId, source: 'native-hook' })).toString('base64url');
}

// Only a single, literal `node <exact engine> run ...` command is supported.
// Decline shell composition, comments, expansion and escaping rather than attaching attribution
// to another command. This is a narrow argv recognizer, not a general shell parser. Quoted
// literal arguments and the engine's existing case/path-separator matching remain supported.
export function shouldAppendFlag(command) {
  if (typeof command !== 'string' || command.length > 8192) return false;
  if (/[&|;<>\r\n`$#()]/.test(command) || command.includes('\\"')) return false;
  const literal = /^(?:"[^"]*"|'[^']*'|[^\s"'\\]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|[^\s"'\\]+))*$/;
  if (!literal.test(command.trim())) return false;
  const args = command.trim().match(/"[^"]*"|'[^']*'|[^\s"']+/g)
    .map((arg) => /^["']/.test(arg) ? arg.slice(1, -1) : arg);
  if (!/^node(?:\.exe)?$/i.test(args[0]) || args[2] !== 'run') return false;
  if (args[1]?.toLowerCase().replace(/\\/g, '/') !== ENGINE_RESOLVED) return false;
  return !args.some((arg) => arg === '--' || /^--?host-session(?:=|$)/.test(arg));
}

export function appendFlag(command, flag) {
  return command.trimEnd() + ' ' + flag;
}

export async function handle(stdinText) {
  let event;
  try { event = JSON.parse(stdinText); } catch { return ''; }
  try {
    if (!event || event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'bash') return '';
    const command = event.tool_input && event.tool_input.command;
    if (!shouldAppendFlag(command)) return '';
    const flag = buildHostSessionFlag(event.session_id);
    if (!flag) return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...event.tool_input, command: appendFlag(command, flag) },
      },
    });
  } catch { return ''; }
}

if (process.argv[1] && process.argv[1].endsWith('relay.mjs')) {
  let output = '';
  try { output = await handle(await readStdin()); } catch { output = ''; }   // fail open, exit 0
  if (output) process.stdout.write(output + '\n');
}
