---
name: mmx-workflow
description: "Run a multi-subagent orchestration script on this workspace's own dynamic-workflow engine (file backend) inside MiniMax Code. ONLY for an explicit `/mmx-workflow` request. Do NOT use for ordinary questions about workflows, fan-out, parallel agents, or when the user merely talks about running something in parallel."
---

# MMX Workflow (MiniMax Code, own engine, file backend)

A one-file orchestration script fans work out to many isolated MiniMax child Agents. The engine parks
each call on disk; **you** dispatch it with the real `task` tool and write the answer back.

This Skill is the **only** supported entry point for this workspace's own workflow engine on MiniMax
Code. It is deliberately not the official `workflow_start` / marketplace `dynamic-workflow` path — those
are a different product surface with a `pending_review` approval step, and nothing here touches them.

## 0. Gate: `/mmx-workflow` only

**Create or start a run only when the user's current message contains the literal token
`/mmx-workflow`.**

- The token means the user typed the explicit skill command. That single message *is* the user's
  authorization to start this engine's run — see §2, you do not ask again.
- **Natural language never triggers a run.** "帮我跑个工作流", "fan out over these files", "run these
  in parallel", "用工作流审一下" — all of these are ordinary conversation. Answer them conversationally
  or offer that the user can type `/mmx-workflow` to run one. Do not create a run, do not start one, do
  not claim one is running.
- **Not forbidden without the token** (these are read-only and safe at any time):
  - polling or reading an already-running run (`wf.mjs status` / `result`, or reading `out.json`),
  - showing a run's progress, phases or result back to the user,
  - `wf.mjs list` / `paths`,
  - answering a `kind:"question"` item that an **already running** run is blocked on,
  - `resume` / `stop` of a run the user explicitly asks about in this conversation.
- If the user typed `/mmx-workflow` **and** the rest of their message names no script, you author the
  script (§1) and run it. Do not stall on "which workflow do you mean" unless the request is genuinely
  ambiguous about *what* should run.
- The token is matched as a standalone word (`/mmx-workflow` immediately followed by whitespace,
  end-of-message, or a quote). A path like `foo/mmx-workflow.js` is not the token.

