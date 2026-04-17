# Opus Pack Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 5 biggest UX gaps between opus-pack-pi and Claude Code: plan mode, granular permissions, task/todo tracking, smart compaction, and desktop notifications.

**Architecture:** Each improvement is an independent TypeScript extension in `extensions/`. Extensions use pi's `ExtensionAPI` (events, tools, commands, UI). All state persisted via `pi.appendEntry()` for crash/restart resilience. Config in `settings.json` under `opus-pack` key.

**Tech Stack:** TypeScript, pi Extension API (`@mariozechner/pi-coding-agent`), `@sinclair/typebox` for schemas, `@mariozechner/pi-ai` for `StringEnum`, `@mariozechner/pi-tui` for UI components.

---

## File Structure

| File | Responsibility |
|---|---|
| `extensions/plan-mode.ts` | Read-only exploration + plan/execute cycle |
| `extensions/permissions.ts` | Granular allow/deny rules per tool and path |
| `extensions/todo.ts` | Lightweight task tracker (model-facing tool + UI) |
| `extensions/smart-compact.ts` | Custom compaction with hint preservation |
| `extensions/desktop-notify.ts` | OS notification on agent completion |
| `APPEND_SYSTEM.md` | Updated rules for new extensions |

---

### Task 1: Plan Mode Extension

**Files:**
- Create: `extensions/plan-mode.ts`

- [ ] **Step 1: Write the plan-mode extension**

Create `extensions/plan-mode.ts` based on the pi example at `examples/extensions/plan-mode/`. Adapted for opus-pack conventions (same style as existing extensions: no fancy UI, functional, minimal).

