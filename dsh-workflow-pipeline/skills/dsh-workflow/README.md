# dsh-workflow — install

`SKILL.md` is the whole skill. It carries no runtime of its own; it drives the shared
`wf.mjs` engine (expected `ENGINE_VERSION` `0.8.1`), which it locates and version-checks at run time.

## Where the official loader looks

`@deepseek-ai/dsh-skill-filesystem` (0.1.5-rc.2, `lib/index.js` `roots()`) scans, in rank order:
`<project>/.dsh/skills`, `<project>/.agents/skills`, every configured `customSkillDirs`,
`$DSH_HOME/skills`, `$DSH_AGENTS_HOME/skills`, and `$DSH_BUNDLED_SKILL_DIR`. A root entry may be
`<root>/<name>/SKILL.md` or `<root>/<name>.md`.

There is no `dsh.skills` field in a package manifest on this core line, so a plugin cannot
contribute a skill without a `customSkillDirs` config in a patch layer. **This skill therefore
ships as a user skill**, the one discovery path that needs no host configuration.

The reader is `readSkillText()` → `ctx.fs.resolve` → `ctx.fs.stat` (must be type `file`) →
`ctx.fs.readText`, and every absent-path error is swallowed as "no skill". Invalidation comes from
a `chokidar`/`fs.watchFile` watcher over the roots plus a `fs/observed` hook for host-tool writes
(`edit` / `write` only). `watch` defaults to **true**; only an explicit patch entry turns it off.

## Install (one new directory, nothing else touched)

```bash
# live home — the instance the 3188 appserver actually serves
cp -r "G:/qoder-intl-project/else/dsh-workflow-pipeline/skills/dsh-workflow" \
      "C:/Users/datoo/.dsh-zcode-dev/skills/dsh-workflow"

# harness instance — the one that has @dsh-external/dsh-workflow-pipeline installed
cp -r "G:/qoder-intl-project/else/dsh-workflow-pipeline/skills/dsh-workflow" \
      "C:/Users/datoo/AppData/Roaming/dsh-desktop-dev/harness/skills/dsh-workflow"
```

Substitute the target `$DSH_HOME` for any other instance (`~/.dsh`, …). This only creates one new
subdirectory. It does not edit any `package.json`, any `cordis.patch.yml`, or any other skill, and
it does not copy `node_modules`.

To re-sync a copy that already exists, overwrite `SKILL.md` and `README.md` in place rather than
re-creating the directory, and check the SHA-256 of both files against the source.

## Activation — per instance, and only evidence from that instance

Do not generalise one instance's watch setting to another, and do not read it off the bundle: the
bundle's preset default is only the fallback. In both instances below `settings.yaml` sets
`agent-presets.default: ptc`, so **`ptc` is the effective preset**, not the bundle's `standard`.

- **Live home `C:/Users/datoo/.dsh-zcode-dev`** — `settings.yaml:17-18` sets
  `agent-presets: default: ptc`. That effective preset is
  `runtime-dsh015/node_modules/@deepseek-ai/dsh-agent-presets/presets/ptc/agent.cordis.yml`, whose
  lines 91-92 register `skill-filesystem` **with no `config:` block at all**. `watch` therefore
  falls back to the `Config` default `true`. Its `profiles/web/cordis.patch.yml` contains no
  `skill-filesystem` entry. *Configuration fact only:* `watch: true` is what the effective preset
  resolves to. It does **not** mean a running host has re-read the root, and it does **not** mean
  the watcher has already picked this directory up.
- **Harness `…/dsh-desktop-dev/harness`** — `settings.yaml:3-4` also sets
  `agent-presets: default: ptc`. Its effective preset,
  `profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/ptc/agent.cordis.yml`, sets
  `config: watch: false` **directly on the `skill-filesystem` row (lines 91-94)**. That preset file
  is the primary evidence. The identical `watch: false` entry in
  `profiles/web/cordis.patch.yml` only restates it for the same `id` and is redundant — do not
  attribute the effect to the patch. With `watch: false`, discovery on that instance is static and
  runs at boot, so a newly written root is not available to a session that is already running.

**Runtime discovery is unverified on both instances.** `parseSkillFile` only
`ctx.logger.warn`s when it *rejects* a file, so a successful load logs nothing: log silence is a
negative-only signal and can never prove a load. Neither is a file mtime. The only positive proof
is the skill appearing in the `dsh-client-ui-skill` `/` menu, or loader behaviour observed on the
instance itself.

`dsh-client-ui-skill` then lists the skill in the `/` menu, and the model reaches it only through
the `/dsh-workflow` gesture — the file sets `disable-model-invocation: true`, so no
natural-language path can claim it.

## What this skill does NOT fix

The plugin's sidebar progress line keys off the official 0.2.0-rc.2
`data-row-key="session:<id>"` contract. The 0.1.5-rc.2 core that both instances above actually run
emits neither `data-row-key` nor `data-session-id` in its official client packages, so on that line
no sidebar row resolves to a session and no row gets a line. That is a host-version fact, not a
plugin defect, and it is not something this skill changes.
