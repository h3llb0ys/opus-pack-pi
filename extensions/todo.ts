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
	ctx.ui.setStatus("todo", ctx.ui.theme.fg("accent", `${done}/${items.length}`));
	ctx.ui.setWidget("todo", items.map((t) =>
		t.done
			? ctx.ui.theme.fg("success", "■") + " " + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
			: ctx.ui.theme.fg("dim", "□") + " " + t.text,
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

		// Track that todo was used
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
