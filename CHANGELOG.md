# Changelog

Формат — обратный хронологический. Версии = git-теги.

## Unreleased

### Provider-neutrality
- Пакет теперь провайдер-нейтрален. Документация и дефолты больше не предполагают Anthropic.
- `opus-pack.subagent.modelAlias` (`fast`/`balanced`/`slow`) — one-shot-смена провайдера без правки frontmatter'ов агентов.
- `model-router.levels` в `settings.json.example` — пустой по умолчанию; `_levels_example_{anthropic,openai,ollama}` как placeholder-блоки.
- `claude-md-loader` сканит `~/.{claude,codex,gemini,pi}/` (не только `~/.claude/`).
- `skills.ts` — 4 корня (`.claude`, `.codex`, `.gemini`, `.pi`).
- `safe-deny` защищает `~/.codex`, `~/.gemini`, `~/.openai`, `~/.anthropic` вдобавок к `~/.claude`.
- `model-router.parseRetryAfter` понимает OpenAI-стиль `retry-after-ms`, `x-ratelimit-reset-{requests,tokens}[-ms]`.
- `cost.ts` показывает `—` вместо `$0.00` когда pricing отсутствует.
- `status.ts` footer slot `90-opus` → `90-pack`.
- `claude-total-memory` полностью выпилен — подключай свой MCP через `~/.pi/agent/mcp.json`.
- `meridian` (Claude Max proxy) переведён в opt-in через `ANTHROPIC=1` при запуске `install.sh`.

### New features
- **`/plan-resume`** + progress writeback. План пишется в `.pi/plans/<ts>-<slug>.md` с frontmatter `{created, status, done_steps}`. На `turn_end` новые `[DONE:N]` маркеры пишутся обратно в файл. `/plan-resume` без аргумента показывает picker, с аргументом — substring match по имени. Финализация выставляет status `completed`/`closed`.
- **`/plan-close`** — ручной escape hatch когда модель забыла `[DONE:N]` на последнем шаге.
- **`/extensions`** — health-dashboard: OPUS_EXTENSIONS с enabled/disabled state по категориям + aggregate counters.
- **file-based slash commands** (`extensions/file-commands.ts`): сканит 4 корня (`~/.{pi,claude}/commands` + `<cwd>/.{pi,claude}/commands`), frontmatter + body → `pi.sendUserMessage`, `$ARGS`/`$1..$9`, subdirs → `plugin:name` namespace.
- **deferred tool schemas** (`extensions/deferred-tools.ts`, feature-flagged): `tool_search` + `tool_load` прячут MCP tools до explicit load'а.
- **log-tail watch-mode**: `log_tail({watch: true})` пушит новые строки как hidden context-message на каждом turn.
- **subagent file-persist** (`.pi/agents/<runId>.jsonl`) + `continue_from` param — compressed summary previous run'а prepend'ится в system prompt.
- **statusline shell-command**: `opus-pack.statusLine.command` → stdout в slot `85-shell`.
- **Multi-layer permissions merge**: `~/.pi/agent/settings.json` + `.local.json` + `<cwd>/.pi/settings.json` + `.local.json` (CC user/project/local tiers).
- **Bundled agent profiles** теперь реально грузятся (были в репо, но `discoverAgents` их игнорил). Priority: `bundled < user < project`.
- **diff-preview для write** — реальный line-diff между диском и новым content'ом с ±2 строк контекста.
- **line numbers в edit preview** — `indexOf(oldText)` даёт approximate line.
- **iteration-guard** — `defaultCap` / `extendBy` в `opus-pack.iterationGuard`.

### Fixes / security
- **subagent `continue_from` path traversal** — `runId` валидируется против `^[\w.-]+$`.
- **deferred-tools** turn-semantics — `loadedThisTurn` flag, двухфазный clear чтобы loaded tools доживали до следующего turn'а.
- **file-commands** — `lstatSync` вместо `statSync` + `MAX_WALK_DEPTH` cap защищают от symlink cycles.
- **subagent.makeRunId** — `crypto.randomBytes(3)` hex вместо `Math.random()` (anti-collision при параллельных spawn'ах).
- **log-tail.readNewBytes** — trim буфера до последнего `\n` чтобы строки не резались пополам между push'ами.
- **plan-mode** — defensive clear в `before_agent_start` если все `todos.every(completed)` но `agent_end` не успел почистить.
- **install.sh** — deep-merge `opus-pack` блока через jq `*`, пользовательские customisation'ы выживают `update.sh`. Arrays (rules, compactHints) пустые в example, дефолты как `_example_*` для copy-paste.

### Misc
- `.gitignore` (node_modules, dist, .pi, .DS_Store, *.log).
- `package.json` — `engines.node >=18`, peerDeps пинятся к `>=0.67` для pi.
- README — provider-setup quick-start, clone-path generic (не `~/extra/opus-pack-pi`).

## v0.6 и ранее

См. git-историю — `git log --oneline vX.Y..HEAD`.
