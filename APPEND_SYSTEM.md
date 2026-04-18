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
- `/compact <focus>` — inline focus перебивает `.pi/compact-hints.md`. Пример: `/compact preserve auth migration context`.

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
