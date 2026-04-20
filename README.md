# opus-pack-pi

Provider-neutral extension bundle for [pi-coding-agent](https://github.com/badlogic/pi-mono). Adds Claude-Code-parity features (plan mode, todo, permissions, CC-style hooks, skill discovery), curates a set of community packages for subagents, code quality, editing, and context management, and wires everything up through a single idempotent installer.

> Works with Anthropic, OpenAI, Ollama, local `llama.cpp`, or custom proxies. Swap providers by editing one alias map.

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

Full reference: [**extensions/README.md**](./extensions/README.md). Summary, grouped the same way `/opus-pack` groups them:

| Category | Extensions |
|---|---|
| **Safety** | `safe-deny`, `permissions`, `dirty-repo-guard`, `iteration-guard` |
| **Tasks & routing** | `plan-mode`, `todo`, `model-router` |
| **UI & reporting** | `status`, `bash-progress`, `mcp-compress`, `desktop-notify`, `session-summary`, `list-resources` |
| **Integrations** | `cc-bridge/` (skills, commands, claude-md, hooks), `smart-compact`, `log-tail`, `pi-search`, `deferred-tools` |
| **Dev loop** | `diff` |
| **Meta** | `opus-pack-config` |

Highlights:

- **`cc-bridge/`** — one extension hosting four sub-modules (skills / commands / claude-md / hooks) that bridge cross-vendor config trees (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.pi`, plus the same four at project scope). Hooks support the Claude Code `hooks` block in `settings.json` and file-based hooks under `<vendor>/hooks/*.md|*.sh`. Everything under one `/cc-bridge [status|reload|help]` slash.
- **`safe-deny`** — non-interactive guardrail against destructive bash (argv-aware, sudo-unwrapping) and credential access (blocks read **and** write on `.env`, `*.pem`, SSH keys, `~/.aws`, `~/.kube`, etc.). Bypass: `PI_OPUS_PACK_UNSAFE=1`.
- **`plan-mode`** — `/plan` + `Ctrl+Alt+P`, cross-session `/plan-resume`, `[DONE:N]` progress tracking, `--plan` startup flag.
- **`model-router`** — heuristic model + thinking-level switcher per prompt with rate-limit downgrade on 429.
- **`opus-pack-config`** — `/opus-pack` modal and subcommands to toggle any extension at runtime.

### Community packages installed by `install.sh`

#### Subagents

- **[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)** — subagent orchestration. Seven bundled agents (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`), TUI at `Ctrl+Shift+A`, reusable `.chain.md` pipelines, git worktree isolation, fork / async modes, fallback models, `SKILL.md` injection.

#### Editing & code quality

- **[`apmantza/pi-lens`](https://github.com/apmantza/pi-lens)** — runs LSP (37 servers), linters (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop), 26+ formatters, tree-sitter rules, cyclomatic-complexity metrics, and a secrets scanner on every `write`/`edit`. Blocks writes that fail secret or quality checks. `/lens-booboo` and `/lens-health`.
- **[`RimuruW/pi-hashline-edit`](https://github.com/RimuruW/pi-hashline-edit)** — hash-anchored `read` / `grep` / `edit`. Every line returned by `read` carries a `LINE#HASH` prefix; `edit` references anchors instead of raw text, so stale context fails loud and ambiguous matches never silently corrupt a file.

#### Checkpoints & context

- **[`arpagon/pi-rewind`](https://github.com/arpagon/pi-rewind)** — per-turn git-ref checkpoints with conversation-state rollback, diff preview, redo stack, branch safety, and a refuse-list that keeps `node_modules` / `.venv` out of harm's way. `/rewind` + `Esc+Esc`.
- **[`ttttmr/pi-context`](https://github.com/ttttmr/pi-context)** — agentic context management. `/context` dashboard plus `context_tag`, `context_log`, `context_checkout` (name milestones, move HEAD, compress completed work into a summary without a full `/compact`).

#### User interaction

- **[`edlsh/pi-ask-user`](https://github.com/edlsh/pi-ask-user)** — `ask_user` tool with searchable options, multi-select, freeform input, overlay mode, and a bundled decision-gating skill.
- **[`Kmiyh/pi-skills-menu`](https://github.com/Kmiyh/pi-skills-menu)** — `/skills` interactive menu: search, preview, insert, AI-assisted create, edit, rename, delete, enable/disable.
- **[`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw)** — `/btw` parallel side-conversation sub-session. Ask a clarifying question or explore a tangent without derailing the main turn; `/btw:inject` returns the result. `Alt+/` toggles focus.

#### Security

These three layer cleanly, each covering a different tool event:

| Layer | Vector | Event |
|---|---|---|
| `safe-deny` (own) | path-based (`.env`, `*.pem`, `~/.ssh` …) on read + write | `read` / `write` / `edit` / `grep` |
| `pi-lens` | content-scan on write | `write` / `edit` |
| `pi-secret-guard` | content-scan of git diff | `bash` `git commit` / `git push` |

- **[`acarerdinc/pi-secret-guard`](https://github.com/acarerdinc/pi-secret-guard)** — scans `git commit` / `git push` diffs for 30+ secret patterns (AWS, Azure, GCP, GitHub tokens, JWT, private keys, `password=` / `api_key=` assignments) with hard-block + agent-review for suspicious cases.

#### Performance & providers

- **[`yvgude/lean-ctx`](https://github.com/yvgude/lean-ctx)** — standalone Rust binary installed via `brew` → `cargo` → `curl` fallback chain. Compresses shell and file-read output through 90+ CLI patterns, 8 file-read modes, tree-sitter parsing across 18 languages. ~90% token savings on dev operations. Skip with `OPUS_PACK_SKIP_LEAN_CTX=1`.
- **[`shaftoe/pi-zai-usage`](https://github.com/shaftoe/pi-zai-usage)** — footer indicator for Z.ai subscription quota. Active only when a `glm-*` model is in use; silent otherwise.
- **[`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)** — two-way bridge to Claude Code (Pro/Max subscription). Registers `opus` / `sonnet` / `haiku` as selectable `/model` providers, adds an `AskClaude` delegation tool, forwards skills and MCP tools, streams with thinking support. **Anthropic-only, opt-in via `ANTHROPIC=1 ./install.sh`.**

#### Skills, MCP, and misc

- **[`obra/superpowers`](https://github.com/obra/superpowers)** — 14 skills: systematic-debugging, brainstorming, writing-plans, TDD, code-review, git-worktrees, and others. Only `skills/` is loaded; CC-only `commands/` / `agents/` / `hooks/` are filtered out.
- **[`viartemev/pi-rtk-rewrite`](https://github.com/viartemev/pi-rtk-rewrite)** — rewrites bash commands through `rtk` (60–90% token savings on common commands).
- **[`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)** — MCP bridge in Claude Code format, ~200-token proxy tool, lazy lifecycle, `idleTimeout`.
- **[`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions)** — `/usage` dashboard, `/readfiles` file browser, tab-status, ralph-wiggum (long tasks), agent-guidance (Claude / Codex / Gemini switching).
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

Append entries to the `hooks` arrays in Claude Code format; `cc-bridge.hooks` picks them up via `/reload` without a restart. For file-based hooks, drop a `*.md` or `*.sh` into `~/.pi/agent/hooks/` or `<cwd>/.pi/hooks/` with an `event:` frontmatter line and an optional `matcher:`.

### Disabling an extension

Either filter in `settings.json`:

```json
{
  "packages": [{
    "source": "/path/to/opus-pack-pi",
    "extensions": ["extensions/*.ts", "!extensions/diff.ts"]
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
