<!-- ## Opus Pack rules START -->

## Opus Pack rules

### Style
- Отвечай на русском, с матом. Коммиты на английском без `Co-Authored-By` / `Generated with Claude Code`.
- Granular commits — каждый логический кусок отдельно.
- Edit > Write. Не пиши новые файлы, если можно править существующие.

### Discipline
- **Verify before claim.** Запусти команду, прочти результат, потом утверждай. "Should work" — не утверждение, а догадка.
- **Root cause before fix.** Не глуши обходом. Если симптом непонятен — задействуй `systematic-debugging` skill.
- Не пиши комментарии "что код делает". Только WHY для неочевидных мест: hidden constraints, workarounds, surprising invariants.
- Никогда `git commit --no-verify`, `git push --force` на main/master, `rm -rf` без явной просьбы.

### Memory (claude-total-memory через MCP)
- В начале сессии вызывай `ctm_memory_recall` по cwd / git-branch — подтянет накопленные lessons по проекту.
- Сохраняй durable lessons через `ctm_memory_save`: правила, неочевидные решения, причины архитектурных выборов. **Не** сохраняй эфемерное (текущий task, in-progress state).
- Если задача типовая — `ctm_memory_associate` для связывания записей в граф.

### Plan Mode
- `/plan` или `Ctrl+Alt+P` — read-only exploration. Модель создаёт numbered plan, пользователь подтверждает execution.
- `[DONE:N]` маркеры для tracking прогресса при execution.
- Не пытайся менять код в plan mode — только анализ и планирование.

### Tasks (todo discipline)
- Для multi-step задач (3+ шагов) — сначала `todo add` на каждый шаг, потом `todo start <id>` → работа → `todo done <id>`.
- **Только одна задача в `in_progress` за раз.** При `todo start` предыдущая активная автоматически возвращается в `pending`.
- Не используй todo для trivial задач (одна правка, один файл).

### Long-running tasks
- **One-shot (build/test/migration)** — `Agent(subagent_type: "verify", task: "run X, report pass/fail")`. Sonnet, возвращает структурированный результат.
- **Watch / dev-server** — pi-native detach:
  ```
  cmd > /tmp/pi-bg-<slug>.log 2>&1 & echo $! > /tmp/pi-bg-<slug>.pid
  ```
  Следи через `log_tail("/tmp/pi-bg-<slug>.log", from=<offset>)` (инкремент по offset). Убивай через `log_kill(pid=<N>)`. Статус-бар показывает `bg:N` активных.
- **Blocking bash** — default. Не делай `&` без pidfile — потеряешь control.
- `/bg` — пикер живых задач: tail лога, kill, cleanup мёртвых pidfile'ов.

### Skills
- Каталог скиллов инжектится в system prompt автоматически (pi-native `<available_skills>`). Подхватывает `~/.claude/skills/*` тоже.
- Когда description скилла совпадает с задачей — `read(<location>)` body ДО действия. Не угадывай содержимое скилла.

### Plan Mode → Execute
- `exit_plan_mode(plan)` tool — когда план готов: передай финальный numbered list, pi спросит подтверждение и переключит на execution.
- `[DONE:n]` маркеры для tracking в execution mode остаются работающими (backward-compat).

### Compact focus
- Built-in pi `/compact [focus]` — inline focus пишется в `customInstructions`. Наш smart-compact extension мерджит его с configured hints (`.pi/compact-hints.md` / `opus-pack.compactHints`).

### Model router
- Если в settings включён `modelRouter` — первая строка промпта матчится rules, и turn идёт на указанной модели + thinking level.
- `/router <level>` — override на один turn. `/router status` — last 5 decisions + current config. `/router off` / `/router on` — toggle в сессии.
- Провайдер-агностик: работает с Anthropic / Ollama / OpenAI / кастомными proxy.
- При ручном `/model` switch router автоматически pause до конца сессии — чтоб не перебивать явный выбор.

### Conventions (CLAUDE.md / AGENTS.md)
- `~/.claude/CLAUDE.md` — глобал. Project `./CLAUDE.md` / `./AGENTS.md` — локал, приоритетнее глобала.
- Upward walk от cwd до HOME — все найденные файлы мерджатся (ближайшие к cwd = последние = highest priority).
- `/claude-md` — проверить что подхватилось.
- Cap `maxTotalChars` в settings (default 20000) — чтоб не раздуть system prompt.

### Session navigation
- Используй built-in pi `/resume`, `/fork`, `/tree` — они уже реализованы в pi-core.

### ask_user tool
- Используй `ask_user({question, choices?})` ТОЛЬКО когда требования реально неоднозначны и нельзя сделать reasonable assumption.
- Предпочитай `choices` (2-4 опции) над free-form.
- В non-interactive режиме (pi -p) tool возвращает error — fallback на best judgement.
- НЕ используй для подтверждения уже согласованного плана.

### Permissions (interactive)
- При `permissions.interactive: true` — на `confirm` action показывается 4-way picker: allow once / allow session / allow always / deny.
- "Allow always" сохраняет rule в `~/.pi/agent/settings.local.json` — следующий раз тот же паттерн пройдёт автоматом.
- Session-scoped allow ̆исчезает при рестарте pi.

### Extension discovery
- `/pi-search [query]` — ищет community extensions по GitHub topic `pi-package` (sort by stars). Picker → install + reload.
- GITHUB_TOKEN env опционально, без него 60 rpm unauth.
- Перед install — warn если stars <3 или last update >2 лет назад.

### Notifications
- Desktop notification приходит автоматически по завершении долгих задач (>10s). Не проси пользователя проверить — он сам увидит.

### Tooling
- `make lint && make test` перед коммитом в Go-проектах. Чинить замечания, не пропускать.
- Для значимых архитектурных решений / выбора технологии / крупного рефакторинга / расследования инцидента — предложи зафиксировать через `/opponent:log` или `/opponent:adr` (если работаем не в opponent).

### Thinking effort presets
- `low` — typo, форматирование
- `medium` — single-file feature, debugging известной поверхности
- `high` — cross-file refactor, design questions, неочевидный bug
- `xhigh` — архитектура, ambiguous specs, root-cause hunts

### Subagents (через registered Agent tool)
- `explore` — поиск паттернов / "find X" в больших codebases. Возвращает one-paragraph summary, не реализует.
- `verify` — запуск тестов / lint / build. Возвращает pass/fail + relevant output.
- `general-purpose` — задачи, которые не вписываются в первые два. 20-turn cap.

Используй subagent когда side-context реально нужен (>5 файлов поискать, или изолировать verification от основного потока). Для мелких справок — inline дешевле.

<!-- ## Opus Pack rules END -->
