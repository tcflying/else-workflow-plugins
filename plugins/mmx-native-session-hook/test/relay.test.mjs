import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHostSessionFlag, shouldAppendFlag, appendFlag, handle } from '../scripts/relay.mjs';

const relay = fileURLToPath(new URL('../scripts/relay.mjs', import.meta.url));
const ENGINE_CMD = 'node "G:/mmx-project/zcode动态工作流-原else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs" run task.mjs --run-id demo';
const spawnRelay = (event) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [relay], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, out, err }));
  child.stdin.end(JSON.stringify(event));
});
const preToolUse = (command, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'bash', session_id: 'sess-mm-1',
  cwd: 'G:/mmx-project/zcode动态工作流-原else', tool_input: { command }, ...extra,
});

test('matching engine run commands gain the exact native hook session flag', async () => {
  const result = await spawnRelay(preToolUse(ENGINE_CMD));
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  const flagged = parsed.hookSpecificOutput.updatedInput.command;
  assert.ok(flagged.startsWith(ENGINE_CMD + ' '), 'the original command text is preserved');
  const decoded = JSON.parse(Buffer.from(flagged.match(/--host-session (\S+)/)[1], 'base64url'));
  assert.deepEqual(decoded, { host: 'mmx', sessionId: 'sess-mm-1', source: 'native-hook' });
});

test('non-matching events, commands and malformed stdin stay silent (fail-open)', async () => {
  for (const event of [
    preToolUse('node other.mjs run x'),
    preToolUse(ENGINE_CMD.replace(' run ', ' resume ')),
    preToolUse(ENGINE_CMD + ' --host-session AAAA'),
    preToolUse(ENGINE_CMD, { tool_name: 'read' }),
    { ...preToolUse(ENGINE_CMD), hook_event_name: 'PostToolUse' },
    preToolUse(ENGINE_CMD, { session_id: '' }),
    'not json at all',
  ]) {
    const result = await spawnRelay(event);
    assert.equal(result.code, 0);
    assert.equal(result.out.trim(), '', 'no output for ' + JSON.stringify(event).slice(0, 60));
  }
});

test('flag helpers keep the contract local and reversible', () => {
  assert.equal(shouldAppendFlag(ENGINE_CMD), true);
  assert.equal(shouldAppendFlag(ENGINE_CMD.replace('G:/', 'g:\\')), true, 'case and separator insensitive matching');
  assert.equal(shouldAppendFlag('node C:/other/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs run x'), false, 'a foreign engine copy never matches');
  assert.equal(appendFlag('a  ', '--host-session X'), 'a --host-session X');
  assert.equal(buildHostSessionFlag(''), null);
  assert.equal(buildHostSessionFlag('x'.repeat(300)), null);
});

// Regression: original four independent attribution-safety assertions, unchanged.
const engine='G:/mmx-project/zcode动态工作流-原else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs';
const sid='mvs_00000000000000000000000000000001';
async function patched(command){const value=await handle(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'bash',session_id:sid,tool_input:{command}}));return value?JSON.parse(value).hookSpecificOutput.updatedInput.command:null;}
test('single supported engine invocation gets exact native attribution',async()=>{
 const out=await patched(`node "${engine}" run fixture.js`);assert(out.includes('--host-session '));
 const token=out.split('--host-session ')[1];assert.deepEqual(JSON.parse(Buffer.from(token,'base64url').toString()),{host:'mmx',sessionId:sid,source:'native-hook'});
});
test('compound command must decline or attribute the engine, never append to echo',async()=>{
 const out=await patched(`node "${engine}" run fixture.js && echo done`);
 assert(out===null||out.split('&&')[0].includes('--host-session '),'actual helper appends only after echo; engine argv misses attribution');
});
test('trailing comment must decline or keep attribution outside comment',async()=>{
 const out=await patched(`node "${engine}" run fixture.js # local annotation`);
 assert(out===null||out.split('#')[0].includes('--host-session '),'actual helper appends inside comment');
});
test('echo of exact engine path is not an engine invocation',async()=>{
 assert.equal(await patched(`echo "${engine}" run fixture.js`),null);
});

test('narrow literal command grammar rejects shell syntax and keeps supported quoting', () => {
  for (const suffix of [' | cat', ' ; echo done', ' > out.txt', '\n echo done', ' $(echo x)', ' `echo x`', ' --']) {
    assert.equal(shouldAppendFlag(ENGINE_CMD + suffix), false, suffix);
  }
  assert.equal(shouldAppendFlag('node "G:/wrong' + engine + '" run x'), false);
  assert.equal(shouldAppendFlag(ENGINE_CMD + ' "--host-session=X"'), false);
  assert.equal(shouldAppendFlag(ENGINE_CMD + ' "unterminated'), false);
  assert.equal(shouldAppendFlag("node '" + engine + "' run 'fixture with spaces.js'"), true);
  assert.equal(shouldAppendFlag(ENGINE_CMD.replace('node ', 'node.exe ')), true);
});