Key design decisions vs the example:
- **No `questionnaire` tool** — pi doesn't ship it, we don't need it.
- **`PLAN_MODE_TOOLS`** = `["read", "bash", "grep", "find", "ls"]` — read-only builtins only.
- **State persisted** via `pi.appendEntry("plan-mode", { enabled, todos, executing })`.
- **`isSafeCommand`** inline (don't import from external — keep self-contained).
- **Widget** shows checklist during execution. Footer status shows `⏸ plan` or `📋 N/M`.
- **`/plan` command** toggles plan mode. **`Ctrl+Alt+P`** shortcut.
- **`--plan` flag** via `pi.registerFlag`.
- **`/todos` command** shows current plan progress.
- **Session restore** rebuilds state from `appendEntry` + re-scans messages for `[DONE:n]`.

```typescript
/**
 * Plan Mode — read-only exploration + plan/execute cycle.
 *
 * /plan or Ctrl+Alt+P toggles plan mode (read-only tools only).
 * Agent creates numbered plan under "Plan:" header.
 * User chooses "Execute" → full tools restored, progress tracked via [DONE:n].
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

const SAFE_PATTERNS = [
	/^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*grep\b/, /^\s*find\b/,
	/^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/, /^\s*wc\b/, /^\s*sort\b/,
	/^\s*diff\b/, /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*tree\b/,
	/^\s*which\b/, /^\s*env\b/, /^\s*uname\b/, /^\s*whoami\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i, /^\s*npm\s+(list|ls|view|outdated)/i,
	/^\s*jq\b/, /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/,
];

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
	/\bchmod\b/i, /\bchown\b/i, /(^|[^<])>(?!>)/, />>/,
	/\b(npm|yarn|pnpm|pip|brew|apt)\s+(install|add|remove|uninstall)/i,
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|stash)/i,
	/\bsudo\b/i, /\bkill\b/i, /\b(vim?|nano|emacs|code)\b/i,
];

interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

function isSafeCommand(cmd: string): boolean {
	return !DESTRUCTIVE_PATTERNS.some((p) => p.test(cmd)) && SAFE_PATTERNS.some((p) => p.test(cmd));
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(msg: AssistantMessage): string {
	return msg.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;
	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	for (const match of planSection.matchAll(/^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
		const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 5) {
			items.push({ step: items.length + 1, text: text.slice(0, 80), completed: false });
		}
	}
	return items;
}

function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const s = Number(match[1]);
		if (Number.isFinite(s)) steps.push(s);
	}
	return steps;
}

export default function (pi: ExtensionAPI) {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];

	pi.registerFlag("plan", { type: "boolean", description: "Start in plan mode", default: false });

	const updateStatus = (ctx: ExtensionContext) => {
		if (executionMode && todoItems.length > 0) {
			const done = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${done}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
		if (executionMode && todoItems.length > 0) {
			ctx.ui.setWidget("plan-todos", todoItems.map((t) =>
				t.completed
					? ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
					: ctx.ui.theme.fg("muted", "☐ ") + t.text,
			));
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	};

	const persist = () => {
		pi.appendEntry("plan-mode", { enabled: planModeEnabled, todos: todoItems, executing: executionMode });
	};

	const togglePlanMode = (ctx: ExtensionContext) => {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];
		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode ON. Tools: ${PLAN_MODE_TOOLS.join(", ")}`, "info");
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode OFF. Full access.", "info");
		}
		updateStatus(ctx);
	};

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan progress",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Use /plan first.", "info");
				return;
			}
			ctx.ui.notify(todoItems.map((t, i) => `${i + 1}. ${t.completed ? "✓" : "○"} ${t.text}`).join("\n"), "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;
		const cmd = String((event.input as { command?: string }).command ?? "");
		if (!isSafeCommand(cmd)) {
			return { block: true, reason: `plan-mode: blocked (not allowlisted). Use /plan to disable.\nCommand: ${cmd}` };
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return msg.customType !== "plan-mode-context";
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
Read-only exploration. Tools: read, bash, grep, find, ls. No edit/write.
Create a numbered plan under a "Plan:" header. Do NOT make changes.`,
					display: false,
				},
			};
		}
		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN]\nRemaining:\n${remaining.map((t) => `${t.step}. ${t.text}`).join("\n")}\nInclude [DONE:n] after each step.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		const doneSteps = extractDoneSteps(getTextContent(event.message));
		for (const s of doneSteps) {
			const item = todoItems.find((t) => t.step === s);
			if (item) item.completed = true;
		}
		updateStatus(ctx);
		persist();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan complete!** ✓ All ${todoItems.length} steps done.`, display: true },
					{ triggerTurn: false },
				);
				executionMode = false;
				todoItems = [];
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
				persist();
			}
			return;
		}
		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) todoItems = extracted;
		}

		if (todoItems.length > 0) {
			pi.sendMessage(
				{ customType: "plan-todo-list", content: `**Plan (${todoItems.length} steps):**\n${todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n")}`, display: true },
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode — what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "Execute the plan") {
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: `Execute the plan. Start with: ${todoItems[0]?.text ?? "the plan you created."}`, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine:", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) planModeEnabled = true;

		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled?: boolean; todos?: TodoItem[]; executing?: boolean } } | undefined;

		if (last?.data) {
			planModeEnabled = last.data.enabled ?? planModeEnabled;
			todoItems = last.data.todos ?? todoItems;
			executionMode = last.data.executing ?? executionMode;
		}

		if (planModeEnabled) pi.setActiveTools(PLAN_MODE_TOOLS);
		updateStatus(ctx);
	});
}
```

- [ ] **Step 2: Commit plan-mode extension**

```bash
git add extensions/plan-mode.ts
git commit -m "feat: add plan-mode extension (read-only exploration + execute cycle)"
```

---

### Task 2: Granular Permissions Extension

**Files:**
- Create: `extensions/permissions.ts`

- [ ] **Step 1: Write the permissions extension**

Config in `settings.json` under `opus-pack.permissions`:

```json
{
  "opus-pack": {
    "permissions": {
      "default": "confirm",
      "rules": [
        { "tool": "edit", "path": "src/**", "action": "allow" },
        { "tool": "edit", "path": ".github/**", "action": "confirm" },
        { "tool": "bash", "pattern": "sudo *", "action": "confirm" },
        { "tool": "write", "path": "*.env", "action": "deny" }
      ]
    }
  }
}
```

Actions: `allow` (silent pass), `confirm` (popup), `deny` (block). First match wins. `default` is the fallback action.

The extension reads config at session start from `settings.json`. On each `tool_call`, it matches the tool name + path/pattern against rules. If `confirm` — shows `ctx.ui.confirm()`. If `deny` — blocks with reason. If `allow` or no match — passes through.

This **augments** `safe-deny.ts` — both can coexist. `safe-deny` is the hardcoded safety net, `permissions.ts` is the user-configurable layer.

```typescript
/**
 * Permissions — granular allow/deny/confirm per tool and path.
 *
 * Config in settings.json under opus-pack.permissions:
 *   { default: "confirm"|"allow"|"deny", rules: [{ tool, path?, pattern?, action }] }
 * First match wins. Safe-deny.ts still runs as hardcoded safety net.
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { minimatch } from "minimatch";

type Action = "allow" | "confirm" | "deny";

interface Rule {
	tool: string;
	path?: string;
	pattern?: string;
	action: Action;
}

interface PermissionsConfig {
	default: Action;
	rules: Rule[];
}

const loadConfig = (cwd: string): PermissionsConfig | null => {
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		return parsed?.["opus-pack"]?.["permissions"] ?? null;
	} catch {
		return null;
	}
};

const matchRule = (rule: Rule, toolName: string, toolInput: Record<string, unknown>, cwd: string): boolean => {
	if (rule.tool !== "*" && rule.tool !== toolName) return false;

	if (rule.path) {
		const rawPath = String(toolInput["path"] ?? toolInput["file_path"] ?? toolInput["command"] ?? "");
		if (!rawPath) return false;
		const abs = rawPath.startsWith("/") ? rawPath : resolve(cwd, rawPath);
		// minimatch on the relative path from cwd
		const rel = abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
		if (!minimatch(rel, rule.path)) return false;
	}

	if (rule.pattern) {
		const cmd = String(toolInput["command"] ?? "");
		try {
			if (!new RegExp(rule.pattern).test(cmd)) return false;
		} catch {
			return false;
		}
	}

	return true;
};

export default function (pi: ExtensionAPI) {
	let config: PermissionsConfig | null = null;

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
	});

	pi.registerCommand("permissions", {
		description: "Show current permission rules",
		handler: async (_args, ctx) => {
			if (!config) {
				ctx.ui.notify("No permission rules configured. Add opus-pack.permissions to settings.json.", "info");
				return;
			}
			const lines = [
				`Default: ${config.default}`,
				...config.rules.map((r, i) => {
					const target = r.path ? `path:${r.path}` : r.pattern ? `pattern:${r.pattern}` : "*";
					return `${i + 1}. ${r.tool} ${target} → ${r.action}`;
				}),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config) return;
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;

		const input = event.input as Record<string, unknown>;
		let action: Action = config.default;

		for (const rule of config.rules) {
			if (matchRule(rule, event.toolName, input, ctx.cwd)) {
				action = rule.action;
				break;
			}
		}

		if (action === "allow") return;
		if (action === "deny") {
			return { block: true, reason: `permissions: ${event.toolName} denied by rule.` };
		}
		if (action === "confirm") {
			if (!ctx.hasUI) return; // no UI in print/json mode — allow silently
			const cmd = event.toolName === "bash"
				? String(input["command"] ?? "")
				: String(input["path"] ?? input["file_path"] ?? "");
			const ok = await ctx.ui.confirm(
				`Allow ${event.toolName}?`,
				cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd,
				{ timeout: 15000 },
			);
			if (!ok) return { block: true, reason: `permissions: user denied ${event.toolName}.` };
		}
	});
}
```

- [ ] **Step 2: Install minimatch dependency**

```bash
cd ~/extra/opus-pack-pi && npm install minimatch
```

- [ ] **Step 3: Commit permissions extension**

```bash
git add extensions/permissions.ts package.json package-lock.json
git commit -m "feat: add granular permissions extension (allow/confirm/deny per tool+path)"
```

---

### Task 3: Todo Tracker Extension (with enforcement)

**Files:**
- Create: `extensions/todo.ts`

- [ ] **Step 1: Write the todo tracker extension with enforcement**

Registers a `todo` tool the LLM can call, plus `/todo` command for user. Widget shows checklist with `☐/☑` and strikethrough.

**Enforcement mechanism (option A):**
1. **`before_agent_start`** — injects a system-level message instructing the model to ALWAYS plan with `todo add` before modifying files.
2. **`tool_call` nag** — on the first `edit`/`write`/`bash` (if it looks modifying) in an agent run where `todo add` was never called, injects a steering message: "Сначала создай план через todo add, потом выполняй". Only nags once per agent run.
3. **`todo add` auto-complete hint** — when model calls `todo complete`, auto-advance widget to next pending item.

```typescript
/**
 * Todo Tracker — lightweight task list for multi-step agent work.
 *
 * Tool `todo` (add/list/complete/clear) for the LLM.
 * Command /todo for user inspection.
 * Widget shows active tasks above editor.
 * State persists via appendEntry for crash resilience.
 *
 * Enforcement: before_agent_start injects "plan first" instruction.
 * First modifying tool_call without prior todo add → steering nag.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface TodoEntry {
	id: string;
	text: string;
	done: boolean;
}

const renderWidget = (ctx: ExtensionContext, items: TodoEntry[]) => {
	if (items.length === 0) {
		ctx.ui.setWidget("todo", undefined);
		ctx.ui.setStatus("todo", undefined);
		return;
	}
	const done = items.filter((t) => t.done).length;
	ctx.ui.setStatus("todo", ctx.ui.theme.fg("accent", `☑ ${done}/${items.length}`));
	ctx.ui.setWidget("todo", items.map((t) =>
		t.done
			? ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
			: ctx.ui.theme.fg("dim", "☐ ") + t.text,
	));
};

const MODIFYING_TOOLS = new Set(["edit", "write"]);

const MODIFYING_BASH_PATTERNS = [
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|stash|cherry-pick|revert)/i,
	/\brm\s/i, /\bmv\s/i, /\bcp\s/i, /\bmkdir\s/i,
	/\b(npm|yarn|pnpm|pip|cargo|go|brew)\s+(install|add|remove|update)/i,
];

const isModifyingBash = (cmd: string): boolean =>
	MODIFYING_BASH_PATTERNS.some((p) => p.test(cmd));

export default function (pi: ExtensionAPI) {
	let items: TodoEntry[] = [];
	let nextId = 1;

	// Enforcement state per agent run
	let todoWasUsed = false;
	let hasNagged = false;

	const persist = () => pi.appendEntry("todo", { items, nextId });

	const resetEnforcement = () => {
		todoWasUsed = items.length > 0; // pre-existing todos count
		hasNagged = false;
	};

	pi.on("session_start", async (_event, ctx) => {
		items = [];
		nextId = 1;
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "todo")
			.pop() as { data?: { items?: TodoEntry[]; nextId?: number } } | undefined;
		if (last?.data) {
			items = last.data.items ?? [];
			nextId = last.data.nextId ?? items.length + 1;
		}
		renderWidget(ctx, items);
		resetEnforcement();
	});

	// Hard enforcement: inject "plan first" instruction at the start of every agent run
	pi.on("before_agent_start", async () => {
		return {
			message: {
				customType: "todo-enforcement",
				content: [
					"[TODO ENFORCEMENT]",
					"Before modifying ANY files, you MUST:",
					"1. Call `todo add` for each step of your plan (2+ steps)",
					"2. Then execute steps one by one, calling `todo complete` after each",
					"",
					"Exceptions (skip todo): single-file fix, typo correction, answering a question.",
					"For everything else: todo first, execute second.",
			].join("\n"),
				display: false,
			},
		};
	});

	// Nag on first modifying tool call without prior todo add
	pi.on("tool_call", async (event, ctx) => {
		if (hasNagged || todoWasUsed) return;

		// Track that todo was used (before the nag check)
		if (event.toolName === "todo") {
			todoWasUsed = true;
			return;
		}

		// Check if this is a modifying tool call
		let isModifying = MODIFYING_TOOLS.has(event.toolName);
		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			isModifying = isModifyingBash(cmd);
		}

		if (!isModifying) return;

		// First modifying call without todo — nag once
		hasNagged = true;
		pi.sendMessage(
			{
				customType: "todo-nag",
				content: "⚠️ Ты начал менять код без плана. Сначала вызови `todo add` для каждого шага, потом выполняй с `todo complete`.",
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage a lightweight task list. Use this to track multi-step work instead of keeping state in your head.",
		promptSnippet: "todo add/list/complete/clear — track multi-step task progress",
		promptGuidelines: [
			"Use the todo tool to plan multi-step work before starting.",
			"Mark tasks complete as you finish them.",
			"Clear completed tasks when starting fresh work.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "list", "complete", "clear"] as const),
			text: Type.Optional(Type.String({ description: "Task text (for add)" })),
			id: Type.Optional(Type.String({ description: "Task ID (for complete)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "add": {
					if (!params.text) throw new Error("todo add requires 'text'");
					const entry: TodoEntry = { id: String(nextId++), text: params.text, done: false };
					items.push(entry);
					persist();
					renderWidget(ctx, items);
					return { content: [{ type: "text", text: `Added todo #${entry.id}: ${entry.text}` }], details: { items } };
				}
				case "list": {
					const list = items.map((t) => `${t.done ? "✓" : "○"} #${t.id} ${t.text}`).join("\n");
					return { content: [{ type: "text", text: list || "(empty)" }], details: { items } };
				}
				case "complete": {
					if (!params.id) throw new Error("todo complete requires 'id'");
					const target = items.find((t) => t.id === params.id);
					if (!target) throw new Error(`todo #${params.id} not found`);
					target.done = true;
					persist();
					renderWidget(ctx, items);

					// Auto-advance: hint at next pending item
					const next = items.find((t) => !t.done);
					const suffix = next ? ` Next: #${next.id} — ${next.text}` : " All done!";
					return { content: [{ type: "text", text: `Completed #${target.id}: ${target.text}.${suffix}` }], details: { items } };
				}
				case "clear": {
					items = items.filter((t) => !t.done);
					persist();
					renderWidget(ctx, items);
					return { content: [{ type: "text", text: `Cleared done tasks. ${items.length} remaining.` }], details: { items } };
				}
			}
		},
	});

	pi.registerCommand("todo", {
		description: "Show current todo list",
		handler: async (_args, ctx) => {
			if (items.length === 0) {
				ctx.ui.notify("(no tasks)", "info");
				return;
			}
			ctx.ui.notify(items.map((t) => `${t.done ? "✓" : "○"} #${t.id} ${t.text}`).join("\n"), "info");
		},
	});
}
```

- [ ] **Step 2: Commit todo tracker with enforcement**

```bash
git add extensions/todo.ts
git commit -m "feat: add todo tracker with before_agent_start enforcement + steering nag"
```

---

### Task 4: Smart Compaction Extension

**Files:**
- Create: `extensions/smart-compact.ts`

- [ ] **Step 1: Write the smart compaction extension**

Hooks into `session_before_compact` to inject custom instructions. Reads `.pi/compact-hints.md` or `compact-hints` from `settings.json` under `opus-pack`. After compaction, emits a notification with token savings.

```typescript
/**
 * Smart Compact — custom compaction hints.
 *
 * Reads compact-hints from settings.json or .pi/compact-hints.md.
 * Injects them as custom instructions into the compaction prompt.
 * Shows token savings notification after compact.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const loadHints = (cwd: string): string | null => {
	// 1. Project-local .pi/compact-hints.md
	const localPath = join(cwd, ".pi/compact-hints.md");
	if (existsSync(localPath)) {
		try { return readFileSync(localPath, "utf8").trim(); } catch { /* ignore */ }
	}

	// 2. Global ~/.pi/agent/compact-hints.md
	const globalPath = join(homedir(), ".pi/agent/compact-hints.md");
	if (existsSync(globalPath)) {
		try { return readFileSync(globalPath, "utf8").trim(); } catch { /* ignore */ }
	}

	// 3. settings.json opus-pack.compactHints
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		const hints = parsed?.["opus-pack"]?.["compactHints"];
		if (typeof hints === "string" && hints.trim()) return hints.trim();
		if (Array.isArray(hints)) return hints.filter((h: unknown) => typeof h === "string").join("\n");
	} catch { /* ignore */ }

	return null;
};

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const hints = loadHints(ctx.cwd);
		if (!hints) return;

		// Merge hints into custom instructions
		const existing = event.customInstructions ?? "";
		const merged = existing
			? `${existing}\n\n---\nCOMPACT HINTS (preserve these topics):\n${hints}`
			: `COMPACT HINTS (preserve these topics in the summary):\n${hints}`;

		return { customInstructions: merged };
	});

	pi.on("session_compact", async (event, ctx) => {
		if (event.fromExtension) return;
		const compaction = event.compactionEntry;
		if (!compaction) return;

		const tokensBefore = compaction.tokensBefore ?? 0;
		const summaryLen = typeof compaction.summary === "string" ? compaction.summary.length : 0;
		ctx.ui.notify(
			`Compaction done: ${tokensBefore.toLocaleString()} tokens before, ~${summaryLen.toLocaleString()} chars summary.`,
			"info",
		);
	});
}
```

- [ ] **Step 2: Commit smart compact**

```bash
git add extensions/smart-compact.ts
git commit -m "feat: add smart-compact extension (custom compaction hints)"
```

---

### Task 5: Desktop Notification Extension

**Files:**
- Create: `extensions/desktop-notify.ts`

- [ ] **Step 1: Write the desktop notification extension**

Fires OS notification on `agent_end` (agent finishes work). Uses `osascript` on macOS, `notify-send` on Linux. Configurable: always-on, only on long tasks (>30s), or disabled. Config in `settings.json` under `opus-pack.desktopNotify`.

```typescript
/**
 * Desktop Notify — OS notification when agent finishes.
 *
 * macOS: osascript -e 'display notification ...'
 * Linux: notify-send (if available)
 *
 * Config in settings.json: opus-pack.desktopNotify
 *   { "enabled": true, "minDuration": 30, "sound": true }
 *
 * minDuration: only notify if agent ran for at least N seconds (default: 10).
 * sound: play system sound on macOS (default: true).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

interface NotifyConfig {
	enabled: boolean;
	minDuration: number;
	sound: boolean;
}

const DEFAULT_CONFIG: NotifyConfig = { enabled: true, minDuration: 10, sound: true };

const loadConfig = (): NotifyConfig => {
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		const cfg = parsed?.["opus-pack"]?.["desktopNotify"];
		if (!cfg || typeof cfg !== "object") return DEFAULT_CONFIG;
		return {
			enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
			minDuration: cfg.minDuration ?? DEFAULT_CONFIG.minDuration,
			sound: cfg.sound ?? DEFAULT_CONFIG.sound,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
};

const isMac = process.platform === "darwin";

const notifyMac = async (title: string, body: string, sound: boolean): Promise<void> => {
	const soundClause = sound ? ' sound name "Submarine"' : "";
	const escapedBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `display notification "${escapedBody}" with title "${escapedTitle}"${soundClause}`;
	try {
		await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
	} catch { /* ignore — osascript may fail in non-GUI contexts */ }
};

