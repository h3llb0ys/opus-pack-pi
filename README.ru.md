# opus-pack-pi

Провайдер-нейтральный bundle расширений для [pi-coding-agent](https://github.com/badlogic/pi-mono). Добавляет Claude-Code паритет (plan mode, todo, permissions, CC-style hooks, skill discovery), curates набор community-пакетов для subagents, code quality, editing и context management, и связывает всё через один идемпотентный installer.

> Работает с Anthropic, OpenAI, Ollama, local `llama.cpp`, custom-прокси. Смена провайдера — правка одного alias map'а.

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

Полный reference: [**extensions/README.md**](./extensions/README.md) (на английском — держится рядом с кодом). Ниже summary, сгруппированный как в `/opus-pack`:

| Категория | Расширения |
|---|---|
| **Safety** | `safe-deny`, `permissions`, `dirty-repo-guard`, `iteration-guard` |
| **Tasks & routing** | `plan-mode`, `todo`, `model-router` |
| **UI & reporting** | `status`, `bash-progress`, `mcp-compress`, `desktop-notify`, `session-summary`, `list-resources` |
| **Integrations** | `cc-bridge/` (skills, commands, claude-md, hooks), `smart-compact`, `log-tail`, `pi-search`, `deferred-tools` |
| **Dev loop** | `diff` |
| **Meta** | `opus-pack-config` |

Highlights:

- **`cc-bridge/`** — одно расширение с четырьмя sub-модулями (skills / commands / claude-md / hooks), bridge'ит cross-vendor config-деревья (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.pi` + то же на project scope). Hooks поддерживают Claude Code `hooks` блок в `settings.json` и file-based хуки под `<vendor>/hooks/*.md|*.sh`. Всё под одним `/cc-bridge [status|reload|help]` slash.
- **`safe-deny`** — non-interactive guardrail против деструктивного bash (argv-aware, разворачивает sudo) и доступа к credentials (блочит read **и** write на `.env`, `*.pem`, SSH keys, `~/.aws`, `~/.kube` и пр.). Bypass: `PI_OPUS_PACK_UNSAFE=1`.
- **`plan-mode`** — `/plan` + `Ctrl+Alt+P`, cross-session `/plan-resume`, `[DONE:N]` progress tracking, `--plan` флаг.
- **`model-router`** — heuristic auto-switch модели и thinking level с rate-limit downgrade на 429.
- **`opus-pack-config`** — `/opus-pack` modal и subcommands для toggle любого расширения на ходу.

### Community-пакеты, которые ставит `install.sh`

#### Subagents

- **[`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)** — subagent-оркестрация. Семь дефолтных агентов (`scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `delegate`), TUI на `Ctrl+Shift+A`, reusable `.chain.md` pipelines, git worktree isolation, fork / async режимы, fallback models, `SKILL.md` injection.

#### Editing & code quality

- **[`apmantza/pi-lens`](https://github.com/apmantza/pi-lens)** — прогоняет LSP (37 серверов), линтеры (Biome, Ruff, ESLint, stylelint, sqlfluff, RuboCop), 26+ форматтеров, tree-sitter rules, cyclomatic complexity и secrets scanner на каждый `write`/`edit`. Блочит write если не прошёл quality или secret check. `/lens-booboo` и `/lens-health`.
- **[`RimuruW/pi-hashline-edit`](https://github.com/RimuruW/pi-hashline-edit)** — hash-anchored `read` / `grep` / `edit`. Каждая строка от `read` несёт `LINE#HASH` префикс; `edit` обращается к anchor'ам вместо raw text, stale context падает громко, ambiguous match не ломает файл молча.

#### Checkpoints & context

- **[`arpagon/pi-rewind`](https://github.com/arpagon/pi-rewind)** — per-turn git-ref checkpoints с conversation rollback, diff preview, redo stack, branch safety и refuse-list который не даёт restore'у снести `node_modules` / `.venv`. `/rewind` + `Esc+Esc`.
- **[`ttttmr/pi-context`](https://github.com/ttttmr/pi-context)** — agentic context management. `/context` dashboard + `context_tag`, `context_log`, `context_checkout` (milestone'ы, move HEAD, сжатие завершённых задач в summary без полного `/compact`).

#### User interaction

- **[`edlsh/pi-ask-user`](https://github.com/edlsh/pi-ask-user)** — `ask_user` tool с searchable options, multi-select, freeform input, overlay mode и bundled decision-gating skill.
- **[`Kmiyh/pi-skills-menu`](https://github.com/Kmiyh/pi-skills-menu)** — `/skills` интерактивное меню: search, preview, insert, AI-assisted create, edit, rename, delete, enable/disable.
- **[`dbachelder/pi-btw`](https://github.com/dbachelder/pi-btw)** — `/btw` параллельная side-conversation sub-сессия. Clarifying вопрос или tangent без derailing главного turn'а; `/btw:inject` возвращает результат. `Alt+/` переключает фокус.

#### Security

Три слоя накладываются друг на друга, каждый на своём tool event:

| Слой | Вектор | Событие |
|---|---|---|
| `safe-deny` (своё) | path-based (`.env`, `*.pem`, `~/.ssh` …) на read + write | `read` / `write` / `edit` / `grep` |
| `pi-lens` | content-scan на write | `write` / `edit` |
| `pi-secret-guard` | content-scan git diff | `bash` `git commit` / `git push` |

- **[`acarerdinc/pi-secret-guard`](https://github.com/acarerdinc/pi-secret-guard)** — сканит diff'ы `git commit` / `git push` на 30+ secret patterns (AWS, Azure, GCP, GitHub токены, JWT, private keys, `password=` / `api_key=` assignments) с hard-block + agent-review для подозрительных.

#### Performance & providers

- **[`yvgude/lean-ctx`](https://github.com/yvgude/lean-ctx)** — standalone Rust binary, ставится через `brew` → `cargo` → `curl` fallback. Жмёт shell и file-read вывод через 90+ CLI patterns, 8 file-read modes, tree-sitter на 18 языков. ~90% экономии токенов на dev-операциях. Skip через `OPUS_PACK_SKIP_LEAN_CTX=1`.
- **[`shaftoe/pi-zai-usage`](https://github.com/shaftoe/pi-zai-usage)** — footer indicator для Z.ai subscription quota. Активен только при `glm-*` моделях, иначе молчит.
- **[`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)** — двусторонний bridge к Claude Code (Pro/Max подписка). Регистрирует `opus` / `sonnet` / `haiku` как провайдеры через `/model`, `AskClaude` tool для делегации, forwarding skills + MCP tools, streaming с thinking. **Anthropic-only, opt-in через `ANTHROPIC=1 ./install.sh`.**

#### Skills, MCP и мелочь

- **[`obra/superpowers`](https://github.com/obra/superpowers)** — 14 skills: systematic-debugging, brainstorming, writing-plans, TDD, code-review, git-worktrees и другие. Грузится только `skills/`; CC-only `commands/` / `agents/` / `hooks/` отфильтрованы.
- **[`viartemev/pi-rtk-rewrite`](https://github.com/viartemev/pi-rtk-rewrite)** — переписывает bash-команды через `rtk` (60–90% token savings на common командах).
- **[`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter)** — MCP bridge в Claude Code формате, proxy-tool ~200 токенов, lazy lifecycle, `idleTimeout`.
- **[`tmustier/pi-extensions`](https://github.com/tmustier/pi-extensions)** — `/usage` dashboard, `/readfiles` file browser, tab-status, ralph-wiggum (long tasks), agent-guidance (Claude / Codex / Gemini switching).
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

Свои хуки просто дописывай в массивы `hooks` в формате Claude Code; `cc-bridge.hooks` подхватит через `/reload` без рестарта. Для file-based hooks кидай `*.md` или `*.sh` в `~/.pi/agent/hooks/` или `<cwd>/.pi/hooks/` с frontmatter `event:` и опциональным `matcher:`.

### Как выключить расширение

Либо фильтр в `settings.json`:

```json
{
  "packages": [{
    "source": "/path/to/opus-pack-pi",
    "extensions": ["extensions/*.ts", "!extensions/diff.ts"]
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
