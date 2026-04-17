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
