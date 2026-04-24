# Changelog

Reverse-chronological. Versions track git tags. Format inspired by [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed

- **Self-recheck adaptive scoring is less Anglophone-biased.** The structure-score signal set was built against English CC-style replies and under-counted Cyrillic markdown prose — GLM answers with `### Заголовок` / `**label** — …` / unicode-bullet lists routinely scored 0 and got skipped by `requireStructureScore`. Added four signals: markdown headings `^#{1,6} …`, em-dash definition lists `**label** — …`, unicode bullet characters (`•`, `●`, `▪`, `–`, `—`), and numbered lists using `)` instead of `.`. New optional `adaptiveTrigger.longAnswerBypass` field (default 2000 chars) lets very long prose answers bypass the structure / `requireToolUseOrCode` gates — a 2-screen answer is worth a recheck regardless of markdown density. Ack/factual-ask regexes and the cooldown still apply regardless of length. Set `longAnswerBypass: 0` to disable the bypass entirely.

### Changed

- **Self-recheck is now a side-channel pass.** Previously the extension injected its critique as real assistant turns via `sendUserMessage`, which polluted the transcript with two extra turns, rendered in full colour, and counted against the context window of every subsequent turn. Recheck now calls `completeSimple(ctx.model, …)` directly and renders the defect list and patch via `ctx.ui.notify(..., "info")` — the same muted style the Session Summary panel uses. Recheck output no longer enters the session message history, so context usage is unaffected, compaction can't replay recheck content as "real conversation", and the recheck itself can't trigger another recheck by definition. Fire-and-forget: the main agent loop returns immediately; notifications appear as each stage resolves. The `opus-pack:recheck:completed` event (used by plan-mode) fires unchanged, with outcomes `no-defects` / `corrected` / `legacy` / `failed`.

### Added

- **Self-recheck adaptive trigger + optional classifier.** `selfRecheck.adaptiveTrigger` (off by default) adds four heuristic gates that run before a recheck fires: regex skip for ack-only or short factual user messages, cooldown of N user-turns between auto-fires, a "structure score" threshold on the assistant output (code blocks, long lists, tables, file paths), and a "require tool use or code" check. Tuning fields: `requireStructureScore`, `requireToolUseOrCode`, `cooldownUserTurns`, `skipIfAckOnly`, `skipIfFactualAsk`. `selfRecheck.classifier` (off by default) adds an optional final YES/NO gate that calls the currently active model with a short classifier prompt; results are cached per session by answer hash, and any failure / timeout / unparsed reply falls back to firing so a broken classifier can't silently disable recheck. `/recheck now` still bypasses every gate.
- **Self-recheck two-stage flow.** `selfRecheck` now splits its critique into two follow-up turns by default: stage 1 asks for at most 7 real defects, one line each (`<where>: <wrong> → <should be>`); stage 2 emits a *minimal patch* — one bullet per defect, no full rewrite, no restated sections. Each stage is a separate assistant message so defects and the fix are visually distinct in the transcript. This replaces the previous behavior where the corrected turn re-produced the full answer (often longer than the original). `selfRecheck.twoStage = false` (or a non-empty `selfRecheck.prompt`) falls back to the legacy single-message behavior. New optional config: `defectsPrompt`, `correctedPrompt`.
- **Plan-mode defers the "what next?" dialog while self-recheck is running.** Previously the Execute/Refine/Stay modal appeared on the pre-recheck plan draft, so the user had to decide before the corrected version arrived. Plan-mode now checks shared recheck state (`lib/self-recheck-state.ts`) and skips the dialog on the triggering `agent_end`; the dialog appears after the corrected turn ends.

### Changed

- Self-recheck internals moved to `lib/self-recheck-state.ts` (shared state + pure `willRecheckFire` predicate + `isRecheckInProgress`) so other extensions can coordinate without reaching into a closure.

- **Provider-neutrality.** The pack no longer assumes Anthropic.
  - `opus-pack.subagent.modelAlias` (`fast` / `balanced` / `slow`) swaps providers with a single settings change instead of editing every agent frontmatter.
  - `model-router.levels` ships empty by default. `_levels_example_{anthropic,openai,ollama}` stubs live alongside for copy-paste.
  - `claude-md-loader` also scans `~/.codex`, `~/.gemini`, `~/.pi` in addition to `~/.claude`.
  - `skills.ts` registers four roots: `~/.{claude,codex,gemini,pi}/skills`.
  - `safe-deny` now also protects `~/.codex`, `~/.gemini`, `~/.openai`, `~/.anthropic`.
  - `model-router.parseRetryAfter` handles OpenAI-style `retry-after-ms` and `x-ratelimit-reset-{requests,tokens}[-ms]` headers.
  - `cost.ts` shows `—` instead of `$0.00` when pricing is unknown.
  - `status.ts` footer slot renamed `90-opus` → `90-pack`.
  - `claude-total-memory` references removed. Bring your own MCP via `~/.pi/agent/mcp.json`.
  - `meridian` (Claude-Max proxy) moved behind `ANTHROPIC=1 ./install.sh`.
- **Plan-mode MCP gate.** While plan mode is active, every MCP tool invocation (pi-mcp-adapter direct tools, unified `mcp` proxy, or anything matching `opus-pack.planMode.mcpPattern`) prompts the user with `Allow (session) / Allow once / Deny (session) / Deny once`. Session decisions are cached in-memory only and cleared on every exit from plan mode, finalize, `/plan-resume`, and `exit_plan_mode`. Headless runs fall back to `opus-pack.planMode.nonInteractivePolicy` (default `deny`). Approval-dialog previews redact values of sensitive-looking keys (`token`, `api_key`, `password`, `secret`, `auth`, `cookie`, `session`) so MCP args can't leak into the TUI.
- **`/opus-pack` drift warning.** The config modal and statusline flag `extensions/*.ts` files that exist on disk but aren't registered in `OPUS_EXTENSIONS`, so new extensions can't silently ship uncategorized.
- **`/plan-resume`** — reload a saved plan from `.pi/plans/*.md` across sessions. Picker when called without args, substring match with args.
- **Plan progress writeback.** `turn_end` writes `done_steps` back into the plan file's frontmatter as `[DONE:N]` markers land. `finalizePlan` flips `status` to `completed` or `closed`.
- **`/plan-close`** — manual escape hatch when the model forgets `[DONE:N]` on the last step.
- **`/extensions` health dashboard.** Replaces the previous flat list. Shows every pack extension grouped by category with enabled/disabled state plus aggregate slash-command and tool counters.
- **`file-commands.ts`** — file-based slash commands with YAML frontmatter. Scans `~/.{pi,claude}/commands` + `<cwd>/.{pi,claude}/commands`. Subdirectories become `plugin:name` namespaces. `$ARGS` and `$1..$9` substitution. Drops in CC-format commands unmodified.
- **`deferred-tools.ts`** — feature-flagged MCP tool hiding. `tool_search` + `tool_load` proxies expose MCP tools on demand, keeping the prompt small when the MCP park is large.
- **`log-tail` watch mode.** `log_tail({watch: true})` subscribes a path; new lines arrive as a hidden context-message on every turn without polling.
- **Subagent jsonl persistence.** Every `runSingleAgent` invocation writes message events to `.pi/agents/<runId>.jsonl`. New `continue_from` parameter loads the previous run, compresses it into a summary, and prepends to the agent's system prompt for cross-run continuity.
- **Statusline shell command.** `opus-pack.statusLine.command` runs a user-defined shell script; its first stdout line lands in slot `85-shell`.
- **Multi-layer permissions merge.** Permissions now composite four layers in precedence order: `<cwd>/.pi/settings.local.json`, `<cwd>/.pi/settings.json`, `~/.pi/agent/settings.local.json`, `~/.pi/agent/settings.json`.
- **Bundled agents actually load.** `discoverAgents` previously only scanned `~/.pi/agent/agents/`; the pack's own profiles in `agents/` and `extensions/subagent/agents/` were invisible. Fixed by adding a `bundled` layer that resolves relative to `import.meta.url`. Priority: `bundled < user < project`.
- **Real diff-preview for `write`.** `permissions.ts` reads the on-disk file, computes a line diff, and renders unified hunks with ±2 lines of context instead of showing only the first few lines of the new content.
- **Line numbers in `edit` previews.** `indexOf(oldText)` supplies an approximate line number in each hunk header.
- **`iteration-guard` config.** `opus-pack.iterationGuard.{defaultCap, extendBy}` replaces the hard-coded `40` / `+20`.

### Fixed

- **Subagent `continue_from` path traversal.** The `runId` is now validated against `^[\w.-]+$` before being interpolated into a filesystem path.
- **Deferred-tools turn semantics.** Previous `turn_end` cleared `tempVisible` before the next provider request could see loaded tools, defeating the whole purpose of `tool_load`. A `loadedThisTurn` flag now keeps tools visible for one additional turn.
- **Deferred-tools mid-session toggle.** Turning the extension off mid-session now restores the full tool list instead of leaving MCP tools silently hidden until `/reload`.
- **Subagent `runId` collisions.** `crypto.randomBytes(3)` replaces `Math.random().toString(36).slice(2, 5)`, lifting the collision space from ~46k to ~16M per second bucket.
- **Log-tail line splitting.** `readNewBytes` trims the read buffer back to the last newline when truncated, so a line split across two pushes arrives whole on the second push.
- **File-commands symlink safety.** `lstatSync` + `MAX_WALK_DEPTH` prevent infinite recursion on symlink loops (`.claude/commands/loop → ..`).
- **Plan-mode stale checklist.** On the next user prompt after a plan completes, the widget and status slot now clear even if `agent_end` missed the `every(completed)` check.
- **Plan-mode false-positive on quoted args.** `HARD_BLOCK_PATTERNS` used to match the whole command string, so `grep 'curl …'` tripped the curl denylist on its own argument. Quoted-string literals are now blanked before the scan; command substitution (`$(…)`, backticks) stays visible to the denylist.
- **`install.sh` deep-merge.** The `opus-pack` block is deep-merged via `jq *` instead of being overwritten. User-added permissions rules and `subagent.modelAlias` entries survive `./update.sh`.

### Changed

- **Empty arrays in `settings.json.example`.** `rules`, `compactHints`, `modelRouter.rules` ship empty. Defaults live in `_example_*` sibling blocks because `jq *` replaces arrays rather than appending, and we'd rather not clobber user changes on update.
- **Node ≥18.** `engines.node` pins the minimum. Peer dependencies `@mariozechner/pi-{ai,coding-agent}` pin to `>=0.67` to avoid silent breakage on core rewrites.

### Removed

- **`claude-total-memory` references.** The MCP server belongs to the user's global config, not to this pack.

## Historical tags (v0.1 – v0.6)

See `git log --oneline`. These tags predate the provider-neutrality work and assume an Anthropic-only setup.
