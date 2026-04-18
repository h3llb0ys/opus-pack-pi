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
import { Type } from "@sinclair/typebox";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// Read-only allowlist of command names that may appear in any segment
// of a pipeline / compound command in plan mode.
const SAFE_COMMANDS = new Set([
	"cat", "head", "tail", "grep", "egrep", "fgrep", "find", "ls", "pwd", "echo", "printf",
	"wc", "sort", "uniq", "cut", "tr", "awk", "xargs", "tee",
	"diff", "file", "stat", "du", "df", "tree",
	"which", "type", "whereis", "env", "uname", "whoami", "id", "hostname", "date",
	"basename", "dirname", "realpath", "readlink",
	"jq", "yq", "rg", "fd", "bat",
	"test", "expr", "true", "false", "yes",
]);

// Read-only subcommand allowlist for tools that are only safe with specific args.
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
	git: new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files", "ls-tree", "config", "rev-parse", "describe", "blame"]),
	npm: new Set(["list", "ls", "view", "outdated"]),
	cargo: new Set(["tree", "metadata", "check"]),
	go: new Set(["list", "env", "version"]),
	sed: new Set([]), // sed without -i is read-only; handled below
	python: new Set(["-c", "--version"]),
	node: new Set(["--version", "-v"]),
};

// Hard-block these anywhere in the command string.
const HARD_BLOCK_PATTERNS = [
	/\bsudo\b/i,
	/\brm\s+-[rf]|\brm\s+-[rR]?[fF]|\brm\s+--/i,
	/\b(mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\s/i,
	/\bkill(all)?\s+-[0-9A-Z]/i, /\bpkill\b/i,
	/\b(npm|yarn|pnpm|pip|pipx|brew|apt|apt-get|dnf|yum|pacman|cargo)\s+(install|add|remove|uninstall|update|upgrade)/i,
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|clean|reflog\s+expire)/i,
	/\b(curl|wget)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/(^|[^<>])>(?!>)/, />>/, // output redirection
];

const isSegmentSafe = (seg: string): boolean => {
	const trimmed = seg.trim();
	if (!trimmed) return false;
	const tokens = trimmed.split(/\s+/);
	const cmd = tokens[0].replace(/^\\/, ""); // strip escape
	const base = cmd.includes("/") ? cmd.slice(cmd.lastIndexOf("/") + 1) : cmd;
	if (SAFE_COMMANDS.has(base)) return true;
	const allowedSubs = SAFE_SUBCOMMANDS[base];
	if (allowedSubs) {
		if (base === "sed") {
			// sed without -i is read-only.
			return !tokens.some((t) => t === "-i" || t.startsWith("-i") || t === "--in-place");
		}
		if (allowedSubs.size === 0) return false;
		return tokens.slice(1).some((t) => allowedSubs.has(t));
	}
	return false;
};

interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

function isSafeCommand(cmd: string): boolean {
	if (HARD_BLOCK_PATTERNS.some((p) => p.test(cmd))) return false;
	// Split on pipes and command chains; every segment must be read-only.
	const segments = cmd.split(/\|\||&&|;|\||&(?!\d)/).map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return false;
	return segments.every(isSegmentSafe);
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

	// Broadcast plan-mode state on every change so other extensions (e.g.
	// session-summary) can react without reaching back into this module.
	const broadcastPlanState = () => {
		pi.events.emit("opus-pack:plan-state", { active: planModeEnabled || executionMode });
	};

	const updateStatus = (ctx: ExtensionContext) => {
		broadcastPlanState();
		if (executionMode && todoItems.length > 0) {
			const done = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("01-plan", ctx.ui.theme.fg("accent", `📋 ${done}/${todoItems.length}`));
		} else if (planModeEnabled) {
			// CC-style: accent-coloured pause + label + shortcut hint.
			const label = ctx.ui.theme.fg("accent", "⏸ plan mode on") + " " + ctx.ui.theme.fg("muted", "(cmd+p)");
			ctx.ui.setStatus("01-plan", label);
		} else {
			ctx.ui.setStatus("01-plan", undefined);
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

	pi.registerShortcut(Key.alt("tab"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});
	pi.registerShortcut(Key.super("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode (fallback)",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Explicit LLM-callable exit: model proposes the full plan, user confirms,
	// execution starts immediately. Avoids relying on [DONE:N] text parsing.
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		description:
			"Call when you have finished the plan and are ready to execute. " +
			"Pass the plan as a numbered list (1. step one, 2. step two). " +
			"The user is asked to approve; on approval plan mode exits and execution starts.",
		promptSnippet: "exit_plan_mode(plan) — finish planning, request user approval to execute",
		parameters: Type.Object({
			plan: Type.String({ description: "The final plan as a numbered markdown list." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planModeEnabled) {
				return {
					content: [{ type: "text", text: "refused: not currently in plan mode" }],
					isError: true,
					details: { approved: false },
				};
			}
			const extracted = extractTodoItems(`Plan:\n${params.plan}`);
			if (extracted.length > 0) todoItems = extracted;

			if (!ctx.hasUI) {
				// Non-interactive: auto-approve.
				planModeEnabled = false;
				executionMode = todoItems.length > 0;
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
				persist();
				return {
					content: [{ type: "text", text: `plan accepted (non-interactive). ${todoItems.length} steps. execute now.` }],
					isError: false,
					details: { approved: true, steps: todoItems.length },
				};
			}

			const approved = await ctx.ui.confirm(
				"Exit plan mode and execute?",
				`${todoItems.length} step${todoItems.length === 1 ? "" : "s"} queued.`,
			);
			if (!approved) {
				return {
					content: [{ type: "text", text: "user declined execution. stay in plan mode." }],
					isError: false,
					details: { approved: false },
				};
			}
			planModeEnabled = false;
			executionMode = todoItems.length > 0;
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			persist();
			return {
				content: [{ type: "text", text: `plan approved. proceed with step 1. mark progress with [DONE:n] markers.` }],
				isError: false,
				details: { approved: true, steps: todoItems.length },
			};
		},
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
