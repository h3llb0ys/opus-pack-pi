# opus-pack-pi

Opinionated, провайдер-нейтральный bundle расширений для [pi-coding-agent](https://github.com/badlogic/pi-mono). Приносит Claude-Code паритет (plan mode, todo, permissions, CC-style hooks, skill discovery), интегрирует отобранные community-пакеты и не мешает работать.

> Провайдер-нейтрален по дизайну. Работает с Anthropic, OpenAI, Ollama, local `llama.cpp`, custom-прокси. Смена провайдера — правка одного alias map'а.

[English version](./README.md)

---

## Что получаешь

- **24 своих расширения** — plan mode, tasks, permissions, routing, safety, git, CLAUDE.md discovery, Claude-Code-style hooks и другое.
- **17 community-пакетов** ставятся автоматически: subagent-оркестрация, real-time quality pipeline, hash-anchored edits, agentic context management, параллельные side-conversations, secret scanning и полезные мелочи.
- **`lean-ctx`** ставится рядом как standalone Rust binary — ~90% экономии токенов на shell и file-read выводе.
- **Два chain-совместимых agent-профиля** (`explore`, `verify`), встраивающиеся в `pi-subagents` pipelines.
- **`/opus-pack`** modal (`Ctrl+Alt+O`) — toggle любого расширения pack'а без рестарта pi.
- **Safe-by-default `safe-deny`** блочит деструктивные bash-команды и утечки credentials на read/write.

---

## Установка

### Локально (dev)

```sh
git clone https://github.com/h3llb0ys/opus-pack-pi
cd opus-pack-pi
./install.sh
```

### С GitHub (на любой машине)

```sh
# Выбери тег: https://github.com/h3llb0ys/opus-pack-pi/tags
pi install git:github.com/h3llb0ys/opus-pack-pi@<tag>
bash "$(pi list | grep opus-pack-pi | awk '{print $NF}')/install.sh"
```

Opt-in для Anthropic-пользователей (добавит Claude Code bridge):

```sh
ANTHROPIC=1 ./install.sh
```

Installer идемпотентный. Повторный запуск печатает `[skip]` для уже установленного. Пользовательские правки в `settings.json` переживают обновления — merge через `jq` deep-merge.

### Требования

- [pi](https://pi.dev)
- `jq` (`brew install jq` / `apt install jq`)
- Node.js ≥ 18

---

## Архитектура

Pack состоит из трёх слоёв:

| Слой | Источник | Кол-во |
|---|---|---|
| Свои расширения | `extensions/*.ts` в этом репо | 24 |
| Community-расширения | ставятся через `pi install <pkg>` | 17 + 1 opt-in |
| Agent-профили | `agents/*.md` копируются в `~/.pi/agent/agents/` | 2 |

Расширения грузятся через pi native plugin loader. Community-пакеты подтягиваются через `install.sh`, привязаны по коммиту и регистрируются в pi. Agent-профили подхватываются установленным `pi-subagents`.

---

## Что внутри

### Свои расширения

Группировка как в `/opus-pack`.

#### Safety

| Расширение | Что делает |
|---|---|
| `safe-deny` | Без интерактивных confirm блочит деструктив. Bash argv-parser (разворачивает `sudo`) ловит `rm -rf /|~`, `git push --force` на main/master, `--no-verify` commits, `chmod -R 777`, `chown -R`, `dd if=/of=`, `mkfs.*`, fork bombs, `curl\|sh`. Path-rules блочат **write** на `.env`, `*.pem`, `*.key`, SSH-ключи, `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.openai`, `~/.anthropic`, `~/.{claude,codex,gemini}`. **Read** также блочится на credentials-подмножестве (защита от утечки в prompt). Bypass: `PI_OPUS_PACK_UNSAFE=1`. |
| `permissions` | Granular allow / confirm / deny per tool, path, bash-pattern. 4-way prompt (once / session / always / deny) с line-diff preview для `write` и приблизительными номерами строк для `edit`. Конфиг в `opus-pack.permissions`. |
| `dirty-repo-guard` | Warn при старте сессии на грязном working tree. |
| `iteration-guard` | Лимит turns на agent-run (default 40, настраивается). `/continue` продлевает. Поддерживает `--max-turns=<N>` и env `PI_MAX_TURNS`. |

#### Tasks & routing

| Расширение | Что делает |
|---|---|
| `plan-mode` | `/plan` + `Ctrl+Alt+P`. Read-only режим с numbered plan. Агент вызывает `exit_plan_mode(plan, save?)` → confirm dialog → execute с `[DONE:N]` tracking. `/plan-resume` грузит сохранённый план cross-session. `/plan-close` — manual escape hatch. Флаг `--plan` стартует в plan mode. |
| `todo` | `todo` tool (`add`/`start`/`done`/`clear`) + `/todo` command. Task list с single-active инвариантом (как CC TodoWrite). Widget + footer badge. |
| `model-router` | Heuristic auto-switch модели и thinking level по промпту. `/router <level>`, `/router status`, `/router off`. Распознаёт rate-limit headers Anthropic/OpenAI для graceful downgrade. Status slot: `↗ model·level`. |

#### UI & reporting

| Расширение | Что делает |
|---|---|
| `status` | `/status` печатает сводку (extensions, skills, prompts, MCP tools, model, ctx usage). Live statusline: `cwd · branch · model · ctx:X%`. Footer: `ext:N skills:M mcp:K`. Опциональный `opus-pack.statusLine.command` — user shell-команда, stdout которой идёт в footer. |
| `bash-progress` | Live widget с tail + elapsed counter для долгих bash-команд (>2s). Сам tool не меняет. |
| `mcp-compress` | Схлопывает verbose MCP tool results в 1-строчные summaries (`ok memory_save: saved, id=208, deduped`). Распознаёт `saved` / `id` / `deduplicated` / `episode_id` / `count` / `error`. Конфиг в `opus-pack.mcpCompress`. |
| `desktop-notify` | OS notification (macOS/Linux) по завершении агента. Настройка порога + звук. `/notify-test`. |
| `session-summary` | Авто-резюме при завершении agent'а (≥ 3 tool calls): сколько файлов изменено, команд выполнено, ошибок. |
| `cost` | `/cost` — dashboard token usage: текущая сессия, сегодня, 7 дней с breakdown по дням. Показывает `—` если цена неизвестна (не-Anthropic провайдеры). |
| `list-resources` | `/extensions` (+ health dashboard pack'а), `/prompts`. `/skills` делегирован в установленный `pi-skills-menu`. |

#### Integrations

| Расширение | Что делает |
|---|---|
| `skills` | Регистрирует `~/.{claude,codex,gemini,pi}/skills` как skill roots — cross-vendor CC-style скиллы появляются в pi `<available_skills>`. |
| `hook-bridge` | Читает блок `hooks` из `settings.json` в формате Claude Code, запускает shell-команды на pi-события (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `PreCompact`). Копипасть CC-конфиги как есть. |
| `pi-search` | `/pi-search [query]` — discovery по GitHub topic `pi-package` + interactive install + `/reload`. Cache 1h. |
| `claude-md-loader` | Автоподхват `~/.{claude,codex,gemini,pi}/CLAUDE.md` + upward walk `CLAUDE.md` / `AGENTS.md` с cwd в system prompt. `/claude-md` показывает что загрузилось. Mtime-cached. |
| `smart-compact` | Мерджит `.pi/compact-hints.md` или `opus-pack.compactHints` с inline focus от built-in `/compact [focus]`. Сохраняет ключевой контекст при compact. |
| `log-tail` | `log_tail` / `log_kill` / `log_ps` tools + `/bg` picker. Pi-native long-running tasks: модель detach'ит bash в `/tmp/pi-bg-<slug>.{log,pid}`, расширение читает/убивает. `watch: true` пушит новые строки на каждый turn. Footer: `bg:N`. |
| `edit-log` | `/edit-log` — on-demand история edit/write операций за сессию. Ничего не инжектит в system prompt, только по запросу. |
| `file-commands` | Грузит `*.md` slash-команды с YAML frontmatter из `~/.{claude,pi}/commands` и `<cwd>/.{claude,pi}/commands`. Поддиректории становятся `plugin:name` namespaces. Подстановка `$ARGS` / `$1..$9`. CC-формат команд работает без изменений. |
| `deferred-tools` | Feature-flagged (`opus-pack.deferredTools.enabled`). Прунит активный tool list на каждый turn, прячет MCP tools за `tool_search` / `tool_load` прокси. Экономит prompt-токены когда MCP большой. |

#### Dev loop

| Расширение | Что делает |
|---|---|
| `diff` | `/diff` — обзор изменений агента: `git diff HEAD --stat` + интерактивный пикер файла с полным diff. |
| `auto-commit-on-exit` | Snapshot commit при выходе из pi. |

#### Meta

| Расширение | Что делает |
|---|---|
| `opus-pack-config` | `/opus-pack` + `Ctrl+Alt+O` — пикер on/off любого расширения pack'а. Subcommands для scripting: `status`, `list [cat]`, `on <name>`, `off <name> [--force]`, `reset`, `help`. Persist в `settings.local.json`. Footer slot: `off:N` когда что-то выключено. |

### Community-пакеты, которые ставит `install.sh`

#### Core replacements (заменили то, что мы писали сами, или закрыли явную дыру)

- **[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)** — subagent-оркестрация. 7 дефолтных агентов (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`), TUI на `Ctrl+Shift+A`, reusable `.chain.md` pipelines, git worktree isolation, fork / async modes, fallback models, `SKILL.md` injection. Заменил наш самописный subagent.
- **[`apmantza/pi-lens`](https://github.com/apmantza/pi-lens)** — real-time quality pipeline на каждый write/edit: LSP (37 серверов), линтеры (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop), 26+ форматтеров, tree-sitter rules, cyclomatic complexity, secrets scanning с блоком write. `/lens-booboo` и `/lens-health`.
- **[`RimuruW/pi-hashline-edit`](https://github.com/RimuruW/pi-hashline-edit)** — перехват `read` / `grep` / `edit` с hash-anchored line references (`LINE#HASH`). Убивает класс багов вида "string not found" / ambiguous match. Портирован из oh-my-pi.
- **[`arpagon/pi-rewind`](https://github.com/arpagon/pi-rewind)** — per-turn git-ref checkpoints с conversation rollback, diff preview, redo stack, branch safety, safe-restore. `/rewind` + `Esc+Esc`. Заменил наши `rewind` и `git-checkpoint`.
- **[`ttttmr/pi-context`](https://github.com/ttttmr/pi-context)** — agentic context management. `/context` dashboard + `context_tag`, `context_log`, `context_checkout` (milestone'ы, move HEAD, сжатие завершённых задач в summary без полного `/compact`).
- **[`Kmiyh/pi-skills-menu`](https://github.com/Kmiyh/pi-skills-menu)** — `/skills` интерактивное меню: search, preview, insert, AI-assisted create, edit, rename, delete, toggle. Заменил нашу read-only `/skills` listing.
- **[`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw)** — `/btw` параллельная side-conversation sub-сессия. Clarifying вопрос или tangent без derailing главного агента; `/btw:inject` возвращает результат. `Alt+/` переключает фокус.
- **[`edlsh/pi-ask-user`](https://github.com/edlsh/pi-ask-user)** — богаче `ask_user` tool: searchable options, multi-select, freeform input, overlay mode, bundled decision-gating skill. Заменил baseline `ask-user.ts`.

#### Security (defense-in-depth вместе с `safe-deny` и `pi-lens`)

- **[`acarerdinc/pi-secret-guard`](https://github.com/acarerdinc/pi-secret-guard)** — сканит diff'ы `git commit` / `git push` на 30+ secret patterns (AWS, Azure, GCP, GitHub токены, JWT, private keys, `password=` / `api_key=` assignments) с hard-block + agent-review для подозрительных.

| Слой | Вектор | Событие |
|---|---|---|
| `safe-deny` | path-based (`.env`, `*.pem`, `~/.ssh` …) на read + write | read / write / edit / grep |
| `pi-lens` | content-scan на write | write / edit |
| `pi-secret-guard` | content-scan git diff | bash `git commit` / `git push` |

#### Performance & providers

- **[`yvgude/lean-ctx`](https://github.com/yvgude/lean-ctx)** — standalone Rust binary, ставится через `brew` → `cargo` → `curl` fallback. Жмёт shell и file-read вывод через 90+ CLI patterns, 8 file-read modes, tree-sitter на 18 языков. ~90% экономии токенов на dev-операциях. Skip через `OPUS_PACK_SKIP_LEAN_CTX=1`.
- **[`shaftoe/pi-zai-usage`](https://github.com/shaftoe/pi-zai-usage)** — footer indicator для Z.ai subscription quota. Авто-активация при `glm-*` моделях, иначе молчит.
- **[`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)** — полная двусторонняя интеграция с Claude Code (Pro/Max подписка). Регистрирует `opus` / `sonnet` / `haiku` как провайдеры через `/model`, `AskClaude` tool для делегации, forwarding skills + MCP tools, streaming с thinking. **Anthropic-only, opt-in через `ANTHROPIC=1 ./install.sh`.**

#### Long-standing extras

- **[`obra/superpowers`](https://github.com/obra/superpowers)** — 14 skills: systematic-debugging, brainstorming, writing-plans, TDD, code-review, git-worktrees и др. Грузится только `skills/`; CC-only `commands/` / `agents/` / `hooks/` отфильтрованы.
- **[`viartemev/pi-rtk-rewrite`](https://github.com/viartemev/pi-rtk-rewrite)** — авто-rtk rewrite на bash (60–90% token savings на common командах).
- **[`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)** — MCP bridge в Claude Code формате, proxy-tool ~200 токенов, lazy lifecycle, `idleTimeout`.
- **[`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions)** — `/usage` dashboard, `/readfiles` file browser, tab-status, ralph-wiggum (long tasks), agent-guidance (Claude / Codex / Gemini switching).
- **[`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)** — компактный рендеринг tool calls.
- **[`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access)** — web search + extraction.
- **[`viartemev/pi-working-message`](https://github.com/viartemev/pi-working-message)** — косметика, кастомные "working" фразы.

### Agent-профили

Два chain-совместимых профиля живут в `agents/` и копируются при install в `~/.pi/agent/agents/` (user-scope, override дефолтов `pi-subagents` с тем же именем):

- **`explore`** — медленный, тщательный, read-only. Пишет `context.md` для handoff. Counterpart к `scout` из `pi-subagents` (который быстрый и поверхностный).
- **`verify`** — быстрый, запускает tests / lint / build, отчёт `PASS` / `FAIL`. Аналога в `pi-subagents` нет.

Тир контролируется `alias:fast|balanced|slow` hint в frontmatter'е профиля; алиасы резолвятся через свой model-map `pi-subagents`. Настрой map один раз — все профили поедут на правильных моделях.

---

## Конфигурация

### Что `install.sh` трогает

- `~/.pi/agent/settings.json` — `jq` deep-merge. Обновляет только `hooks`, `opus-pack`, `packages`. Чужие ключи не трогает.
- `~/.pi/agent/mcp.json` — мерджит `mcpServers` блок из `mcp.json.example` (по дефолту пустой; добавляй свои серверы туда).
- `~/.pi/agent/APPEND_SYSTEM.md` — append-only с маркерами `<!-- Opus Pack rules START/END -->`. Повторный запуск не дублирует.
- `~/.pi/agent/agents/` — копирует `explore.md` и `verify.md` через `cp -n`. Твои правки reinstall не перетрёт.
- `pi install <pkg>` для каждого community-пакета.
- `pi install <REPO_DIR>` регистрирует локальный путь репо.
- `lean-ctx` — если не на `PATH`, пробует `brew` → `cargo` → `curl`. Skip через `OPUS_PACK_SKIP_LEAN_CTX=1`.

Больше ничего. В `~/.claude/` не лезет, глобальные shell-конфиги не трогает.

### Provider setup

1. Убедись, что `pi` знает твой провайдер (ключ в env-переменной или в `~/.pi/agent/auth.json`).
2. Настрой model aliases в `pi-subagents` settings block — конкретный формат см. в его README. Все bundled-профили (`scout`, `planner`, `worker`, `reviewer` + наши `explore` и `verify`) берут модель из этого map'а.
3. (Опционально) заполни `opus-pack.modelRouter.levels` для auto-switch модели по содержимому промпта. Провайдер-специфичные шаблоны — в `_levels_example_*` блоках `settings.json.example`.

### Блоки `settings.json` после install

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

Свои хуки просто дописывай в массивы `hooks` в формате Claude Code; `hook-bridge` подхватит через `/reload` без рестарта.

### Как выключить расширение

Либо фильтр в `settings.json`:

```json
{
  "packages": [{
    "source": "/path/to/opus-pack-pi",
    "extensions": ["extensions/*.ts", "!extensions/edit-log.ts"]
  }]
}
```

Либо `/opus-pack` modal — persist disabled list в `settings.local.json`.

---

## Troubleshooting

**`/status` падает.** Pi introspection API в некоторых билдах приватный. `status.ts` завёрнут в `try`/`catch`, показывает что смог.

**Hook не срабатывает.** Проверь, что `matcher` точно совпадает с именем tool'а (`bash`, не `Bash`). Stdout хука — валидный JSON; `{"block": true, "reason": "..."}` блочит вызов.

**`pi list` пуст после install.** Pi может требовать рестарт после первого `pi install`. Запусти `pi` один раз, убедись что extensions загрузились, повтори `install.sh` для merge settings.

**`safe-deny` блочит нужную команду.** Одноразовый bypass: `PI_OPUS_PACK_UNSAFE=1`. Постоянный — отредактируй правило и `/reload`.

**pi-lens блочит write как "secret".** Если false positive (placeholder, test fixture) — переименуй файл или поправь конфиг `pi-lens`; блок намеренный.

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

Снимает все pack'овые community-пакеты, чистит наши блоки в `settings.json`, вырезает `Opus Pack rules` из `APPEND_SYSTEM.md`. Делает `.bak` бэкап. Чужие настройки не трогает.

### Dev loop

Редактируй `extensions/*.ts` прямо в репо. Внутри pi — `/reload`, изменения применяются без рестарта. Pi ссылается на путь, файлы не копирует.

Релиз:

```sh
git tag vX.Y && git push origin main --tags
```

На других машинах: `pi install git:github.com/h3llb0ys/opus-pack-pi@vX.Y`.

---

## License

MIT. См. [LICENSE](./LICENSE).