**This gate is a policy you follow, not a mechanical lock.** MiniMax Code's skill frontmatter
supports `name`, `description`, `license`, `allowed-tools`, `compatibility` and `metadata`
(`@mavis/local-runtime-v2/.../plugin-system/skill/reader.js`); none of them restricts invocation to
an explicit command, and no `invocation_policy` / `explicit_only` key exists in this host build (the
`invocationPolicy` symbol that does exist is the **sandbox filesystem** policy, a different thing
entirely). So do not invent such a key, do not claim the host enforces this for you, and do not
report "the host blocked it" — the enforcement is that you do not create a run without the token.
What the host *does* prove is the explicit form: the `skill` tool's own description says "Load a
skill when the user explicitly names it (including `/name`)" (`@mavis/agent-tools/dist/desktop/
builtin-defs.js`, `LocalSkillToolDef`). The `@name` form is **not** claimed here: the composer's
mention menu has no skills section.

## 1. Engine, script, check

Engine — this exact file in this workspace. Do **not** use an installed copy under
`~/.minimax/skills/`; the native session hook and the attribution contract both key off this path:

```
G:/qoder-intl-project/else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs
```

`wf.mjs paths` prints every directory in play plus the engine version. Node 20+, zero dependencies.

**Pre-flight, before writing any script.** Two cheap reads, both mandatory:

1. The engine file exists at the exact path above. If it does not, stop and report that the
   workspace engine is missing — do not look for a copy elsewhere, do not install one, do not fall
   back to a different backend.
2. Its version is the one this skill is written against. Read it, do not assume it:

   ```bash
   node -e "const s=require('fs').readFileSync('<ENGINE>','utf8');const m=s.match(/ENGINE_VERSION\s*=\s*'([^']+)'/);if(!m)throw new Error('no ENGINE_VERSION');console.log(m[1])"
   ```

   Expected: **`0.8.1`**. Anything else is a different engine contract — report the version you
   read and stop. Do not "work around" a version you did not expect.

Write the script to `<cwd>/.qoder/workflow-drafts/<label>.js`, then check it before anything else:

```bash
node "<ENGINE>" check "<cwd>/.qoder/workflow-drafts/<label>.js"
```

`check` exits 2 on any error diagnostic. Fix every one of them before launching — a compile or
`forbidden_module` error costs the whole run. The script runs in a sandbox with **no** `require`,
`import`, `process`, `globalThis`, `fetch`, `Date.now()`, argless `new Date()` or `Math.random()`; feed
time and variation in through `args`.

Facade (these names are the whole API):

| Call | Behaviour |
| --- | --- |
| `agent(prompt, opts?)` | One subagent; resolves to its text. `opts`: `label`, `phase`, `json`, `model`, `agent`, `systemPrompt`, `cwd`, `timeoutMs`, `throwOnError`. |
| `parallel(thunks)` | Runs thunks at once, bounded by `--concurrency`. A throwing thunk becomes `{ok:false,error}` — it never rejects. |
| `pipeline(items, ...stages)` | Each item flows through every stage; items run concurrently. |
| `ask(question, opts?)` | Blocking question **to the user**. file backend only. Default timeout 3600 s. |
| `phase(name)` / `log(msg)` | Labels the calls after it / progress line. |
| `notes()` | Strings queued by `wf.mjs steer <runId> "<note>"`. Never blocks. |
| `publish(artifact)` | Registers `{title, kind: file|document|dashboard|text, path?, url?, text?, primary?}`. |
| `args` | Validated against `meta.args` before anything dispatches. |

A failed `agent()` settles as `{ok:false, error}` rather than killing the run — branch on
`typeof x === 'string'` / `x.ok === false`. A prompt over 524288 chars is refused before dispatch and
lands in `out.json.warnings`; `--max-calls` is a whole-run budget, not per resume.

## 2. Launch: check + summary, then start — no second confirmation

An explicit `/mmx-workflow` request is the authorization. Do the validation and the summary, then
launch. Do **not** call an ask/approve tool, do not wait for a click, do not route through the official
`workflow_start` review, and do not claim a run started without actually starting it.

```bash
node "<ENGINE>" run "<cwd>/.qoder/workflow-drafts/<label>.js" \
  --backend file --yes --run-id <id> --concurrency <n> --max-calls <m>
