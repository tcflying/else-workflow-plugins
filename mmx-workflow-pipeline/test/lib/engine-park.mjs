// Test-side helper: read a file the workspace engine is still writing, without racing it.
//
// The engine writes a per-call file with `fsp.writeFile`, which creates the file and only then
// puts bytes in it (wf.mjs:730). A reader that treats "the directory entry exists" as "the
// document is ready" can therefore parse a zero-byte or half-written file. Listing the pending
// directory is also the wrong readiness signal in principle: the index, not the directory, is what
// says which calls are outstanding.
//
// So the only readiness signal here is a pending.json index that PARSES, carries a string runId and
// a non-empty items array. The per-call file is then located from `item.callId` — never from a
// directory listing — and must satisfy the same parse rule plus a callId match.
//
// Nothing in this file writes engine state. The only writer is the engine process itself.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CALL_ID_RE = /^[cq][0-9]{3,}-[0-9a-f]{8}$/;
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

// A document that parsed is not a document that is ready, and `null` is a document like any other:
// a truthiness check on the parse result would drop the four falsy JSON values (0, false, null, "")
// into a "never read" timeout and would crash on null. So every parse result is handed to the shape
// rule, and the shape rules start by rejecting anything that is not a JSON object — naming the value
// they actually saw, so the timeout reason is specific.
const notAnObject = (doc) => 'document is not a JSON object but ' + JSON.stringify(doc);
const isJsonObject = (doc) => doc !== null && typeof doc === 'object' && !Array.isArray(doc);

// The readiness rule for a pending.json INDEX: parseable, a JSON object, a string runId, and a
// non-empty items array. Anything else is "not yet" and is retried rather than accepted.
export function indexReady(doc) {
  if (!isJsonObject(doc)) return notAnObject(doc);
  if (!Array.isArray(doc.items)) return 'document has no items array';
  if (doc.items.length === 0) return 'items is still empty';
  if (typeof doc.runId !== 'string' || !doc.runId) return 'document has no runId';
  return null;
}
// The readiness rule for a per-call file: parseable, a JSON object, with a callId. It has no items
// and no runId, and must not be asked for either.
export function perCallReady(doc) {
  if (!isJsonObject(doc)) return notAnObject(doc);
  if (typeof doc.callId !== 'string' || !doc.callId) return 'document has no callId';
  return null;
}

// Bounded retry until the document is present, non-empty, parseable AND `validate` accepts it
// (validate returns null to accept, or a reason string to keep retrying). Returns the last concrete
// reason on timeout instead of a bare "gave up", so a real failure stays diagnosable rather than
// being retried into green.
export async function settleDocument(rawProvider, { validate, attempts, sleepMs = 25, sleep = sleepDefault } = {}) {
  let lastError = new Error('never read');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const raw = rawProvider();
    if (raw === null || raw === undefined) lastError = new Error('file is missing');
    else if (String(raw).trim() === '') lastError = new Error('file is empty (0 bytes)');
    else {
      // `parsedOk`, not `if (parsed)`: a falsy JSON value parses just as successfully as an object,
      // and routing it on truthiness would report "never read" for a file that was read fine.
      let parsed;
      let parsedOk = false;
      try { parsed = JSON.parse(raw); parsedOk = true; }
      catch (error) { lastError = new Error('file is partial JSON: ' + error.message); }
      if (parsedOk) {
        const problem = validate ? validate(parsed) : null;
        if (problem === null) return { ok: true, value: parsed, attempts: attempt };
        lastError = new Error(problem);
      }
    }
    if (attempt < attempts) await sleep(sleepMs);
  }
  return { ok: false, value: null, attempts, lastError };
}

const reader = (path) => () => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

// Run a script that parks one agent() call, then capture the engine's real index and per-call
// documents. The engine child is always killed, whatever happens.
export async function captureParkedCall({ engine, cwd, script, runId, dir, timeoutMs = 30000, sleepMs = 25 }) {
  const child = spawn(process.execPath, [engine, 'run', script, '--backend', 'file', '--yes', '--run-id', runId], {
    cwd, stdio: 'ignore', env: { ...process.env, WF_PARK_TIMEOUT_MS: String(Math.max(timeoutMs * 2, 60000)) },
  });
  const attempts = Math.max(1, Math.ceil(timeoutMs / sleepMs));
  try {
    const index = await settleDocument(reader(join(dir, 'pending.json')), { validate: indexReady, attempts, sleepMs });
    if (!index.ok) throw new Error('the engine never published a parseable, non-empty pending.json: ' + index.lastError.message);
    const item = index.value.items[0];
    if (typeof item.callId !== 'string' || !CALL_ID_RE.test(item.callId)) {
      throw new Error('the index item callId is not a call id, so the per-call path cannot be derived: ' + JSON.stringify(item.callId));
    }
    // Derived from the index, not from listing pending/.
    const perCallFile = join(dir, 'pending', item.callId + '.json');
    const perCall = await settleDocument(reader(perCallFile), { validate: perCallReady, attempts, sleepMs });
    if (!perCall.ok) throw new Error('the per-call file never settled: ' + perCall.lastError.message);
    if (perCall.value.callId !== item.callId) {
      throw new Error('per-call callId ' + perCall.value.callId + ' does not match the index item ' + item.callId);
    }
    return { index: index.value, perCall: perCall.value, perCallFile, indexAttempts: index.attempts, perCallAttempts: perCall.attempts };
  } finally {
    // Kill AND wait: on Windows the child keeps a handle on the run directory, so a cleanup that
    // runs while it is still exiting fails with EPERM and the case would fail for the wrong reason.
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(done, 5000).unref?.();
    });
  }
}
