<!-- ## Opus Pack rules START -->

## Opus Pack rules

### Style

- Granular commits — one logical change per commit.
- Prefer `edit` over `write`. Don't create new files when editing existing ones works.
- Commit messages explain *why*, not *what*.

### Discipline

- **Verify before claim.** Run the command, read the output, then assert. "Should work" is a guess, not a claim.
- **No unverified generalizations.** If you're making a factual claim about the codebase, architecture, features, or configuration — read the relevant files or run a command first. "I think", "most likely", "probably" about project specifics are red flags: verify or say "I don't know, need to check".
- **Root cause before fix.** Don't paper over symptoms with workarounds. If the symptom is unclear, invoke the `systematic-debugging` skill.
- Don't write "what the code does" comments. Reserve comments for *why* on non-obvious code: hidden constraints, workarounds, surprising invariants.
- Never `git commit --no-verify`, `git push --force` on `main`/`master`, or `rm -rf` without an explicit request from the user.

### Plan mode

- `/plan` or `Ctrl+Alt+P` enters read-only exploration. Produce a numbered plan; the user confirms before execution.
- On approval the plan steps are installed in the `todo` list. Drive execution progress with the normal `todo start <id>` / `todo done <id>` tool — plan-mode mirrors done-state into the saved plan file.
- Never modify code in plan mode — analysis and planning only.
- `/plan-resume` reloads a saved plan across sessions; `/plan-close` is the manual escape hatch when a plan stalls.

### Tasks (todo discipline)

- For multi-step work (3+ steps), create `todo` entries first, then `todo start <id>` → work → `todo done <id>`.
- **Exactly one `in_progress` task at a time.** Starting a new one returns the previous active task to `pending`.
- Don't use `todo` for trivial single-file, single-edit work.
- Batches: `todo add texts:[...]` to drop the entire plan in one call; `todo done ids:[...]` to flush a closing wave of completed steps.

### Parallel execution (todo dispatch + subagents)

- Independent steps that can run concurrently: `todo dispatch ids:[3,5,7]` flips them into `dispatched`, then call `subagent({tasks:[...], concurrency:N})` (via the installed `pi-subagents` extension) with one task per id. After subagents return, close the batch with `todo done ids:[3,5,7]`.
- `dispatched` does NOT consume the single-active `in_progress` slot — you can have one local `in_progress` task plus N delegated `dispatched` tasks at the same time.
- **Recovery**: if a subagent fails or times out, `todo start id:<N>` flips that single dispatched task back into `in_progress` so you take it over locally.
- **Orphan watchdog**: if the same set of `dispatched` ids sits unchanged for several turns, the todo extension nags you to either `done` them (subagents already returned) or `start` them (take over). Don't ignore it — that's how plans hang silently.

### Long-running tasks

- **One-shot (build / test / migration):** invoke a subagent through the installed `pi-subagents` extension — `/run scout "…"` or the `subagent` tool with `{ agent: "scout", task: "…" }`. `scout` uses `model: alias:fast` (resolved by `pi-subagents` against your configured alias map) and returns a structured result.
- **Watch / dev-server:** pi-native detach.
  ```
  cmd > /tmp/pi-bg-<slug>.log 2>&1 & echo $! > /tmp/pi-bg-<slug>.pid
  ```
  Track output with `log_tail("/tmp/pi-bg-<slug>.log", from=<offset>)` (incremental by offset). Kill with `log_kill(pid=<N>)`. Status bar shows `bg:N` live tasks. Pass `watch: true` to have new lines pushed to the conversation automatically.
- **Blocking bash** is the default. Don't background with `&` without a pidfile — you'll lose control.
- `/bg` lists live tasks: tail log, kill, clean up stale pidfiles.

### Skills

- The skills catalogue is injected into the system prompt as `<available_skills>`. The pack scans `~/.{claude,codex,gemini,pi}/skills` in addition to pi's defaults.
- When a skill description matches the task, `read(<location>)` its body **before** acting. Never guess skill contents.

### exit_plan_mode tool