```

- `--yes` answers this run's own confirmation gate. The engine records
  `confirmation { required:false, basis:"flag" }` in `state.json` and `out.json` — that record is the
  audit trail that this was a self-authorized start, not an approval.
- Tell the user, in one short line before launching: the script path, the phase list, the args, and
  the `runId`. That is a **report**, not a question. Then run it.
- Start it as a background task: a file-backend run parks on the first `agent()` and waits for you.
- Long prompts and JSON go through a file: `--args-file args.json`, not a giant `--args` string.

**The authorization covers exactly one action: starting this engine's own run.** It does not
authorize anything else, and it never relaxes a guard:

- capability / Host / Origin checks, `--host-session` origin validation, identity and attribution,
- write boundaries and path containment,
- the `OWNER` exclusive claim that stops two lifecycles interleaving on one run id,
- `check` diagnostics, `--max-calls` budget, and every other engine refusal,
- any command, script or tool call **outside** this workflow. Those keep the host's normal
  confirm/permission path — start the run without asking; ask about everything else as usual.

Never fake a business answer (§5). Never auto-reject, auto-pick a default, or treat a timeout as
consent. Never re-scope the authorization to "anything with a similar name" or "this whole
directory".

## 3. Drive the handshake

The loop has a fixed order, every pass:

1. Read `<runDir>/pending.json` — the **index** first. It is one document whose top level is
   `{ runId, outstanding, items[] }` and it is the only list you dispatch from. It exists even when
   `items` is empty, and it is rewritten by the engine on every change, so a single read is
   consistent enough; a torn read just means "no work this pass".
   - **`runId` lives only here, at the index top level.** It must equal the `--run-id` you passed to
     `wf.mjs run` and the `runId` / `dir` the engine printed for that run. If it does not, you are
     looking at a different run than the one you started: stop and report it, do not dispatch.
   - Each `item` carries only `callId`, `seq`, `phase`, `label`, `prompt`. The requested `model` /
     `agent` / `systemPrompt` / `cwd` are **not** in the index — step 3 is the only place they exist.
2. Check `<runDir>/out.json`. If it exists the run is settled — stop the loop and report (§5).
3. For each `item` in `items[]`, read the **per-call** file `<runDir>/pending/<item.callId>.json`
   before dispatching. Its keys are exactly `callId`, `seq`, `key`, `phase`, `label`, `prompt`,
   `requestedAt`, `model`, `agent`, `systemPrompt`, `cwd` — that is what the engine writes, and it
   carries **no `runId`**. Do not go looking for one, and do not invent one: the per-call file is
   bound to its run by living at `<runDir>/pending/<callId>.json`, and by the index check in step 1.
   The per-call file is the authoritative record of that one call's `prompt` and of the `wants`
   (`model` / `agent` / `systemPrompt` / `cwd`).
4. **Cross-check before you act.** The per-call file must agree with the index item it came from on
   `callId`, and its `prompt` must be the one the index lists. If either differs, treat the whole
   pass as untrusted: do not dispatch it, do not write anything, and report the mismatch. Two files
   claiming to describe one call with different content is exactly the state where a wrong prompt
   gets executed.
5. Also confirm path containment before opening the per-call file: `item.callId` must satisfy
   `^[cq][0-9]{3,}-[0-9a-f]{8}$` and contain no `/`, `\`, `..`, whitespace or `:`; and the resolved
   `<runDir>/pending/<item.callId>.json` must still be inside `<runDir>/pending`. The per-call file's
   own `callId` field must equal the filename's `callId` — a file named `c001-x.json` that says
   `callId: c002-y` is a mismatched pair, not a call.

The engine writes the per-call file first and then the index, so a `callId` can briefly be in
`pending/` without being in `items[]` yet. Dispatch from `items[]` only, never by listing the
directory.

For each item that is **not** `kind:"question"`:

1. Dispatch **one real MiniMax `task` call per item**. The real tool is `task` — not "Agent tool", not
   `qodercli`, not a shell spawn. Its schema is exactly:

   | Field | Required | Meaning |
   | --- | --- | --- |
   | `description` | yes | Short child session title. |
   | `prompt` | yes | The item's `prompt`, verbatim, self-contained. The child has **no** parent history — never write "continue the work above". |
   | `agent_name` | yes | `mavis` (broad/mixed), `explore` (read-only locate+evidence), `worker` (bounded changes), `verifier` (independent review/audit, no project-file changes), or a known custom agent's stable name. |
   | `model` | no | Set **only** if the pending item asked for a specific model. Omit otherwise; never guess, never send `""`. |
   | `effort` | no | Only when the user explicitly asked for an effort level. Omit otherwise. |
   | `run_in_background` | no | `false` to wait for the answer in this turn. |

   `additionalProperties` is `false` — do not add `systemPrompt`, `cwd`, `tools` or any other key.
   The table above is not a guess: it is `LocalTaskToolDef` / `LocalTaskSchema` in
   `G:/MiniMax/MiniMax Code/resources/app.asar` →
   `node_modules/@mavis/agent-tools/dist/desktop/builtin-defs.js` (the role names come from
   `node_modules/@mavis/shared/src/subagent-roles.ts`). If a future host build changes that schema,
   re-read the file rather than trusting this table.
   The pending item's `systemPrompt` and `cwd` are **requests**: honour them by folding `systemPrompt`
   text into the top of `prompt` and stating the working directory inside `prompt`; when the item asks
   for a model or agent the host cannot provide, say so and answer that one call as a failure. Never
   invent an answer because a model was unavailable.
2. Collect the child's final text.
3. Write the answer, then move to the next item.

### Concurrency and budget

Dispatch at most `min(--concurrency, host child-Agent limit)` items per batch; put one batch's items
in a single turn so they genuinely run in parallel. MiniMax Desktop enforces a per-session
child-Agent concurrency limit (default 4) and answers `SUBAGENT_CONCURRENCY_LIMIT` when it is hit —
wait for a running task to finish, then retry; do not hammer retries. `--max-calls` is a hard
whole-run budget, so size the fan-out to it.

### Write the answer safely

Exactly two legal shapes, and nothing else:

```json
{"ok": true,  "text": "<the child's final answer>"}
{"ok": false, "error": "<why it failed>"}
```

or `inbox/<callId>.txt` containing the plain text. A mistyped field name does **not** become a silent
empty answer — the engine fails that call and names the keys it found — but you still have to write it
right.

Before writing anything:

- take `callId` **verbatim** from the `pending.json` index, then from the per-call file, and require
  the two to match. Validate it against `^[cq][0-9]{3,}-[0-9a-f]{8}$` — one to three or more digits
  (`c001-…`, `q000-…`), exactly eight lowercase hex characters. A value with more than one `-`, or
  with a longer hex tail, is not a call id this engine produces: reject it,
- reject path traversal outright, in addition to the pattern: any value containing `/`, `\`, `..`,
  a drive colon `:`, or whitespace is refused, whatever else it looks like. A pattern match alone is
  not permission to build a path out of an untrusted string,
- resolve the target as `<runDir>/inbox/<callId>.json` and confirm the resolved path is still inside
  `<runDir>/inbox` before writing. Containment is the check that matters; the pattern is only the
  first filter,
- create no directories outside `<runDir>`; write exactly one file per callId, exactly once. The
  engine deletes the answer file after journalling the result, so re-writing the same callId would be
  a second, unjournalled write — do not do it,
- prefer the host `write` tool's single write (the engine re-reads a torn file and retries), or write
  a temp file in the same `inbox/` directory and rename it into place. Never append, never write
  outside `<runDir>`.

Answer each `callId` **exactly once**, then loop. `out.json` is the completion mark; an unanswered
park is not free (900 s, or the call's `timeoutMs`, then it settles as a failure saying the host
stopped driving the handshake).

## 4. Business `ask()`: wait, never answer it yourself

An item with `"kind":"question"` is `ask()` waiting for the **user**, not a subagent task. Show the
question text verbatim, write the user's real reply to `inbox/<qId>.json` in the same shape as an
answer, and keep waiting.

Hard rules:

- **Do not fabricate an answer, auto-select a default, guess, summarize your own opinion as the
  user's, or treat a timeout or silence as agreement.**
- Do not "helpfully" pick the option you think they want. If the user is not there, the run stays
  parked and eventually fails loudly; that is the correct outcome.
- `ask()` is file-backend only. If the run is not on `--backend file`, `ask()` throws — do not work
  around it.

## 5. Report the result

Read `out.json` and report `result` to the user. A result over 2000 characters is not echoed to
stdout — the run output carries `resultPreview`, `resultBytes` and a pointer, and the whole value
lives in `out.json` (`wf.mjs result <runId>` prints it). Fetch the full value there; do not
paraphrase the preview as if it were the answer.

Useful companions, all read-only unless stated:

- `wf.mjs status [runId]` — one row per run folder, always. `status:"stale"` with `staleReason` means
  the engine process died: `wf.mjs resume <runId>`. Do **not** `stop` a stale run you meant to finish —
  `stop` settles it `cancelled` and writes an `out.json` the next lifecycle has to look past.
- `wf.mjs resume <runId> [--script <path>]` — replays every settled call from the journal and
  dispatches only the rest. `resume` refuses `--args` that differ from the run's original args.
- `wf.mjs stop <runId>` — only for "cancel this, I do not want the result".
- `wf.mjs steer <runId> "<note>"` — queue a note the script can read at its next `notes()`.
- `wf.mjs trust <name>` / `untrust <name>` — permanent trust for a **saved** workflow, bound to its
  content hash in `<cwd>/.qoder/dynamic-workflow-trust.json`. Editing the script revokes it
  (`basis:"script-changed"`). `--yes` covers this run only; do not reach for `trust` on a user's
  behalf just to skip a step you were already authorized to skip.
- `wf.mjs save <script> --name N [--scope project|global]` — save only after a run completed; run it
  with `--saved N`.

## 6. What this Skill is not

- Not the official MiniMax `workflow_start` / marketplace `dynamic-workflow` path. That one returns
  `pending_review` and needs **Start execution** in the panel, and there is no approve API. Never
  route this engine's runs through it, never present one as the other, and never claim an official
  approval you did not get.
- Not a general "run things in parallel" shortcut. Without the `/mmx-workflow` token there is no run.
- Not a licence to execute commands outside the run. The script sandbox already refuses
  `require`/`import`/`process`/`fetch`; do not go around it from the host side.
