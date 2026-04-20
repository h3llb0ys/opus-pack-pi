# opus-pack-pi

Opinionated, provider-neutral extension bundle for [pi-coding-agent](https://github.com/badlogic/pi-mono) that brings Claude-Code-parity features (plan mode, todo, permissions, skills, CC-style hooks, and more). The name is historical — the pack started as a Claude-Opus-4.7 setup, but it now works with any provider that pi supports (Anthropic, OpenAI, Ollama, local llama-cpp, custom proxies). Router model choices live behind aliases in `settings.json`, so swapping providers is a one-line change. Subagent orchestration is delegated to [`pi-subagents`](https://github.com/nicobailon/pi-subagents); static code-quality pipeline to [`pi-lens`](https://github.com/apmantza/pi-lens); token-optimised shell/file reads to [`lean-ctx`](https://github.com/yvgude/lean-ctx).

The installer also pulls selected community packages through native `pi install` and fills in gaps they don't cover.

[Русская версия (Russian README)](./README.ru.md)

## Features

### Own extensions (`extensions/`)

| Extension | Description |
| --- | --- |
| `plan-mode.ts` | `/plan` + `Ctrl+Alt+P`: read-only exploration and numbered plan. The model calls `exit_plan_mode(plan, save?)` → confirm dialog → execute with `[DONE:N]` tracking. `/plan-resume` reloads a saved plan across sessions; `/plan-close` is the manual escape hatch. `--plan` flag starts in plan mode. |
| `permissions.ts` | Granular allow / confirm / deny per tool, path, and bash pattern. 4-way interactive prompt (once / session / always / deny) with real line-diff previews for `write` and approximate line numbers for `edit`. Configured under `opus-pack.permissions`. |
| `todo.ts` | `todo` tool (add/start/done/clear) + `/todo` command. Task list with `in_progress` state and single-active invariant (mirrors CC `TodoWrite`). Widget + status-bar badge. |
| `log-tail.ts` | `log_tail` / `log_kill` / `log_ps` tools + `/bg` picker — pi-native long-running tasks. The model detaches bash to `/tmp/pi-bg-<slug>.{log,pid}`; the extension reads and kills. `watch: true` pushes new lines back on every turn. Status bar: `bg:N`. |
| `diff.ts` | `/diff` — view the agent's changes: `git diff HEAD --stat` + interactive file picker with full diff. |
| `rewind.ts` | `/rewind` — undo/rollback: discard changes, undo last commit, reset to an arbitrary commit, or stash. |
| `cost.ts` | `/cost` — token-usage dashboard: current session, today, past 7 days with per-day breakdown. Shows `—` when pricing is unknown (non-Anthropic providers). |
| `context.ts` | `/context` — what's consuming context: breakdown by type (system/user/tool), top tools, top files. |
| `session-summary.ts` | Auto-summary on agent exit (≥3 tool calls): files edited, commands run, errors encountered. |
| `smart-compact.ts` | Merges `.pi/compact-hints.md` / `opus-pack.compactHints` with inline focus from the built-in `/compact [focus]`. Preserves key context across compaction. |
| `skills.ts` | Registers `~/.{claude,codex,gemini,pi}/skills` as skill roots so cross-vendor CC-style skills are visible to pi's `<available_skills>` catalogue. |
| `desktop-notify.ts` | OS notification (macOS/Linux) when an agent finishes. Configurable duration threshold + sound. `/notify-test`. |
| `iteration-guard.ts` | Cap on turns per agent run (default 40, configurable via `opus-pack.iterationGuard`). `/continue` extends by `extendBy`. Supports `--max-turns=<N>` flag and `PI_MAX_TURNS` env var. |
| `safe-deny.ts` | Non-interactively blocks destructive operations: `rm -rf /`, `git push --force` on main, `--no-verify` commits, writes to `~/.{claude,codex,gemini,openai,anthropic}`, `.env`, `*.pem`, `~/.ssh`. Bypass: `PI_OPUS_PACK_UNSAFE=1`. |
| `status.ts` | `/status` — summary (extensions, skills, prompts, MCP tools, model, ctx usage). Live status line: `cwd · branch · model · ctx:X%`. Footer: `ext:N skills:M mcp:K`. Optional `opus-pack.statusLine.command` runs a user shell command whose stdout lands in the status bar. |
| `list-resources.ts` | `/skills`, `/extensions`, `/prompts` — runtime listing. `/extensions` doubles as a health dashboard showing enabled/disabled state for every pack extension. |
| `hook-bridge.ts` | Reads the `hooks` block from `settings.json` in Claude Code format and runs shell commands on pi events (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PreCompact`). Lets you copy-paste CC configs and third-party hook scripts. |
| `claude-md-loader.ts` | Auto-loads `~/.{claude,codex,gemini,pi}/...` + upward-walk `CLAUDE.md` / `AGENTS.md` into the system prompt. `/claude-md` prints what got loaded. Mtime-cached. |
| `model-router.ts` | Heuristic auto-switch of model and thinking level per prompt. `/router <level>`, `/router status`, `/router off`. Provider-agnostic. Recognises Anthropic and OpenAI rate-limit headers for graceful downgrade. Status slot `↗ model·level`. |
| `file-commands.ts` | Loads `*.md` slash commands with YAML frontmatter from `~/.{claude,pi}/commands` and `<cwd>/.{claude,pi}/commands`. Subdirectories become `plugin:name` namespaces. `$ARGS` / `$1..$9` substitution. Drops in CC-format commands unmodified. |
| `deferred-tools.ts` | Feature-flagged (`opus-pack.deferredTools.enabled`). Prunes the active tool list on every turn, hiding MCP tools behind `tool_search` and `tool_load` proxies. Saves prompt tokens when the MCP park is large. |
| `bash-progress.ts` | Live widget with tail + elapsed counter for long bash commands (>2s). Doesn't modify the tool itself. |
| `pi-search.ts` | `/pi-search [query]` — GitHub topic `pi-package` discovery + interactive install + `/reload`. 1-hour cache. |
| `mcp-compress.ts` | Collapses verbose MCP tool results into single-line summaries (`ok memory_save: saved, id=208, deduped`). Recognises `saved`/`id`/`deduplicated`/`episode_id`/`count`/`error`. Configurable under `opus-pack.mcpCompress`. |
| `opus-pack-config.ts` | `/opus-pack` + `Ctrl+Alt+O` — picker to enable/disable any extension in the pack. Also supports subcommands for scripting / non-interactive use: `status`, `list [cat]`, `on <name>`, `off <name> [--force]`, `reset`, `help`. Persists to `settings.local.json` under `opus-pack.extensions.disabled`. Footer slot `off:N` when anything is disabled. |
| `edit-log.ts` | `/edit-log` — on-demand history of edit/write operations for the current session (file → tool + time + first-new-line snippet). Nothing is injected into the system prompt; output is on demand. |

### Vendored extensions (from `pi-mono/examples/extensions/`)

- `git-checkpoint.ts` — auto-snapshot before write/edit/bash.
- `auto-commit-on-exit.ts` — snapshot on pi exit.
- `dirty-repo-guard.ts` — warns when starting on a dirty working tree.

### Bundled agent profiles

The `agents/` directory ships two chain-compatible profiles — `explore` (slow, thorough read-only counterpart to `scout`) and `verify` (runs tests/lint/build; no equivalent in the bundled roster) — that the installed `pi-subagents` extension picks up alongside its own defaults (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`).

Tier is controlled by the `alias:fast|balanced|slow` hint in each profile's frontmatter; the alias is resolved by `pi-subagents` against its own model map. Swap providers once, every profile follows.

### Community packages installed by the installer

- [`obra/superpowers`](https://github.com/obra/superpowers) — 14 skills (systematic-debugging, brainstorming, writing-plans, TDD, code-review, git-worktrees, …). Only `skills/` is loaded — CC-only `commands/`/`agents/`/`hooks/` are filtered out.
- [`rynfar/meridian`](https://github.com/rynfar/meridian) — Claude-Max-subscription proxy. Anthropic-only, opt-in via `ANTHROPIC=1 ./install.sh`.
- [`viartemev/pi-rtk-rewrite`](https://github.com/viartemev/pi-rtk-rewrite) — auto-rewrites bash commands through `rtk` (60-90% token savings on common commands).
- [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) — MCP bridge (CC format, ~200-token proxy tool, lazy lifecycle, `idleTimeout`).
- [`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions) — `/usage` dashboard, `/readfiles` file browser, tab-status, ralph-wiggum (long tasks), agent-guidance (Claude/Codex/Gemini switching).
- [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) — compact tool-call rendering.
- [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) — web search + extraction.
- [`viartemev/pi-working-message`](https://github.com/viartemev/pi-working-message) — cosmetic custom "working" phrases.

## Requirements

- [pi](https://pi.dev) (`brew install pi` or see pi.dev)
- `jq` (`brew install jq` / `apt install jq`)
- Node.js ≥18 (for `crypto.randomBytes`, native ESM, `fileURLToPath`).

## Installation

### Local clone (dev)

```sh
git clone https://github.com/h3llb0ys/opus-pack-pi
cd opus-pack-pi
./install.sh
```

Installing meridian (Anthropic-only) is opt-in:

```sh
ANTHROPIC=1 ./install.sh
```

### From GitHub (any machine)

```sh
# Replace <tag> — see https://github.com/h3llb0ys/opus-pack-pi/tags
pi install git:github.com/h3llb0ys/opus-pack-pi@<tag>
# Then install community packages and merge configs:
bash "$(pi list | grep opus-pack-pi | awk '{print $NF}')/install.sh"
```

`install.sh` is idempotent — re-running is safe and prints `[skip]` for anything already in place. The `opus-pack` block in `settings.json` is deep-merged through `jq`, so your customisations survive updates.

## Provider setup (after install)

The pack is provider-neutral. Minimal working setup for any provider:

1. Make sure `pi` knows your provider (API key in an env var or in `~/.pi/agent/auth.json`).
2. Configure subagent model aliases in the `pi-subagents` settings block (see that package's README for the exact shape). Every bundled profile (`scout`, `planner`, `worker`, `reviewer`, plus this pack's `explore` and `verify`) picks its model from that map.

3. (Optional) Fill `opus-pack.modelRouter.levels` to auto-switch models mid-session based on prompt content. See `_levels_example_*` blocks in `settings.json.example` for provider-specific stubs.

Ready-to-copy multi-provider examples for the router block live in `settings.json.example`.

## What `install.sh` touches

- `~/.pi/agent/settings.json` — **jq deep-merge**, never overwrites unrelated keys. Updates only `hooks`, `opus-pack`, and `packages`.
- `~/.pi/agent/mcp.json` — merges the (empty by default) `mcpServers` block from `mcp.json.example`. Add your own MCP servers there.
- `~/.pi/agent/APPEND_SYSTEM.md` — **append-only** with `<!-- Opus Pack rules START/END -->` markers. Re-runs don't duplicate.
- `pi install <pkg>` for each missing community package.
- `pi install <REPO_DIR>` registers the local repo path.

Nothing else. No changes to `~/.claude/`, no global shell config edits.

## Configuration

Blocks in `settings.json` after install:

```json
{
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
    "SessionStart": [],
    "Stop": []
  },
  "opus-pack": {
    "iterationGuard": { "defaultCap": 40, "extendBy": 20 },
    "safe-deny": { "enabled": true }
  }
}
```

For custom hooks, just append entries to the `PreToolUse` / `Stop` / … arrays in Claude Code format. `hook-bridge.ts` picks them up via `/reload` without a restart.

MCP servers live separately in `~/.pi/agent/mcp.json` (format: `mcp.json.example`). The pack ships no MCP defaults — add your own.

To **disable** a pack extension, filter in `settings.json`:

```json
{
  "packages": [{
    "source": "/path/to/opus-pack-pi",
    "extensions": ["extensions/*.ts", "!extensions/git-checkpoint.ts"]
  }]
}
```

Or use the `/opus-pack` modal, which persists the list into `settings.local.json`.

## Troubleshooting

- **`/status` fails** — pi's introspection API is private in some builds. `status.ts` is wrapped in try/catch and shows what it can.
- **A hook doesn't fire** — verify the `matcher` matches the tool name (e.g. `bash`, not `Bash`). Hook stdout must be valid JSON; `{"block": true, "reason": "..."}` blocks the call.
- **`pi list` is empty after install** — pi may require a restart after the first `pi install`. Start pi once, confirm extensions load, then re-run `install.sh` to merge settings.
- **`safe-deny` blocks a command you need** — `PI_OPUS_PACK_UNSAFE=1 pi ...` for a one-shot bypass, or edit `extensions/safe-deny.ts` and `/reload`.

## Update

```sh
./update.sh   # pi update + git pull + re-merge settings
```

## Uninstall

```sh
./uninstall.sh
```

Removes pack-installed community packages, cleans our blocks out of `settings.json`, and strips the `Opus Pack rules` section from `APPEND_SYSTEM.md`. Creates a `.bak` backup. Never touches unrelated settings.

## Dev loop

Edit `extensions/*.ts` directly in the repo. Inside pi run `/reload` — changes take effect without a restart. pi references the repo by path; it doesn't copy files.

Release flow:

```sh
git tag vX.Y && git push origin main --tags
```

On other machines: `pi install git:github.com/h3llb0ys/opus-pack-pi@vX.Y`.

## License

MIT. See [LICENSE](./LICENSE).