- When the plan is ready, call `exit_plan_mode(plan, save?)`. pi prompts the user for confirmation and switches to execution on approval.
- Pass `save` to persist the plan into `.pi/plans/<ts>-<slug>.md` (or enable `opus-pack.planMode.autoSave`).
- As execution progresses, `todo done <id>` is mirrored to the plan file's `done_steps` frontmatter for cross-session resume via `/plan-resume`.

### Compaction

- Built-in pi `/compact [focus]` passes its inline focus into `customInstructions`. The `smart-compact` extension merges it with configured hints (`.pi/compact-hints.md` / `opus-pack.compactHints`) so active work context isn't dropped.

### Model router

- When `modelRouter` is enabled, each prompt is matched against the configured rules and the turn runs on the chosen model + thinking level.
- `/router <level>` overrides the choice for one turn. `/router status` prints the last five decisions plus current config. `/router off` / `/router on` toggles for the session.
- Provider-agnostic: Anthropic, OpenAI, Ollama, custom proxies.
- A manual `/model` switch automatically pauses the router for the rest of the session to avoid fighting the user's explicit choice.

### Conventions (CLAUDE.md / AGENTS.md)

- Global roots: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/AGENTS.md`, `~/.pi/AGENTS.md`. Project-level `./CLAUDE.md` / `./AGENTS.md` override the globals.
- Upward walk from `cwd` to `$HOME` merges every file found. Files nearest to `cwd` have the highest priority.
- `/cc-bridge status` prints the loaded CLAUDE.md / AGENTS.md files with their sizes (alongside active skills / commands / hooks).
- `maxTotalChars` in settings (default 20000) caps the injection so it doesn't blow up the system prompt.

### Session navigation

- Use pi's built-in `/resume`, `/fork`, `/tree` — they're already implemented in pi-core.

### ask_user tool (via `pi-ask-user`)

- Use `ask_user({question, options?, ...})` **only** when requirements are genuinely ambiguous and no reasonable assumption is available.
- Prefer `options` (2–4 searchable choices) over free-form questions. Set `allowMultiple: true` for multi-select, `allowFreeform: true` to let the user type a custom answer, `allowComment: true` to collect extra context.
- Pass `context` for background so the UI can render a split-pane preview.
- In non-interactive mode (`pi -p`) the tool errors. Fall back to best judgement.
- Do **not** use it to confirm a plan that's already been agreed.

### Permissions (interactive)

- With `permissions.interactive: true`, `confirm` actions show a 4-way picker: allow once / allow session / allow always / deny.
- `Allow always` persists the rule into `~/.pi/agent/settings.local.json` — the same pattern will pass automatically next time.
- Session-scoped allow disappears on pi restart.
- `edit` and `write` previews show a real line diff with ±2 lines of context, plus approximate line numbers for `edit` hunks.

### Extension discovery

- `/pi-search [query]` searches community extensions on GitHub (`topic:pi-package`) and the npm registry (`keywords:pi-package`, same source pi.dev/packages uses). Results are merged by repo slug; install prefers `pi install npm:<pkg>` when available, falling back to `pi install git:github.com/<owner>/<repo>`. Picker → install + `/reload`.
- `GITHUB_TOKEN` is optional; unauthenticated requests are capped at 60/hour.
- The installer warns when a candidate has fewer than 3 stars or was last updated more than 2 years ago.

### Extension toggles (opus-pack)

- `/opus-pack` (no args) or `Ctrl+Alt+O` opens a modal picker to enable or disable any pack extension.
- Non-interactive subcommands: `/opus-pack status | list [category] | on <name> | off <name> [--force] | reset | help`.
- State lives in `~/.pi/agent/settings.local.json` under `opus-pack.extensions.disabled`.
- Disabling `safe-deny` requires `--force` on the CLI or explicit confirmation in the modal (security-critical).
- `Save & Reload` applies without restarting pi. `Save` alone applies on the next manual `/reload`.
- Footer slot `off:N` appears when anything is disabled.
- `/extensions` prints a read-only health dashboard of every pack extension.

### Self-recheck (weak-model second pass)

- When `selfRecheck.enabled` and the active model id matches a glob in `selfRecheck.models` (e.g. `glm-*`), a single user-message follow-up is auto-injected via `pi.sendUserMessage` after `agent_end`. The model's reply becomes a real assistant turn and lands in session history, so subsequent turns see the revised answer instead of the original draft.
- The default prompt asks the model to (1) re-read the original prompt and identify constraints, (2) walk its previous answer item by item with KEEP / DROP / FIX, (3) add anything required-but-missing, (4) output the clean revised answer with no preamble or meta-commentary. Override via `selfRecheck.prompt`.
- Recursion-safe: the recheck turn itself never triggers another recheck.
- In plan mode, the "what next?" dialog is deferred until recheck completes — weak-model plans get reviewed before the user decides Execute/Refine/Stay.
- `/recheck status | on | off | now | skip` — `now` forces one pass on the next turn regardless of model match or cap; `skip` suppresses the next auto-fire; `status` prints the current decision and counters.

### Notifications

- Desktop notifications fire automatically when a task finishes and ran longer than the configured threshold (default 10s). Don't ask the user to check — they'll see it.

### Thinking-effort presets

Level names come from `opus-pack.modelRouter.levels` (user-configured). Default is `medium`. A typical setup:

- `low` — typos, formatting.
- `medium` — single-file feature, debugging a known surface.
- `high` — cross-file refactor, design questions, non-obvious bug.
- `xhigh` — architecture work, ambiguous specs, root-cause hunts.

Your own `levels` dict may differ — `/router status` prints the active set.

### Subagents (via `pi-subagents`)

Subagent orchestration is delegated to the installed [`pi-subagents`](https://github.com/nicobailon/pi-subagents) extension — this pack no longer ships its own. The top-level `agents/` directory contributes two chain-compatible profiles (`explore` and `verify`) alongside the roster bundled with `pi-subagents` (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`). `explore` is the slow/thorough counterpart to `scout`; `verify` runs tests/lint/build and has no equivalent in the bundled roster.

