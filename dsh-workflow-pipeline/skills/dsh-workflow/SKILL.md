---
name: dsh-workflow
description: "Run a self-owned multi-subagent workflow on DSH's file backend. Invoke only when the user types the /dsh-workflow gesture, or names this skill explicitly."
user-invocable: true
disable-model-invocation: true
---

# DSH workflow (own file-backend engine)

Runs a JavaScript orchestration script through **this project's own `wf.mjs` engine** on the
`file` backend, and drives the parked calls with DSH's own subagent tools. It does **not** use
DSH's built-in `workflow` tool, does not touch the host's configuration, and never falls back to
a CLI backend.

## Invocation is the only authorization

Start this skill **only** when the user's own message contains the gesture `/dsh-workflow`
(at the start of the message or after whitespace, followed by whitespace or end of message —
that is the exact shape DSH's loader recognises), or when the user explicitly names
`dsh-workflow` in the same message. Do not start it because a request "looks like" a workflow,
and do not offer it as an option on your own initiative.

The gesture **is** the run authorization. Once it is present:

- **Do not** ask the user to confirm the run with `ask_user_question`, a confirmation tool, or a
  natural-language "shall I proceed?".
- **Do not** re-check with the user because the run looks long, expensive, or broad.
- **Do not** wait for a plan-mode approval to start; if plan mode is active, follow plan mode.
- Do run `check` first and show its summary, then `run --yes` immediately, in the same turn.

A *business* question the script asks through `ask()` is a different thing, and it is the one
thing you must not decide for the user. `ask()` parks a question; the engine holds the call until
a real answer lands in the run's inbox, and a run that never gets one eventually fails that call
with a park timeout. Relay the question, keep the run pending, and wait. Never invent an answer,
never paraphrase one the user did not give, and never convert "no answer yet" into `ok:true`.

## Locate the engine

`wf.mjs` is the shared engine, not a copy. Look for the first path that exists:

1. `<this skill dir>/../dynamic-workflow/runtime/wf.mjs` — the sibling skill in the same user
   skills root.
2. `G:/qoder-intl-project/else/plugins/dynamic-workflow/skills/dynamic-workflow/runtime/wf.mjs` —
   the source of record in the workspace.

Then **verify it before launching anything**. `wf.mjs` exports `ENGINE_VERSION`, currently
`0.8.1`; the file-backend handshake this skill depends on — `pending/<callId>.json` with the four
`wants` fields, `inbox/<callId>.json` answers, the park timeout — exists in that line and not
necessarily in an older one. So:

```bash
node -e "import('file:///…/wf.mjs').then(m => console.log(m.ENGINE_VERSION))"   # expect 0.8.1
node --check <engine>                                                            # syntax
```

If the file is missing, `node --check` fails, or `ENGINE_VERSION` is not `0.8.1`, say so plainly
and stop. Do not search the disk, do not install anything, do not edit the engine, and do not
switch to `--backend cli` or `qodercli`: a file backend that cannot reach a matching engine is a
blocked run, not a reason to spawn a different one.

## Run it

```bash
node <engine> check <script.js> --args '<json>'   # exits 2 with diagnostics on refusal
node <engine> run   <script.js> --args '<json>' --backend file --yes
```

- `--backend file` is mandatory. The engine parks each `agent()` call on disk; you answer them.
- `--yes` is a **flag, not a check**. `confirmationFor()` returns `{ required: false, basis: 'flag' }`
  the moment it sees `flags.yes || flags.trusted` — it does not compare the script's content hash,
  it does not consult the trust list, and it writes nothing. It unconditionally releases *this one
  invocation's* start confirmation. So the script review is **your** job before you pass it: run
  `check` first, read the script you are about to launch, and only then launch.
  `--yes` writes no trust entry and does not touch `<cwd>/.qoder/dynamic-workflow-trust.json`; only
  `wf.mjs trust <name>` writes that file. Never run `wf.mjs trust` and never set a trust wildcard —
  a content-hash-bound trust list is exactly the thing the user must grant, not assume.
- Add `--concurrency N` (1..32, default 8) and `--max-calls N` (default 500) only when the task
  needs them; report both in the summary.
- Run inside the user's working directory so the run dir lands under that project's
  `.qoder/workflow-runs/`. The engine reads `DSH_SESSION_ID` from the environment and records it
  as the run's native `hostSession`; that is what the DSH sidebar line binds to. Do not set it
  yourself.

Report the `runId` and the check summary. Then poll until the run settles.

## Drive the parked calls

`wf.mjs status <runId>` reports the run `dir` and an `outstanding` list of
`{ callId, phase, label }`.

**`pending.json` is a summary; it is not the source of truth for a call.** It is rewritten on
every dispatch as `JSON.stringify(..., null, 2)` of the in-memory queue, so a host reading it
mid-rewrite can see a torn batch — the engine's own comment says as much and points the reader at
the per-call file. For every `callId` you are about to answer, read
**`<dir>/pending/<callId>.json`**, which carries the full `prompt` plus the four `wants` fields
`model`, `agent`, `systemPrompt`, `cwd` and the `requestedAt` timestamp. Use `pending.json` only
to learn *which* `callId`s are outstanding.

**Validate the `callId` before it touches a path.** The engine mints it as
`` `c${String(nth).padStart(3, '0')}-${sha256(...).slice(0, 8)}` `` — a literal `c`, at least three
digits, a `-`, then eight lowercase hex characters — so a real id always matches
`/^c[0-9]{3,}-[0-9a-f]{8}$/`. Refuse anything that does not, and refuse any id containing `..`,
`/`, `\`, a drive letter or a leading `~`. Take the id verbatim from the per-call file's own
`callId` field, join it under `<dir>/inbox/`, and never build that path out of a title, a label or
anything else you inferred.

For each outstanding call, dispatch one subagent and write the answer back:

```
<subagent tool>(description: <label>, prompt: <the full prompt from pending/<callId>.json>)
   -> write <dir>/inbox/<callId>.json  {"ok":true,"text":"<the subagent's answer, verbatim>"}
   -> or <dir>/inbox/<callId>.txt     (the plain answer text)
   -> or, when the subagent could not do the work: {"ok":false,"error":"<why>"}
```

Re-read the outstanding set after each round: new calls appear as the script advances. Never write
an answer file for a `callId` that is no longer outstanding, and never edit `progress.json`,
`state.json`, `out.json` or the journal by hand — the engine owns those.

**Never fabricate an answer.** `{"ok":true,"text":…}` must carry what a real subagent actually
returned. If the dispatch failed, the tool was unavailable, the user has to decide something, or
you ran out of budget, write `{"ok":false,"error":"<the real reason>"}` or leave the call
outstanding and say so in your report. `parallel()` never rejects — a failed call becomes `null` in
the results array — so a fabricated success is invisible to the script and becomes a false result
in `out.json` for the rest of the run's life.

The exact tool name for dispatch depends on this host's registration, and it is not guaranteed.
Read the tool list you were actually given and pick the first that exists:

| Order | Tool | What it is |
| --- | --- | --- |
| 1 | `subagent` | The core delegation tool (`tool-subagent`, `toolName: subagent`, provider `spawn`, `backgroundMode: continuable` in the `standard` preset). Foreground call: set `run_in_background: false` and take the returned result directly. |
| 2 | `subagent_fork` | Same tool on provider `fork`; the child sees this conversation's completed turns. |
| 3 | `send_message` | Steers a continuable child at its nearest step boundary, starts an idle one. Only usable once a background run exists. |
| 4 | `list_agents` | Roster of the Lead and its teammates. |
| 5 | `spawn_teammate`, `wait_agent`, `interrupt_agent`, `team_task_*` | Agent Teams, and only when a Team is active in this session. |

If **none** of those tools is present in your tool list, this host cannot dispatch subagents.
Say exactly that — "this session has no subagent tool, so the file backend has no host to answer
its parked calls" — write no inbox files, and stop. Do not emulate a subagent yourself, do not
answer a call from your own context, and do not claim the run started.

A background `subagent` returns a durable id and reports its outcome to you when it settles;
`run_in_background: true` is only correct when the next action does not depend on that result.
`list_subagent_models` (optional) lists child routes; the pending item's `model` /
`systemPrompt` / `cwd` requests are requests — honour them when the tool accepts them, and say
in the summary when you did not.

## While it runs

- `--backend file` gives up on an unanswered park after 900 s (`WF_PARK_TIMEOUT_MS` retunes it,
  or `timeoutMs` on the call). Answer promptly; a call that expires is reported as a failure and
  the script sees `null` for that slot.
- `parallel()` never rejects: a failed call becomes `null` in the results array. Count the nulls
  before summarising, and name which calls failed and why.
- `wf.mjs status <runId>` for progress, `wf.mjs steer <runId> "<note>"` to add guidance the script
  will pick up via `notes()`, `wf.mjs stop <runId>` to cancel.
- Exit codes: `0` ok, `1` the run failed or a command errored, `2` usage/args/source/check
  refused, `3` refused (a live process holds the run, or it already settled).

## Report

When the run settles, `wf.mjs result <runId>` prints `out.json`. A result over 2 000 characters
is not echoed to stdout — stdout carries `resultPreview`, `resultBytes` and the pointer instead,
and the whole value is only in `<dir>/out.json`. So **read `<dir>/out.json` and report the real
value**; `resultPreview` is a truncated head, never the result. If `out.json` is missing or
unreadable, say the result is unavailable — do not summarise the preview as if it were complete.
Then report:

- the `runId` and the run's directory;
- the script's `meta.name`;
- `agentDispatched` / `agentSettled` / `agentFailed` / `agentRejected` for the whole run;
- the returned value, summarised — plus the raw `out.json` pointer rather than a wall of text;
- every failed call with its recorded `error`, and every parked call you could not answer;
- any `model` / `agent` / `systemPrompt` / `cwd` request the pending item carried that the
  dispatch tool did not honour.

Never present a partial run as a completed one, and never invent counts the status or `out.json`
does not report.