const notifyLinux = async (title: string, body: string): Promise<void> => {
	try {
		await execFileAsync("notify-send", [title, body], { timeout: 5000 });
	} catch { /* ignore — notify-send may not be installed */ }
};

export default function (pi: ExtensionAPI) {
	let agentStartTime = 0;
	const config = loadConfig();

	if (!config.enabled) return;

	pi.on("agent_start", async () => {
		agentStartTime = Date.now();
	});

	pi.on("agent_end", async (_event, ctx) => {
		const elapsed = (Date.now() - agentStartTime) / 1000;
		if (elapsed < config.minDuration) return;

		const cwd = ctx.cwd.split("/").pop() ?? "project";
		const title = "pi — task complete";
		const body = `${cwd} (${Math.round(elapsed)}s)`;

		if (isMac) {
			await notifyMac(title, body, config.sound);
		} else {
			await notifyLinux(title, body);
		}
	});

	pi.registerCommand("notify-test", {
		description: "Test desktop notification",
		handler: async (_args, ctx) => {
			if (isMac) {
				await notifyMac("pi test", "Notification works!", config.sound);
			} else {
				await notifyLinux("pi test", "Notification works!");
			}
			ctx.ui.notify("Notification sent.", "info");
		},
	});
}
```

- [ ] **Step 2: Commit desktop notification**

```bash
git add extensions/desktop-notify.ts
git commit -m "feat: add desktop-notify extension (OS notification on agent completion)"
```

---

### Task 6: Update APPEND_SYSTEM.md

**Files:**
- Modify: `APPEND_SYSTEM.md`

- [ ] **Step 1: Add rules for new extensions**

Add to the end of the `### Discipline` section, before `### Memory`:

