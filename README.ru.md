# opus-pack-pi

Opinionated bundle расширений для [pi-coding-agent](https://github.com/badlogic/pi-mono), дополняющий его CC-паритетом (plan mode, todo, permissions, skills, CC-style hooks и т.д.). Название историческое — пакет начался как сборка под Claude Opus 4.7, но сейчас **провайдер-нейтрален**: работает с Anthropic / OpenAI / Ollama / любым другим провайдером, поддерживаемым pi. Модели router'а конфигурятся через алиасы в `settings.json`. Subagent-оркестрация делегирована [`pi-subagents`](https://github.com/nicobailon/pi-subagents), статический quality-pipeline — [`pi-lens`](https://github.com/apmantza/pi-lens), сжатие shell/file вывода — [`lean-ctx`](https://github.com/yvgude/lean-ctx).

Берёт community-расширения через нативный `pi install` и добавляет собственные extension'ы для дыр, которые community не закрывает.

## Что внутри

### Собственные extensions (`extensions/`)

| Extension | Что делает |
|---|---|
| `plan-mode.ts` | `/plan` + `Ctrl+Alt+P` — read-only exploration, numbered plan. LLM вызывает `exit_plan_mode(plan)` → confirm-dialog → execute с `[DONE:N]` tracking. Флаг `--plan`. |
| `permissions.ts` | Granular allow/confirm/deny per tool + path/pattern. Config в `opus-pack.permissions`. Усиливает safe-deny. |
| `todo.ts` | `todo` tool (add/start/done/clear) + `/todo` command — task list с `in_progress` состоянием и single-active invariant (как CC TodoWrite). Widget + status bar. |
| `log-tail.ts` | `log_tail` / `log_kill` / `log_ps` tools + `/bg` — pi-native long-running tasks. Модель detach'ит bash в `/tmp/pi-bg-<slug>.{log,pid}`, extension читает/убивает. Status bar: `bg:N`. Watch-mode пушит новые строки на каждый turn. |
| `diff.ts` | `/diff` — обзор изменений агента: `git diff HEAD --stat` + интерактивный пикер файла с полным diff. |
| `cost.ts` | `/cost` — дашборд token usage: текущая сессия, за сегодня, за 7 дней с breakdown по дням. |
| `session-summary.ts` | Авто-резюме при завершении agent'а (если ≥3 tool calls): сколько файлов изменено, команд запущено, ошибок. |
| `smart-compact.ts` | Мерджит `.pi/compact-hints.md` / `opus-pack.compactHints` с inline focus от built-in `/compact [focus]`. Сохраняет ключевой контекст при compact. |
| `skills.ts` | Регистрирует `~/.claude/skills/` как skill root, чтоб CC-style скиллы подхватывались pi-native `<available_skills>` каталогом. |
| `desktop-notify.ts` | OS notification (macOS/Linux) по завершении agent'а. Настройка порога длительности + звук. `/notify-test`. |
| `iteration-guard.ts` | Cap на turns в одном agent-run'е (default 40). `/continue` → `+20`. Флаг `--max-turns=<N>`. |
| `safe-deny.ts` | Без интерактивных confirm-диалогов блокирует деструктив. Bash (argv-aware, разворачивает sudo): `rm -rf /|~`, `git push --force` на main/master, `git commit --no-verify`, `chmod -R 777`, `chown -R`, `dd if=/of=`, `mkfs.*`, fork bombs, `curl\|sh`. Path: **write** на `.env`, `*.pem`, `*.key`, `id_rsa/ed25519/...`, `.netrc`, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.openai`, `~/.anthropic`, `~/.{claude,codex,gemini}`; **read** на credential-подмножество (предотвращает утечку в prompt). Bypass: `PI_OPUS_PACK_UNSAFE=1`. |
| `status.ts` | Slash `/status` — сводка (extensions, skills, prompts, MCP tools, model, ctx usage). Live statusline: `cwd · branch · model · ctx:X%`. Footer: `ext:N skills:M mcp:K`. |
| `list-resources.ts` | Slashes `/extensions`, `/prompts` — listing с описаниями. `/skills` делегирован в `pi-skills-menu` (full CRUD). |
| `hook-bridge.ts` | Читает блок `hooks` из `settings.json` в формате Claude Code, запускает shell-команды на pi-события (`PreToolUse` / `PostToolUse` / `SessionStart` / `Stop` / `UserPromptSubmit` / `PreCompact`). Позволяет копипастить CC-конфиги и сторонние hook-скрипты. |
| `claude-md-loader.ts` | Автоподхват `~/.claude/CLAUDE.md` + upward walk `CLAUDE.md` / `AGENTS.md` в system prompt. `/claude-md` — debug. Mtime-cached. |
| `model-router.ts` | Heuristic auto-switch модели и thinking level по промпту. `/router <level>`, `/router status`, `/router off`. Provider-agnostic. Status slot `↗ model·level`. |
| `bash-progress.ts` | Live widget с tail логов и elapsed counter для долгих bash-команд (>2s). Не меняет сам tool. |
| `pi-search.ts` | `/pi-search [query]` — GitHub topic `pi-package` discovery + interactive install + `/reload`. Cache 1h. |
| `mcp-compress.ts` | Схлопывает verbose MCP tool results в 1-строчные summaries (`ok  memory_save: saved, id=208, deduped`). Recognises saved/id/deduplicated/episode_id/count/error. Config `opus-pack.mcpCompress` (prefixes, maxLineLen, whitelist). |
| `opus-pack-config.ts` | `/opus-pack` + `Ctrl+Alt+O` — пикер on/off всех extensions этого пакета. Persist в `settings.local.json` под `opus-pack.extensions.disabled`. Есть Save & Reload (без рестарта pi). Slot `off:N` в footer когда что-то выключено. |
| `edit-log.ts` | `/edit-log` — on-demand история edit/write за сессию (файл → инструмент + время + snippet первой новой строки). Ничего не инжектит в system prompt — только по запросу. |

### Vendored extensions (из `pi-mono/examples/extensions/`)

- `auto-commit-on-exit.ts` — snapshot при выходе из pi.
- `dirty-repo-guard.ts` — warn при старте на грязном working tree.

### Agent профили (`agents/`)

Top-level профили в `agents/` подхватываются установленным `pi-subagents` рядом с его собственной пачкой (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`):

