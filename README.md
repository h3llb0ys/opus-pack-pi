# opus-pack-pi

An opinionated, provider-neutral extension bundle for [pi-coding-agent](https://github.com/badlogic/pi-mono). Brings Claude-Code-parity features (plan mode, todo, permissions, CC-style hooks, skills discovery), integrates a curated set of community packages, and gets out of your way.

> Provider-neutral by design. Works with Anthropic, OpenAI, Ollama, local `llama.cpp`, or custom proxies. Swap providers by editing one alias map.

[Русская версия](./README.ru.md)

---

## What you get

- **24 first-party extensions** covering plan mode, tasks, permissions, routing, safety, git, CLAUDE.md discovery, Claude-Code-style hooks, and more.
- **17 community packages** auto-installed: subagent orchestration, real-time code-quality pipeline, hash-anchored edits, agentic context management, parallel side-conversations, secret scanning, and a drop of developer niceties.
- **`lean-ctx`** installed alongside as a single Rust binary — ~90% token savings on shell and file-read output.
- **Two chain-compatible agent profiles** (`explore`, `verify`) that plug into `pi-subagents` pipelines.
- **`/opus-pack`** modal (`Ctrl+Alt+O`) to toggle any pack extension on/off without restarting pi.
- **Safe-by-default `safe-deny`** that blocks destructive bash and credential leakage in read/write.

---

## Installation

### Local (dev)

```sh
git clone https://github.com/h3llb0ys/opus-pack-pi
cd opus-pack-pi
./install.sh
```

### From GitHub (any machine)

```sh
# Pick a tag: https://github.com/h3llb0ys/opus-pack-pi/tags
pi install git:github.com/h3llb0ys/opus-pack-pi@<tag>
bash "$(pi list | grep opus-pack-pi | awk '{print $NF}')/install.sh"
```

Opt-in for Anthropic users (adds the Claude Code bridge):

```sh
ANTHROPIC=1 ./install.sh
```

The installer is idempotent. Re-runs print `[skip]` for anything already present. User customisations in `settings.json` survive updates because the merge is a `jq` deep-merge.

### Requirements

- [pi](https://pi.dev)
- `jq` (`brew install jq` / `apt install jq`)
- Node.js ≥ 18

---

## Architecture

The pack has three layers:

| Layer | Source | Count |
|---|---|---|
| Own extensions | `extensions/*.ts` in this repo | 24 |
| Community extensions | installed via `pi install <pkg>` | 17 + 1 opt-in |
| Agent profiles | `agents/*.md` copied to `~/.pi/agent/agents/` | 2 |

Extensions load through pi's native plugin loader. Community packages are pulled in by `install.sh`, pinned by commit, and registered with pi. Agent profiles feed the installed `pi-subagents` extension.

---

## What's inside

### Own extensions

Grouped the same way `/opus-pack` groups them.

#### Safety

| Extension | What it does |
|---|---|
| `safe-deny` | Non-interactively blocks destructive operations. Argv-aware bash parser (unwraps `sudo`) catches `rm -rf /|~`, `git push --force` to main/master, `--no-verify` commits, `chmod -R 777`, `chown -R`, `dd if=/of=`, `mkfs.*`, fork bombs, `curl\|sh`. Path rules block **writes** to `.env`, `*.pem`, `*.key`, SSH keys, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.openai`, `~/.anthropic`, `~/.{claude,codex,gemini}`. **Reads** also blocked on the credential subset to prevent exfiltration into prompt context. Bypass with `PI_OPUS_PACK_UNSAFE=1`. |
| `permissions` | Granular allow / confirm / deny per tool, path, and bash pattern. 4-way interactive prompt (once / session / always / deny) with line-diff previews for `write` and approximate line numbers for `edit`. Config under `opus-pack.permissions`. |
| `dirty-repo-guard` | Warns when the session starts on a dirty working tree. |
| `iteration-guard` | Caps turns per agent run (default 40, configurable). `/continue` extends. `--max-turns=<N>` and `PI_MAX_TURNS` env var supported. |

#### Tasks & routing

| Extension | What it does |
|---|---|
| `plan-mode` | `/plan` + `Ctrl+Alt+P`. Read-only exploration mode with a numbered plan. Agent calls `exit_plan_mode(plan, save?)` → confirm dialog → execute with `[DONE:N]` tracking. `/plan-resume` reloads a saved plan across sessions. `/plan-close` is the manual escape hatch. `--plan` flag starts in plan mode. |
| `todo` | `todo` tool (`add`/`start`/`done`/`clear`) + `/todo` command. Task list with single-active invariant, mirroring Claude Code's TodoWrite. Widget + footer badge. |
| `model-router` | Heuristic auto-switch of model and thinking level per prompt. `/router <level>`, `/router status`, `/router off`. Recognises Anthropic and OpenAI rate-limit headers for graceful downgrade. Status slot: `↗ model·level`. |

#### UI & reporting

| Extension | What it does |
|---|---|
| `status` | `/status` dumps a summary (extensions, skills, prompts, MCP tools, model, context usage). Live status line: `cwd · branch · model · ctx:X%`. Footer: `ext:N skills:M mcp:K`. Optional `opus-pack.statusLine.command` runs a user shell command whose stdout lands in the footer. |
| `bash-progress` | Live widget with tail + elapsed counter for long bash commands (>2s). Doesn't modify the tool itself. |
| `mcp-compress` | Collapses verbose MCP tool results into one-line summaries (`ok memory_save: saved, id=208, deduped`). Recognises `saved` / `id` / `deduplicated` / `episode_id` / `count` / `error`. Configurable under `opus-pack.mcpCompress`. |
| `desktop-notify` | OS notification (macOS/Linux) when an agent finishes. Configurable threshold + sound. `/notify-test`. |
| `session-summary` | Auto-summary on agent exit (≥ 3 tool calls): files edited, commands run, errors encountered. |
| `cost` | `/cost` — token-usage dashboard: current session, today, past 7 days with per-day breakdown. Shows `—` when pricing is unknown (non-Anthropic providers). |
| `list-resources` | `/extensions` (doubles as a pack health dashboard), `/prompts`. `/skills` is provided by the installed `pi-skills-menu`. |

#### Integrations

| Extension | What it does |
|---|---|
| `skills` | Registers `~/.{claude,codex,gemini,pi}/skills` as skill roots so cross-vendor CC-style skills show up in pi's `<available_skills>` catalogue. |
| `hook-bridge` | Reads the `hooks` block from `settings.json` in Claude Code format and runs shell commands on pi events (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PreCompact`). Paste CC configs unchanged. |
| `pi-search` | `/pi-search [query]` — GitHub topic `pi-package` discovery + interactive install + `/reload`. 1-hour cache. |
| `claude-md-loader` | Auto-loads `~/.{claude,codex,gemini,pi}/CLAUDE.md` plus an upward walk of `CLAUDE.md` / `AGENTS.md` from the cwd into the system prompt. `/claude-md` prints what loaded. Mtime-cached. |
| `smart-compact` | Merges `.pi/compact-hints.md` or `opus-pack.compactHints` with the inline focus from built-in `/compact [focus]`. Preserves key context across compaction. |
| `log-tail` | `log_tail` / `log_kill` / `log_ps` tools + `/bg` picker. Pi-native long-running tasks: the model detaches bash to `/tmp/pi-bg-<slug>.{log,pid}`, the extension reads and kills. `watch: true` pushes new lines on every turn. Footer: `bg:N`. |
| `edit-log` | `/edit-log` — on-demand history of edit/write operations for the current session. Nothing is injected into the system prompt; output is only on demand. |
| `file-commands` | Loads `*.md` slash commands with YAML frontmatter from `~/.{claude,pi}/commands` and `<cwd>/.{claude,pi}/commands`. Subdirectories become `plugin:name` namespaces. `$ARGS` / `$1..$9` substitution. Drops in CC-format commands unmodified. |
| `deferred-tools` | Feature-flagged (`opus-pack.deferredTools.enabled`). Prunes the active tool list on every turn, hiding MCP tools behind `tool_search` / `tool_load` proxies. Saves prompt tokens when the MCP park is large. |

#### Dev loop

| Extension | What it does |
|---|---|
| `diff` | `/diff` — review agent changes: `git diff HEAD --stat` + interactive file picker with full diff. |
| `auto-commit-on-exit` | Snapshot commit on pi exit. |

#### Meta

| Extension | What it does |
|---|---|
| `opus-pack-config` | `/opus-pack` + `Ctrl+Alt+O` — picker to enable/disable any extension in the pack. Subcommands for scripting: `status`, `list [cat]`, `on <name>`, `off <name> [--force]`, `reset`, `help`. Persists to `settings.local.json`. Footer slot: `off:N` when anything is disabled. |

### Community packages installed by `install.sh`

#### Core replacements (supersede code we used to ship or fill a clear gap)

- **[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)** — subagent orchestration. 7 bundled agents (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`), TUI at `Ctrl+Shift+A`, reusable `.chain.md` pipelines, git worktree isolation, fork / async modes, fallback models, `SKILL.md` injection. Replaced our home-grown subagent.
- **[`apmantza/pi-lens`](https://github.com/apmantza/pi-lens)** — real-time code-quality pipeline on every write/edit: LSP (37 servers), linters (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop), 26+ formatters, tree-sitter rules, cyclomatic-complexity metrics, secrets scanning that blocks writes. `/lens-booboo` and `/lens-health`.
- **[`RimuruW/pi-hashline-edit`](https://github.com/RimuruW/pi-hashline-edit)** — overrides `read` / `grep` / `edit` with hash-anchored line references (`LINE#HASH`). Kills the whole "string not found" / ambiguous-match class of edit failures. Ported from oh-my-pi.
- **[`arpagon/pi-rewind`](https://github.com/arpagon/pi-rewind)** — per-turn git-ref checkpoints with conversation-state rollback, diff preview, redo stack, branch safety, safe-restore. `/rewind` + `Esc+Esc`. Replaced our earlier `rewind` and `git-checkpoint` extensions.
- **[`ttttmr/pi-context`](https://github.com/ttttmr/pi-context)** — agentic context management. `/context` dashboard plus `context_tag`, `context_log`, `context_checkout` (name milestones, move HEAD, compress completed work into a summary without a full `/compact`).
- **[`Kmiyh/pi-skills-menu`](https://github.com/Kmiyh/pi-skills-menu)** — `/skills` interactive menu: search, preview, insert, AI-assisted create, edit, rename, delete, toggle. Replaced our read-only `/skills` listing.
- **[`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw)** — `/btw` parallel side-conversation sub-session. Ask a clarifying question or explore a tangent without derailing the main agent turn; `/btw:inject` returns the result. `Alt+/` toggles focus.
- **[`edlsh/pi-ask-user`](https://github.com/edlsh/pi-ask-user)** — richer `ask_user` tool: searchable options, multi-select, freeform input, overlay mode, bundled decision-gating skill. Replaced our baseline `ask-user.ts`.

#### Security (defense-in-depth with `safe-deny` and `pi-lens`)

- **[`acarerdinc/pi-secret-guard`](https://github.com/acarerdinc/pi-secret-guard)** — scans `git commit` / `git push` diffs for 30+ secret patterns (AWS, Azure, GCP, GitHub tokens, JWT, private keys, `password=` / `api_key=` assignments) with hard-block + agent-review for suspicious cases.

| Layer | Vector | Event |
|---|---|---|
| `safe-deny` | path-based (`.env`, `*.pem`, `~/.ssh` …) on read + write | read / write / edit / grep |
| `pi-lens` | content-scan on write | write / edit |
| `pi-secret-guard` | content-scan of git diff | bash `git commit` / `git push` |

#### Performance & providers

- **[`yvgude/lean-ctx`](https://github.com/yvgude/lean-ctx)** — standalone Rust binary installed via `brew` → `cargo` → `curl` fallback chain. Compresses shell and file-read output through 90+ CLI patterns, 8 file-read modes, tree-sitter parsing across 18 languages. ~90% token savings on dev operations. Skip with `OPUS_PACK_SKIP_LEAN_CTX=1`.
- **[`shaftoe/pi-zai-usage`](https://github.com/shaftoe/pi-zai-usage)** — footer indicator for Z.ai subscription quota. Auto-activates when a `glm-*` model is in use; silent otherwise.
- **[`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)** — full two-way bridge to Claude Code (Pro/Max subscription). Registers `opus` / `sonnet` / `haiku` as selectable `/model` providers, adds an `AskClaude` delegation tool, forwards skills and MCP tools, streams with thinking support. **Anthropic-only, opt-in via `ANTHROPIC=1 ./install.sh`.**

#### Long-standing extras

- **[`obra/superpowers`](https://github.com/obra/superpowers)** — 14 skills: systematic-debugging, brainstorming, writing-plans, TDD, code-review, git-worktrees, and more. Only `skills/` is loaded; CC-only `commands/` / `agents/` / `hooks/` are filtered out.
- **[`viartemev/pi-rtk-rewrite`](https://github.com/viartemev/pi-rtk-rewrite)** — auto-rewrites bash commands through `rtk` (60–90% token savings on common commands).
- **[`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)** — MCP bridge in Claude Code format, ~200-token proxy tool, lazy lifecycle, `idleTimeout`.
- **[`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions)** — `/usage` dashboard, `/readfiles` file browser, tab-status, ralph-wiggum (long tasks), agent-guidance (Claude / Codex / Gemini switching).
- **[`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)** — compact tool-call rendering.
- **[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access)** — web search + extraction.
- **[`viartemev/pi-working-message`](https://github.com/viartemev/pi-working-message)** — cosmetic custom "working" phrases.

### Agent profiles

Two chain-compatible profiles live in `agents/` and are copied on install to `~/.pi/agent/agents/` (user scope, overrides `pi-subagents` defaults with the same name):

- **`explore`** — slow, thorough, read-only. Writes `context.md` for handoff. The counterpart to `pi-subagents`'s `scout` (which is fast and shallow).
- **`verify`** — fast, runs tests / lint / build, reports `PASS` / `FAIL`. No equivalent in the `pi-subagents` roster.

Tier is controlled by the `alias:fast|balanced|slow` hint in each profile's frontmatter; aliases resolve through `pi-subagents`'s own model map. Configure the map once and every profile follows.

---

## Configuration

### What `install.sh` touches

- `~/.pi/agent/settings.json` — `jq` deep-merge. Updates only `hooks`, `opus-pack`, and `packages`. Never clobbers unrelated keys.
- `~/.pi/agent/mcp.json` — merges the `mcpServers` block from `mcp.json.example` (empty by default; add your own servers there).
- `~/.pi/agent/APPEND_SYSTEM.md` — append-only with `<!-- Opus Pack rules START/END -->` markers. Re-runs don't duplicate.
- `~/.pi/agent/agents/` — copies `explore.md` and `verify.md` with `cp -n`. Never clobbers your edits on reinstall.
- `pi install <pkg>` for each missing community package.
- `pi install <REPO_DIR>` registers the local repo path.
- `lean-ctx` — if not on `PATH`, tries `brew` → `cargo` → `curl`. Skip with `OPUS_PACK_SKIP_LEAN_CTX=1`.

Nothing else. No changes to `~/.claude/`, no global shell-config edits.

### Provider setup

1. Make sure `pi` knows your provider (API key in an env var or in `~/.pi/agent/auth.json`).
2. Configure subagent model aliases in the `pi-subagents` settings block — see that package's README for the exact shape. Every bundled profile (`scout`, `planner`, `worker`, `reviewer`, plus our `explore` and `verify`) picks its model from the resulting alias map.
3. (Optional) Fill `opus-pack.modelRouter.levels` to auto-switch models mid-session based on prompt content. See `_levels_example_*` blocks in `settings.json.example` for provider-specific stubs.

### `settings.json` blocks after install

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

Append entries to the `hooks` arrays in Claude Code format; `hook-bridge` picks them up via `/reload` without a restart.

### Disabling an extension

Either filter in `settings.json`:

```json
{
  "packages": [{
    "source": "/path/to/opus-pack-pi",
    "extensions": ["extensions/*.ts", "!extensions/edit-log.ts"]
  }]
}
```

Or use the `/opus-pack` modal, which persists the disabled list to `settings.local.json`.

---

## Troubleshooting

**`/status` fails.** pi's introspection API is private in some builds. `status.ts` is wrapped in `try`/`catch` and shows what it can.

**A hook doesn't fire.** Verify the `matcher` matches the tool name exactly (`bash`, not `Bash`). Hook stdout must be valid JSON; `{"block": true, "reason": "..."}` blocks the call.

**`pi list` is empty after install.** pi may require a restart after the first `pi install`. Start pi once, confirm extensions load, then re-run `install.sh` to merge settings.

**`safe-deny` blocks a command you need.** Set `PI_OPUS_PACK_UNSAFE=1` for a one-shot bypass, or edit the rule and `/reload`.

**pi-lens blocks a write as a "secret".** If it's a false positive (placeholder, test fixture), either rename the file or adjust `pi-lens`'s config; the block is intentional.

---

## Maintenance

### Update

```sh
./update.sh   # pi update + git pull + re-merge settings
```

### Uninstall

```sh
./uninstall.sh
```

Removes pack-installed community packages, strips our blocks from `settings.json`, and removes the `Opus Pack rules` section from `APPEND_SYSTEM.md`. Creates a `.bak` backup. Never touches unrelated settings.

### Dev loop

Edit `extensions/*.ts` directly in the repo. Inside pi, run `/reload` — changes apply without a restart. pi references the repo by path; it doesn't copy files.

Release flow:

```sh
git tag vX.Y && git push origin main --tags
```

On other machines: `pi install git:github.com/h3llb0ys/opus-pack-pi@vX.Y`.

---

## License

MIT. See [LICENSE](./LICENSE).