```markdown
### Plan Mode
- `/plan` или `Ctrl+Alt+P` — read-only exploration. Модель создаёт numbered plan, пользователь подтверждает execution.
- `[DONE:N]` маркеры для tracking прогресса при execution.
- Не пытайся менять код в plan mode — только анализ и планирование.

### Tasks
- Для multi-step задач (3+ шагов) —先用 `todo add` создай план, потом выполняй пошагово с `todo complete`.
- Не используй todo для trivial задач (одна правка, один файл).

### Notifications
- Desktop notification приходит автоматически по завершении долгих задач (>10s). Не проси пользователя проверить — он сам увидит.
```

- [ ] **Step 2: Commit APPEND_SYSTEM.md update**

```bash
git add APPEND_SYSTEM.md
git commit -m "docs: update APPEND_SYSTEM.md with rules for new extensions"
```

---

### Task 7: Update settings.json.example and README

**Files:**
- Modify: `settings.json.example`
- Modify: `README.md`

- [ ] **Step 1: Update settings.json.example**

Add `permissions` and `desktopNotify` to the `opus-pack` block:

```json
{
  "opus-pack": {
    "max-turns": 40,
    "safe-deny": { "enabled": true },
    "permissions": {
      "default": "allow",
      "rules": [
        { "tool": "bash", "pattern": "sudo *", "action": "confirm" },
        { "tool": "edit", "path": ".github/**", "action": "confirm" },
        { "tool": "write", "path": "*.env", "action": "deny" }
      ]
    },
    "desktopNotify": {
      "enabled": true,
      "minDuration": 10,
      "sound": true
    }
  }
}
```

