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
					? ctx.ui.theme.fg("success", "■") + " " + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
					: ctx.ui.theme.fg("dim", "□") + " " + t.text,
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
