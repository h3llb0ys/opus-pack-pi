# opus-pack-pi

Opinionated bundle для запуска Claude Opus 4.7 внутри [pi-coding-agent](https://github.com/badlogic/pi-mono). Берёт community-расширения через нативный `pi install` и добавляет четыре собственных extension'а для дыр, которые community не закрывает.

## Что внутри

### Собственные extensions (`extensions/`)

| Extension | Что делает |
|---|---|
| `plan-mode.ts` | `/plan` + `Ctrl+Alt+P` — read-only exploration, numbered plan. LLM вызывает `exit_plan_mode(plan)` → confirm-dialog → execute с `[DONE:N]` tracking. Флаг `--plan`. |
| `permissions.ts` | Granular allow/confirm/deny per tool + path/pattern. Config в `opus-pack.permissions`. Усиливает safe-deny. |
| `todo.ts` | `todo` tool (add/start/done/clear) + `/todo` command — task list с `in_progress` состоянием и single-active invariant (как CC TodoWrite). Widget + status bar. |
| `log-tail.ts` | `log_tail` / `log_kill` / `log_ps` tools + `/bg` — pi-native long-running tasks. Opus detach'ит bash в `/tmp/pi-bg-<slug>.{log,pid}`, extension читает/убивает. Status bar: `bg:N`. |
| `diff.ts` | `/diff` — обзор изменений агента: `git diff HEAD --stat` + интерактивный пикер файла с полным diff. |
| `rewind.ts` | `/rewind` — undo/rollback: discard changes, undo last commit, reset к произвольному коммиту или stash. |
| `cost.ts` | `/cost` — дашборд token usage: текущая сессия, за сегодня, за 7 дней с breakdown по дням. |
| `context.ts` | `/context` — что жрёт контекст: breakdown по типам (system/user/tool), топ tools, топ файлов. |
| `session-summary.ts` | Авто-резюме при завершении agent'а (если ≥3 tool calls): сколько файлов изменено, команд запущено, ошибок. |
| `smart-compact.ts` | Мерджит `.pi/compact-hints.md` / `opus-pack.compactHints` с inline focus от built-in `/compact [focus]`. Сохраняет ключевой контекст при compact. |
| `skills.ts` | Регистрирует `~/.claude/skills/` как skill root, чтоб CC-style скиллы подхватывались pi-native `<available_skills>` каталогом. |
| `desktop-notify.ts` | OS notification (macOS/Linux) по завершении agent'а. Настройка порога длительности + звук. `/notify-test`. |
| `iteration-guard.ts` | Cap на turns в одном agent-run'е (default 40). `/continue` → `+20`. Флаг `--max-turns=<N>`. |
| `safe-deny.ts` | Без интерактивных confirm-диалогов блокирует `rm -rf /`, `git push --force` на main, `--no-verify` commits, запись в `~/.claude/`, `.env`, `*.pem`, `~/.ssh`. Bypass: `PI_OPUS_PACK_UNSAFE=1`. |
| `status.ts` | Slash `/status` — сводка (extensions, skills, prompts, MCP tools, model, ctx usage). Live statusline: `cwd · branch · model · ctx:X%`. Footer: `ext:N skills:M mcp:K`. |
| `list-resources.ts` | Slashes `/skills`, `/extensions`, `/prompts` — listing с описаниями (как в Claude Code). |
| `hook-bridge.ts` | Читает блок `hooks` из `settings.json` в формате Claude Code, запускает shell-команды на pi-события (`PreToolUse` / `PostToolUse` / `SessionStart` / `Stop` / `UserPromptSubmit` / `PreCompact`). Позволяет копипастить CC-конфиги и сторонние hook-скрипты. |
| `claude-md-loader.ts` | Автоподхват `~/.claude/CLAUDE.md` + upward walk `CLAUDE.md` / `AGENTS.md` в system prompt. `/claude-md` — debug. Mtime-cached. |
| `model-router.ts` | Heuristic auto-switch модели и thinking level по промпту. `/router <level>`, `/router status`, `/router off`. Provider-agnostic. Status slot `↗ model·level`. |
| `bash-progress.ts` | Live widget с tail логов и elapsed counter для долгих bash-команд (>2s). Не меняет сам tool. |
| `ask-user.ts` | LLM-tool `ask_user(question, choices?)` для clarifying questions. Non-interactive → error, fallback на best judgement. |
| `pi-search.ts` | `/pi-search [query]` — GitHub topic `pi-package` discovery + interactive install + `/reload`. Cache 1h. |
| `mcp-compress.ts` | Схлопывает verbose MCP tool results в 1-строчные summaries (`ok  memory_save: saved, id=208, deduped`). Recognises saved/id/deduplicated/episode_id/count/error. Config `opus-pack.mcpCompress` (prefixes, maxLineLen, whitelist). |

### Vendored extensions (из `pi-mono/examples/extensions/`)

- `subagent/` — `Agent(task, agent_type)` tool, спавнит `pi --json` в subprocess. Работает с `agents/*.md` профилями.
- `git-checkpoint.ts` — авто-snapshot перед write/edit/bash.
- `auto-commit-on-exit.ts` — snapshot при выходе из pi.
- `dirty-repo-guard.ts` — warn при старте на грязном working tree.

### Agent профили (`agents/`)

- `explore.md` (Opus 4.7, read-only) — поиск паттернов, возвращает summary + указания на файлы.
- `verify.md` (Sonnet 4.6, дешевле) — запуск тестов/lint/build, отчёт pass/fail.
- `general-purpose.md` (Opus 4.7, full toolset, 20-turn cap) — задачи, не вписавшиеся в первые два.

### Community packages, которые ставит installer

- `obra/superpowers` — 14 skills (systematic-debugging, brainstorming, writing-plans, TDD, code-review, git-worktrees, ...). Только `skills/` — CC-only `commands/`/`agents/`/`hooks/` отфильтрованы.
- `rynfar/meridian` — proxy для Claude Max подписки (unlimited Opus).
- `viartemev/pi-rtk-rewrite` — авто-rtk rewrite на bash (60-90% token savings).
- `nicobailon/pi-mcp-adapter` — MCP bridge (CC-формат, proxy-tool ~200 tokens, lazy lifecycle, idleTimeout).
- `tmustier/pi-extensions` — `/usage` dashboard, `/readfiles` file browser, tab-status, ralph-wiggum (long tasks), agent-guidance (Claude/Codex/Gemini switching).
- `MasuRii/pi-tool-display` — компактный рендеринг tool calls.
- `nicobailon/pi-web-access` — web search + extraction.
- `viartemev/pi-working-message` — косметика, кастомные working-фразы.

## Требования

- [pi](https://pi.dev) (`brew install pi` или см. pi.dev)
- `jq` (`brew install jq` / `apt install jq`)
- [claude-total-memory](https://github.com/vitaliimacpro/claude-total-memory) — для memory MCP сервера (опционально, без него просто не будут доступны `ctm_memory_*` tools)

## Quick install

Локально (dev):

```sh
git clone https://github.com/h3llb0ys/opus-pack-pi ~/extra/opus-pack-pi
cd ~/extra/opus-pack-pi
./install.sh
```

С GitHub (production на любой машине):

```sh
pi install git:github.com/h3llb0ys/opus-pack-pi@v0.1
# Затем для community-пакетов и merge конфигов:
bash "$(pi list | grep opus-pack-pi | awk '{print $NF}')/install.sh"
```

`install.sh` идемпотентный — повторный запуск безопасен, для уже установленного печатает `[skip]`.

## Что `install.sh` трогает

- `~/.pi/agent/settings.json` — **merge через jq**, не перезаписывает чужие ключи. Добавляет/обновляет только `mcpServers`, `hooks`, `opus-pack`, `packages`.
- `~/.pi/agent/APPEND_SYSTEM.md` — **append-only** с маркерами `<!-- Opus Pack rules START/END -->`. Повторный запуск не дублирует.
- `pi install <pkg>` для каждого недостающего community-пакета.
- `pi install <REPO_DIR>` — регистрирует локальный путь репо.

Ничего больше. Никаких правок в `~/.claude/`, никаких глобальных shell-конфигов.

## Конфиг

Блоки в `settings.json` после install:

```json
{
  "mcpServers": {
    "ctm": {
      "command": "/Users/smirnov_as/extra/mcp/claude-total-memory/.venv/bin/claude-total-memory",
      "args": [],
      "lifecycle": "lazy",
      "idleTimeout": 60,
      "toolPrefix": "server"
    }
  },
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

Чтобы **выключить** какой-то extension из пакета — фильтр в `settings.json`:

```json
{
  "packages": [{
    "source": "/path/to/opus-pack-pi",
    "extensions": ["extensions/*.ts", "!extensions/git-checkpoint.ts"]
  }]
}
```

## Troubleshooting

- **`ctm_*` tools не появились** — проверь что `pi-mcp-adapter` установлен (`pi list`) и что `claude-total-memory` бинарь существует и исполняемый. При первом вызове tool'а lazy-подключение занимает 3-5 секунд.
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

Редактируй `extensions/*.ts` прямо в `~/extra/opus-pack-pi/`. Внутри pi вызови `/reload` — подхватит без рестарта. pi ссылается на путь, не копирует файлы.

Когда готов релиз:

```sh
git tag v0.2 && git push origin main --tags
```

На других машинах: `pi install git:github.com/h3llb0ys/opus-pack-pi@v0.2`.

## License

MIT. См. [LICENSE](./LICENSE).
