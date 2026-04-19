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
- Use `[DONE:N]` markers to track progress during execution.
- Never modify code in plan mode — analysis and planning only.
- `/plan-resume` reloads a saved plan across sessions; `/plan-close` is the manual escape hatch when a plan stalls.

### Tasks (todo discipline)

- For multi-step work (3+ steps), create `todo` entries first, then `todo start <id>` → work → `todo done <id>`.
- **Exactly one `in_progress` task at a time.** Starting a new one returns the previous active task to `pending`.
- Don't use `todo` for trivial single-file, single-edit work.

### Long-running tasks

- **One-shot (build / test / migration):** call the `subagent` tool with `agent: "scout"` (or a project-defined agent). `scout.md` uses `model: alias:fast` (see `opus-pack.subagent.modelAlias`) and returns a structured result.
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
- Emit `[DONE:N]` markers as steps complete; the extension writes them back into the plan file for cross-session resume via `/plan-resume`.

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
- `/claude-md` prints what got loaded.
- `maxTotalChars` in settings (default 20000) caps the injection so it doesn't blow up the system prompt.

### Session navigation

- Use pi's built-in `/resume`, `/fork`, `/tree` — they're already implemented in pi-core.

### ask_user tool

- Use `ask_user({question, choices?})` **only** when requirements are genuinely ambiguous and no reasonable assumption is available.
- Prefer `choices` (2–4 options) over free-form questions.
- In non-interactive mode (`pi -p`) the tool errors. Fall back to best judgement.
- Do **not** use it to confirm a plan that's already been agreed.

### Permissions (interactive)

- With `permissions.interactive: true`, `confirm` actions show a 4-way picker: allow once / allow session / allow always / deny.
- `Allow always` persists the rule into `~/.pi/agent/settings.local.json` — the same pattern will pass automatically next time.
- Session-scoped allow disappears on pi restart.
- `edit` and `write` previews show a real line diff with ±2 lines of context, plus approximate line numbers for `edit` hunks.

### Extension discovery

- `/pi-search [query]` searches community extensions on GitHub (topic `pi-package`, sorted by stars). Picker → install + `/reload`.
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

### Notifications

- Desktop notifications fire automatically when a task finishes and ran longer than the configured threshold (default 10s). Don't ask the user to check — they'll see it.

### Thinking-effort presets

Level names come from `opus-pack.modelRouter.levels` (user-configured). Default is `medium`. A typical setup:

- `low` — typos, formatting.
- `medium` — single-file feature, debugging a known surface.
- `high` — cross-file refactor, design questions, non-obvious bug.
- `xhigh` — architecture work, ambiguous specs, root-cause hunts.

Your own `levels` dict may differ — `/router status` prints the active set.

### Subagents (via the `subagent` tool)

Bundled agents live in `extensions/subagent/agents/`:

- `scout` — fast codebase recon with bash. Structured findings for handoff to another agent. Uses `model: alias:fast`.
- `planner` — produces an implementation plan from scout findings + requirements. Read-only.
- `reviewer` — quality / security / maintainability review. Read-only + git diff/log/show via bash.
- `worker` — general-purpose writer. Balanced tier, full toolset; usually consumes a planner's output.

Project-local agents: drop `*.md` into `.pi/agents/`; enable by passing `agentScope: "both"` (or `"project"`). The first call in a session prompts for confirmation before running project agents.

Invocation modes on the `subagent` tool:

- `single` — `{ agent, task }`
- `parallel` — `{ tasks: [{ agent, task }, ...] }` (concurrency 4, max 8)
- `chain` — `{ chain: [{ agent, task }, ...] }` with `{previous}` placeholder
- `continue_from: <runId>` — replay a prior run's context into a fresh one-shot (single/chain only)

Runs are persisted to `.pi/agents/<runId>.jsonl` for inspection and `continue_from`.

Use a subagent when isolated context genuinely helps (multi-file search, verification worth separating from the main flow). For small lookups, inline work is cheaper.

<!-- ## Opus Pack rules END -->