- `explore.md` (`alias:slow`, read-only) — поиск паттернов, возвращает summary + указания на файлы.
- `verify.md` (`alias:fast`) — запуск тестов/lint/build, отчёт pass/fail.

Алиасы `fast` / `balanced` / `slow` резолвятся конфигом `pi-subagents` — подставь свой провайдер там один раз, профили трогать не надо.

### Community packages, которые ставит installer

Core replacements (заменяют код который мы раньше писали сами или закрывают явную дыру):

- [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) — subagent-оркестрация: 7 дефолтных агентов (scout/planner/worker/reviewer/context-builder/researcher/delegate), TUI на `Ctrl+Shift+A`, `.chain.md` pipelines, git worktree isolation, fork/async режимы, fallback models, SKILL.md injection. Заменил наш `extensions/subagent/`.
- [`apmantza/pi-lens`](https://github.com/apmantza/pi-lens) — quality pipeline на каждый write/edit: LSP (37 серверов), линтеры (Biome/Ruff/ESLint/stylelint/sqlfluff/RuboCop), 26+ форматтеров, tree-sitter rules, cyclomatic complexity, secrets scanning с блоком write. `/lens-booboo`, `/lens-health`.
- [`RimuruW/pi-hashline-edit`](https://github.com/RimuruW/pi-hashline-edit) — перехват `read`/`grep`/`edit` с hash-anchored line references (`LINE#HASH`). Убивает класс багов с "string not found" / ambiguous-match. Портирован из oh-my-pi.
- [`arpagon/pi-rewind`](https://github.com/arpagon/pi-rewind) — per-turn git-ref checkpoints с conversation rollback, diff preview, redo stack, branch safety, safe-restore. `/rewind` + `Esc+Esc`. Заменил наши `rewind` + `git-checkpoint`.
- [`ttttmr/pi-context`](https://github.com/ttttmr/pi-context) — agentic context management. `/context` dashboard + `context_tag`, `context_log`, `context_checkout` (git-like: milestone'ы, move HEAD, сжатие завершённых задач в summary без полного `/compact`).
- [`Kmiyh/pi-skills-menu`](https://github.com/Kmiyh/pi-skills-menu) — `/skills` интерактивное меню: search/preview/insert/AI-assisted create/edit/rename/delete/toggle. Заменил нашу read-only `/skills` listing.
- [`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw) — `/btw` параллельная side-conversation sub-сессия. Clarifying вопросы или tangent без derailing основного агента; `/btw:inject` возвращает результат. `Alt+/` переключает фокус.
- [`edlsh/pi-ask-user`](https://github.com/edlsh/pi-ask-user) — богаче `ask_user` tool: searchable options, multi-select, freeform input, overlay mode, bundled decision-gating skill. Заменил baseline `extensions/ask-user.ts`.

Security (defense-in-depth в паре с `safe-deny` и `pi-lens`):

- [`acarerdinc/pi-secret-guard`](https://github.com/acarerdinc/pi-secret-guard) — сканит diff'ы `git commit`/`git push` на 30+ secret patterns (AWS/Azure/GCP/GitHub tokens, JWT, private keys, password=/api_key= assignments) с hard-block + agent-review для подозрительных.

Provider / performance:

- [`yvgude/lean-ctx`](https://github.com/yvgude/lean-ctx) — standalone Rust binary (ставится через brew/cargo/curl fallback chain). Жмёт shell и file-read вывод через 90+ CLI patterns, 8 file-read modes, tree-sitter на 18 языков. ~90% token savings. Skip через `OPUS_PACK_SKIP_LEAN_CTX=1`.
- [`shaftoe/pi-zai-usage`](https://github.com/shaftoe/pi-zai-usage) — footer indicator для Z.ai subscription quota. Авто-активация только при `glm-*` моделях, иначе молчит.
- [`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge) — полная двусторонняя интеграция с Claude Code (Pro/Max). Регистрирует `opus`/`sonnet`/`haiku` как провайдеры через `/model`, tool `AskClaude` для делегации, forwarding skills/MCP tools, streaming + thinking. Заменил meridian. **Anthropic-only, opt-in через `ANTHROPIC=1 ./install.sh`.**

Long-standing community extras:

- [`obra/superpowers`](https://github.com/obra/superpowers) — 14 skills (systematic-debugging, brainstorming, writing-plans, TDD, code-review, git-worktrees, ...). Только `skills/` — CC-only `commands/`/`agents/`/`hooks/` отфильтрованы.
- [`viartemev/pi-rtk-rewrite`](https://github.com/viartemev/pi-rtk-rewrite) — авто-rtk rewrite на bash (60-90% token savings).
- [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) — MCP bridge (CC-формат, proxy-tool ~200 tokens, lazy lifecycle, idleTimeout).
- [`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions) — `/usage` dashboard, `/readfiles` file browser, tab-status, ralph-wiggum (long tasks), agent-guidance (Claude/Codex/Gemini switching).
- [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) — компактный рендеринг tool calls.
- [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) — web search + extraction.
- [`viartemev/pi-working-message`](https://github.com/viartemev/pi-working-message) — косметика, кастомные working-фразы.

## Требования

- [pi](https://pi.dev) (`brew install pi` или см. pi.dev)
- `jq` (`brew install jq` / `apt install jq`)

## Quick install

Локально (dev):

```sh
git clone https://github.com/h3llb0ys/opus-pack-pi
cd opus-pack-pi
./install.sh
```

С GitHub (production на любой машине):

```sh
# Замени <tag> на актуальный — см. https://github.com/h3llb0ys/opus-pack-pi/tags
pi install git:github.com/h3llb0ys/opus-pack-pi@<tag>
# Затем для community-пакетов и merge конфигов:
bash "$(pi list | grep opus-pack-pi | awk '{print $NF}')/install.sh"
```

`install.sh` идемпотентный — повторный запуск безопасен, для уже установленного печатает `[skip]`. `opus-pack` блок в `settings.json` deep-merge'ится через jq, пользовательские ключи сохраняются.

## Provider setup (после install)

Пакет провайдер-нейтрален. Работающий setup для любого провайдера:

1. Убедись что `pi` знает твой провайдер (ключ в env или `~/.pi/agent/auth.json`).
2. Настрой model aliases в конфиге `pi-subagents` (см. README этого пакета) — там резолвятся `fast` / `balanced` / `slow` для всех профилей (`scout`, `planner`, `worker`, `reviewer` + наши `explore` / `verify`).
3. (Опционально) заполни `opus-pack.modelRouter.levels` для авто-переключения модели в основной сессии. Примеры см. в `settings.json.example` (ключи `_levels_example_*`).

Готовые multi-provider примеры для router-блока лежат в `settings.json.example`.

## Что `install.sh` трогает

- `~/.pi/agent/settings.json` — **merge через jq**, не перезаписывает чужие ключи. Добавляет/обновляет только `hooks`, `opus-pack`, `packages`.
- `~/.pi/agent/mcp.json` — мерджит `mcpServers` блок из `mcp.json.example` (по умолчанию пустой, добавляй свои MCP-серверы туда).
- `~/.pi/agent/APPEND_SYSTEM.md` — **append-only** с маркерами `<!-- Opus Pack rules START/END -->`. Повторный запуск не дублирует.
- `~/.pi/agent/agents/` — копирует наши профили (`explore.md`, `verify.md`) через `cp -n` (не перетирает твои изменения при reinstall).
- `pi install <pkg>` для каждого недостающего community-пакета.
- `pi install <REPO_DIR>` — регистрирует локальный путь репо.
- `lean-ctx` (standalone Rust binary) — если ещё не установлен, пробует brew → cargo → curl fallback. Skip через `OPUS_PACK_SKIP_LEAN_CTX=1`.

Ничего больше. Никаких правок в `~/.claude/`, никаких глобальных shell-конфигов.

## Конфиг

Блоки в `settings.json` после install:

```json
{
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
    "SessionStart": [],
    "Stop": []
  },
  "opus-pack": {
    "max-turns": 40,
    "safe-deny": { "enabled": true }
  }
}
```

Для своих хуков просто дописывай элементы в массивы `PreToolUse` / `Stop` / ... в формате Claude Code. `hook-bridge.ts` подхватит без рестарта через `/reload`.

MCP-серверы живут отдельно в `~/.pi/agent/mcp.json` (формат см. `mcp.json.example`). Пакет по умолчанию ничего туда не кладёт — добавляй свои серверы сам.

Чтобы **выключить** какой-то extension из пакета — фильтр в `settings.json`:

```json
{
  "packages": [{
    "source": "/path/to/opus-pack-pi",
    "extensions": ["extensions/*.ts", "!extensions/edit-log.ts"]
  }]
}
```

## Troubleshooting

- **`/status` падает** — pi'шный API интроспекции может быть приватным в некоторых билдах; status.ts защищён try/catch, показывает что смог.
- **Hook не срабатывает** — проверь что `matcher` соответствует имени tool'а (например `bash`, не `Bash`). Stdout хука должен быть валидным JSON с `{"block": true, "reason": "..."}` для блокировки.
- **`pi list` пуст после install** — pi может требовать рестарта после первого `pi install`. Запусти `pi` один раз, убедись что extensions загрузились, потом выполни повторно `install.sh` для merge settings.
- **`safe-deny` блокирует нужную команду** — `PI_OPUS_PACK_UNSAFE=1 pi ...` на одноразовый обход, или отредактируй `extensions/safe-deny.ts` и сделай `/reload`.

## Update

```sh
./update.sh   # pi update + git pull + re-merge settings
```

## Uninstall

```sh
./uninstall.sh
```

Снимает все наши пакеты, чистит наши блоки в `settings.json`, вырезает `Opus Pack rules` из `APPEND_SYSTEM.md`. Делает `.bak` бэкап. Чужих настроек не трогает.

## Dev-loop

Редактируй `extensions/*.ts` прямо в папке репозитория. Внутри pi вызови `/reload` — подхватит без рестарта. pi ссылается на путь, не копирует файлы.

Когда готов релиз:

```sh
git tag vX.Y && git push origin main --tags
```

На других машинах: `pi install git:github.com/h3llb0ys/opus-pack-pi@vX.Y`.

## License

MIT. См. [LICENSE](./LICENSE).