- [ ] **Step 2: Update README.md extensions table**

Replace the existing extensions table with one that includes all 5 new extensions:

| Extension | Что делает |
|---|---|
| `plan-mode.ts` | `/plan` + `Ctrl+Alt+P` — read-only exploration, numbered plan, execute with `[DONE:N]` tracking. `--plan` flag. |
| `permissions.ts` | Granular allow/confirm/deny per tool + path/pattern. Config in `opus-pack.permissions`. Augments safe-deny. |
| `todo.ts` | `todo` tool + `/todo` command — lightweight task list for multi-step agent work. Widget + status bar. |
| `smart-compact.ts` | Custom compaction hints from `.pi/compact-hints.md` or `opus-pack.compactHints`. Preserves key context. |
| `desktop-notify.ts` | OS notification (macOS/Linux) on agent completion. Configurable duration threshold + sound. `/notify-test`. |

Keep the existing entries (iteration-guard, safe-deny, status, list-resources, hook-bridge, vendored extensions).

- [ ] **Step 3: Commit docs update**

```bash
git add settings.json.example README.md
git commit -m "docs: update settings.json.example and README with new extensions"
```

---

### Task 8: Install Script Update

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Add minimatch dependency check**

`permissions.ts` needs `minimatch`. The `install.sh` must run `npm install` in the repo directory if `node_modules/minimatch` is missing.

