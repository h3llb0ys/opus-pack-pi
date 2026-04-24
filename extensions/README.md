# opus-pack extensions

Reference for the extensions shipped in this directory. Community packages installed alongside live in the [top-level README](../README.md#community-packages-installed-by-installsh).

Each extension is a single `.ts` file at the root of this directory (except `cc-bridge/`, which is a subdirectory because it hosts four related sub-modules). pi discovers them through its plugin loader — no registration file is needed. Enable or disable from inside pi with `/opus-pack` (modal) or the `/opus-pack off <name>` subcommand; state persists to `~/.pi/agent/settings.local.json` under `opus-pack.extensions.disabled`.

---

## Safety

### `permissions.ts`

Granular allow / confirm / deny gate per tool, path, and bash pattern.

- **Config:** `opus-pack.permissions` in `settings.json`.
- **Interactive prompt:** 4-way pick (`once` / `session` / `always` / `deny`) with a real line-diff preview for `write` and approximate line numbers for `edit`.
- **Persistence:** `always` rules append to `~/.pi/agent/settings.local.json`.

### `safe-deny.ts`

Non-interactive guardrail that blocks destructive bash commands and credential access before anything reaches disk.

- **Bash rules** (argv-aware tokeniser; unwraps `sudo …`): `rm -rf /|~`, `git push --force` to main/master, `git commit --no-verify`, `chmod -R 777`, `chown -R`, `dd if=/of=`, `mkfs.*`, fork bombs, `curl|sh`.
- **Path rules — write blocked:** `.env`, `*.pem`, `*.key`, SSH private keys (`id_rsa`, `id_ed25519`, …), `.netrc`, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.openai`, `~/.anthropic`, `~/.{claude,codex,gemini}`.
- **Path rules — read also blocked** on the credential subset above (prevents exfiltration into prompt context).
- **Bypass:** `PI_OPUS_PACK_UNSAFE=1`.

### `dirty-repo-guard.ts`

Warns when a session starts on a dirty working tree so you notice uncommitted changes before the agent edits on top of them.

### `iteration-guard.ts`

Caps agent turns per run.

- **Default:** 40 (`opus-pack.iterationGuard.defaultCap`).
- **Extend:** `/continue` adds `extendBy` (default 20).
- **Override:** `--max-turns=<N>` flag or `PI_MAX_TURNS` env var.

---

## Tasks & routing

### `plan-mode.ts`

Read-only exploration mode. Produce a numbered plan, call `exit_plan_mode(plan, save?)` to exit. On approval the steps are installed into the `todo` list and execution progress is driven by the normal `todo start/done` tool — plan-mode mirrors done-state into the saved plan file.

- **Slashes:** `/plan`, `/plan-resume`, `/plan-close`.
- **Shortcut:** `Ctrl+Alt+P` (also `Alt+Tab`, `Super+P`).
- **Flag:** `--plan` starts pi directly in plan mode.
- **Persistence:** plans saved under `.pi/plans/<ts>-<slug>.md` when `save=true` or `opus-pack.planMode.autoSave=true`.
- **MCP approval gate.** While plan mode is active, every MCP tool invocation prompts the user with `Allow (session) / Allow once / Deny (session) / Deny once`. Decisions cached in-memory for the plan-session lifetime only; never persisted, cleared on every exit (`/plan` toggle, `exit_plan_mode`, `finalizePlan`, `/plan-resume`). Detection covers (a) `pi-mcp-adapter` direct tools via `sourceInfo`, regardless of its `toolPrefix` setting (`server` / `short` / `none`), (b) the unified proxy tool literally named `mcp`, and (c) any tool whose name matches `opus-pack.planMode.mcpPattern`. Base tools (`read`, `bash`, `grep`, `find`, `ls`) are always excluded so a misnamed MCP tool cannot shadow them. Approval-dialog previews redact values of sensitive-looking keys (`token`, `api_key`, `password`, `secret`, `auth`, `cookie`, `session`).
- **Config:** `opus-pack.planMode.{autoSave,dir,mcpPattern,gateGranularity,nonInteractivePolicy}`.
  - `gateGranularity`: `"tool"` (default — each tool prompts separately) or `"server"` (one approval covers every tool under the same `mcp__<server>__*` prefix; auto-degrades to per-tool with a warning when detected names don't fit that shape).
  - `nonInteractivePolicy`: `"allow"` or `"deny"` (default) — governs MCP calls when `ctx.hasUI` is false (print / RPC / headless).

### `todo.ts`

Task list with `pending` / `in_progress` / `dispatched` / `done` states. Single-active invariant on `in_progress` (like Claude Code's `TodoWrite`); `dispatched` is the parallel lane for work delegated to subagents.

- **Tool:** `todo(action: add|start|done|dispatch|list|clear, text?, texts?, id?, ids?)`.
  - `add` accepts a single `text` or a batch via `texts: string[]`.
  - `done` accepts a single `id` or a batch via `ids: string[]` (drops a closing wave of completed steps in one call).
  - `dispatch ids:[...]` flips items into `dispatched`, signalling that work has been delegated to subagents (via the `pi-subagents` `subagent` tool). Multiple items may be `dispatched` simultaneously without violating the single-active invariant on `in_progress`.
  - `start` keeps the single-active invariant and rejects batches. Calling `start` on a `dispatched` item flips it into `in_progress` — the recovery path when a subagent fails or times out and the main agent takes the work over locally.
- **Slash:** `/todo`.
- **UI:** widget above the prompt + footer badge. Glyphs: `□` pending, `▶` in_progress, `⇄` dispatched, `■` done. Footer badge prefixes `▶`, `⇄N`, or `▶+⇄N` depending on what's active.
- **Nag:** a single steering nag fires when the model racks up modifying operations without any active task (in_progress or dispatched). A separate orphan-dispatched nag fires if the same set of `dispatched` ids stays unchanged for several turns — reminding the model to either close them with `done` or take them over with `start`.

### `model-router.ts`

Picks model and thinking level per prompt based on configured rules.

- **Slash:** `/router <level>`, `/router status`, `/router on`, `/router off`, `/router pause`.
- **Status slot:** `↗ model·level` (or `↘ rate-limit Ns` during graceful downgrade).
- **Config:** `opus-pack.modelRouter` (`default`, `levels`, `rules`, `autoBumpAfterTurns`, `rateLimitDowngrade`).
- **Provider-neutral:** Anthropic / OpenAI / Ollama / custom. Recognises 429 headers for downgrade.
- **Manual override:** a `/model` switch pauses the router for the rest of the session to avoid fighting the user's explicit choice.

---

## UI & reporting

### `status.ts`

Session snapshot + live status line + footer counters.

- **Slash:** `/status` (dumps extensions, skills, prompts, MCP tools, model, context usage).
- **Status line:** `cwd · branch · model · ctx:X%`.
- **Footer slots:** `ext:N skills:M mcp:K` (persistent), and a user-provided shell command under `opus-pack.statusLine.command` whose stdout appears in the bar.

### `bash-progress.ts`

Live widget with tail + elapsed counter for long-running bash commands (threshold: `opus-pack.bashProgress.minDurationMs`, default 2000). Does not modify the bash tool itself.

### `mcp-compress.ts`

Collapses verbose MCP tool results into single-line summaries: `ok memory_save: saved, id=208, deduped`.

- **Recognised keys:** `saved`, `id`, `deduplicated`, `episode_id`, `count`, `error`.
- **Config:** `opus-pack.mcpCompress.{prefixes,maxLineLen,whitelist}`.

### `desktop-notify.ts`

OS notification (macOS / Linux) when an agent run completes. Suppressed for runs shorter than the threshold.

- **Config:** `opus-pack.notify.{enabled,minDuration,sound}` (default 10s, sound on).
- **Slash:** `/notify-test`.

### `session-summary.ts`

Auto-summary on agent exit when the run did ≥ 3 tool calls: files edited, commands run, errors encountered.

### `list-resources.ts`

Runtime resource listings.

- **Slashes:** `/extensions`, `/prompts`.
- **`/extensions`** doubles as a health dashboard — shows every pack extension with enabled / disabled state.
- **`/skills`** is provided by the installed `pi-skills-menu` package, not here.

---

## Integrations

### `cc-bridge/` — cross-vendor compat layer

A single extension with four independently-toggleable sub-modules and one `/cc-bridge` slash.

- **`cc-bridge.skills`** — registers `<vendor>/skills` directories as skill roots at both user (`~/`) and project (`<cwd>/`) scope, across `.claude`, `.codex`, `.gemini`, `.pi`.
- **`cc-bridge.commands`** — loads `*.md` slash commands with YAML frontmatter from `<vendor>/commands` (same scopes). Subdirectories become `plugin:name` namespaces. `$ARGS` and `$1..$9` substitution. `!command` prefixes are treated as plain text, not executed.
- **`cc-bridge.claude-md`** — auto-loads `CLAUDE.md` / `AGENTS.md` from per-vendor globals plus an upward walk of the cwd into the system prompt. Mtime-cached.
  - Config: `opus-pack.claudeMdLoader.{enabled,includeGlobal,includeWalk,maxTotalChars}` (default `maxTotalChars: 20000`).
- **`cc-bridge.hooks`** — Claude-Code-format hooks from two sources, merged per event in this order: settings.json block → user-scope files → project-scope files.
  - Source A: `hooks` block in `~/.pi/agent/settings.json` / `<cwd>/.pi/settings.json` (CC schema).
  - Source B: `<vendor>/hooks/*.md` or `*.sh` files at user + project scope. Frontmatter: `event` (required), `matcher` (optional regex), `timeout` (seconds, default 5). Body is the shell script; for `*.sh` files the file runs directly (chmod +x applied if missing).
  - Events: `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PreCompact`.
- **`/cc-bridge`** slash: `status` (default, consolidated dump of skills / commands / claude-md / hooks), `reload` (rescan command files), `help`.

### `smart-compact.ts`

Merges compaction hints with the built-in `/compact [focus]` so the compactor doesn't drop active-work context.

- **Hint sources (merged):** `.pi/compact-hints.md`, `~/.pi/agent/compact-hints.md`, `opus-pack.compactHints` (string or array).
- **Session advisor:** maintains a running log of touched files + failed bash commands per session and injects a summary into the compaction prompt.

### `log-tail.ts`

Pi-native long-running background tasks.

- **Tools:** `log_tail(path, from?, lines?, watch?)`, `log_kill(pid?|pattern?)`, `log_ps()`.
- **Slash:** `/bg` — picker over live tasks (tail, kill, clean stale pidfiles).
- **Convention:** the agent detaches bash to `/tmp/pi-bg-<slug>.log` and writes `$!` to `/tmp/pi-bg-<slug>.pid`.
- **Watch mode:** `log_tail({watch: true})` pushes new lines back on every turn.
- **Footer slot:** `bg:N` shows live task count.

### `pi-search.ts`

Discovery of community pi extensions.

- **Slash:** `/pi-search [query]` — queries GitHub (`topic:pi-package`) and the npm registry (`keywords:pi-package`, same backend as pi.dev/packages) in parallel, merges by repository slug, interactive installer picker, triggers `/reload` on install.
- **Install routing:** npm-available packages install via `pi install npm:<name>` (matches pi.dev flow); GitHub-only fallbacks use `pi install git:github.com/<owner>/<repo>`.
- **Badges:** `[npm+gh]` / `[npm]` / `[gh]` on each row.
- **Cache:** 1 hour per (query, keyword) pair.
- **`GITHUB_TOKEN`:** optional; unauthenticated requests are capped at 60/hour.
- **Warnings:** `< 3 stars` (GitHub side) or `> 2 years` since last update.
- **Config:** `opus-pack.piSearch.sources` (default `["github", "npm"]`), `opus-pack.piSearch.keyword` (default `"pi-package"` — applied to both GitHub `topic:` and npm `keywords:`), `opus-pack.piSearch.fetchTimeoutMs` (default `10000`).

### `deferred-tools.ts`

Prunes the active tool list on every turn, hiding MCP tools behind `tool_search` and `tool_load` proxies. Saves prompt tokens when the MCP park is large.

- **Feature flag:** `opus-pack.deferredTools.enabled`.
- **Slash:** `/deferred-tools` (inspect current active set).

---

## Dev loop

### `diff.ts`

Review agent changes interactively.

- **Slash:** `/diff` — shows `git diff HEAD --stat` plus a file picker with the full per-file diff.

### `self-recheck.ts`

Automatic second pass for weak models. After `agent_end`, when the active model id matches one of `selfRecheck.models` (glob, default `glm-*`, `*qwen*`, `deepseek*`) and the assistant text is at least `minAssistantChars` long, the extension injects a single user-message follow-up via `pi.sendUserMessage(prompt, { deliverAs: "followUp" })`. The model's reply becomes a real assistant turn and lands in session history, so the LLM is aware of the revised answer on subsequent turns.

The default prompt asks the model to (1) re-read the original prompt and identify every constraint / filter / requirement / emphasized phrase, (2) walk its previous answer item by item with KEEP / DROP / FIX, (3) add anything required-but-missing, (4) output the clean revised answer top to bottom — no preamble, no defect list, no meta-commentary. Override via `selfRecheck.prompt`.

A `opus-pack:recheck:completed` event fires on the `agent_end` of the recheck turn so coordinating extensions (plan-mode) can re-drive their flow post-recheck. Recursion-safe: an `inRecheckTurn` flag is cleared on the next `agent_end`, so the recheck turn itself never triggers another.

**Plan-mode coordination:** while a recheck is in flight or about to fire, plan-mode defers its "Execute / Refine / Stay" dialog. The dialog is re-driven via the `opus-pack:recheck:completed` event, so the user decides on the post-recheck plan.

- **Slash:** `/recheck status|on|off|now|skip`. `now` bypasses model match and cap; `skip` suppresses the next auto-fire one-shot; `status` prints in-flight flag, cap usage, and last decision.

---

## Meta

### `opus-pack-config.ts`

Toggle any extension in the pack at runtime.

- **Slash:** `/opus-pack` (no args → modal). Subcommands: `status`, `list [cat]`, `on <name>`, `off <name> [--force]`, `reset`, `help`.
- **Shortcut:** `Ctrl+Alt+O` opens the modal.
- **Persistence:** `~/.pi/agent/settings.local.json` under `opus-pack.extensions.disabled` (sorted).
- **Footer slot:** `off:N` appears when anything is disabled.
- **Critical extensions** (e.g. `safe-deny`): disabling requires `--force` on the CLI or explicit confirmation in the modal.
- **Drift warning.** A `⚠ N unregistered: …` row in the modal and `; ⚠ unregistered: …` suffix on `/opus-pack status` flag `extensions/*.ts` files that exist on disk but aren't listed in `OPUS_EXTENSIONS`. Keeps new extensions from silently shipping uncategorized.

---

## How to disable an extension

Two options:

1. Interactive: `/opus-pack` or `/opus-pack off <name>`. Persists to `settings.local.json`.
2. Static: filter at package level in `~/.pi/agent/settings.json`:

   ```json
   {
     "packages": [{
       "source": "/path/to/opus-pack-pi",
       "extensions": ["extensions/*.ts", "!extensions/diff.ts"]
     }]
   }
   ```

Option 1 is preferred — it survives `opus-pack-pi` updates and you see everything disabled in one place (`/opus-pack status`).

## How they're loaded

- pi walks `extensions/*.ts` and loads each file as an extension module.
- `cc-bridge/` is a subdirectory; pi loads its `index.ts` as a single extension which internally registers four sub-modules.
- The `lib/` subdirectory under `cc-bridge/` is not an extension — it's a shared helper module imported only by `cc-bridge/*.ts`.
- `opus-pack-pi`'s top-level `lib/` (`settings.ts`, `input-helpers.ts`) is likewise a shared helper imported by many extensions; pi does not try to load it.