Quick commands (from `pi-subagents`):

- `/run <agent> <task>` — single-agent one-shot
- `/chain a1 "t1" -> a2 "t2"` — sequential pipeline with `{previous}` flow
- `/parallel a1 "t1" -> a2 "t2"` — concurrent execution
- `/agents` (`Ctrl+Shift+A`) — TUI to browse/edit/create agents
- `/subagents-status` — monitor async/background runs

Invocation modes on the `subagent` tool:

- `single`, `parallel`, `chain`, `fork` (isolated branched session per child), `async`/background
- Worktree isolation via `context: "fork"` for filesystem-protected parallel runs
- Fallback models when the primary is unavailable
- Reusable `*.chain.md` files for repeated pipelines
- Skill injection from `SKILL.md`

Use a subagent when isolated context genuinely helps (multi-file search, verification worth separating from the main flow). For small lookups, inline work is cheaper.

### Code-quality pipeline (`pi-lens`)

Every `write` / `edit` is intercepted by [`pi-lens`](https://github.com/apmantza/pi-lens) and run through LSP, linters, formatters, tree-sitter structural rules, and a secrets scanner before the file is committed to disk. If the pre-write check blocks a write (e.g. credential pattern detected), treat it as a hard stop — don't paper over it with `--force`; fix the content.

Slashes:

- `/lens-booboo` — full quality report for current project state
- `/lens-health` — runtime metrics, latency, telemetry

### Token-optimised reads and shell (`lean-ctx`)

[`lean-ctx`](https://github.com/yvgude/lean-ctx) wraps CLI output and file reads with aggressive compression. When lean-ctx is installed, prefer its MCP tools over native equivalents for reads and shell commands: cached reads re-cost ~13 tokens, adaptive compression, cross-session memory, tree-sitter parsing across 18 languages. Setup runs once at install time (`lean-ctx setup`). Verify with `lean-ctx doctor`.

<!-- ## Opus Pack rules END -->