Add after the existing `pi install` loop in `install.sh`:

```bash
# Ensure runtime dependencies for extensions
if [ ! -d "$REPO_DIR/node_modules/minimatch" ]; then
    echo "[install] Installing runtime dependencies..."
    (cd "$REPO_DIR" && npm install --omit=dev)
fi
```

- [ ] **Step 2: Commit install script update**

```bash
git add install.sh
git commit -m "build: add npm dependency install for minimatch to install.sh"
```

---

## Spec Coverage Check

| Spec requirement | Task |
|---|---|
| Plan Mode (read-only + execute) | Task 1 |
| Permission System (allow/confirm/deny) | Task 2 |
| Task/Todo Tracking (tool + UI) | Task 3 |
| Smart Compaction (hints) | Task 4 |
| Desktop Notifications (osascript/notify-send) | Task 5 |
| APPEND_SYSTEM.md rules | Task 6 |
| Config + docs update | Task 7 |
| Install script dependency | Task 8 |

## Placeholder Scan

No TBDs, TODOs, or "implement later" found. All code blocks contain complete implementations.

## Type Consistency

- `TodoItem` used consistently in `plan-mode.ts` and `todo.ts` (different types — intentional, plan-mode todos have `step`, todo-tracker uses `id`).
- `Action` type (`"allow" | "confirm" | "deny"`) used consistently in `permissions.ts`.
- `NotifyConfig` interface matches all config reads in `desktop-notify.ts`.
