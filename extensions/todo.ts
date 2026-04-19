/**
 * Todo Tracker — multi-step task list with in_progress tracking.
 *
 * Tool `todo` (add/start/done/clear) for the LLM.
 * Command /todo for user inspection.
 * Widget shows active tasks above editor.
 * State persists via appendEntry for crash resilience.
 *
 * Single-active invariant: starting a task moves any previously in_progress
 * task back to pending. Mirrors Claude Code's TodoWrite discipline so Opus
 * has a familiar single-active cursor.
 *
 * Enforcement: first modifying tool_call without prior todo use → steering nag.
 * Second nag condition: extended modifying run with no in_progress task.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

type Status = "pending" | "in_progress" | "done";

interface TodoEntry {
	id: string;
	text: string;
	status: Status;
}

// Backwards-compat for sessions persisted under the old done:boolean shape.
interface LegacyTodoEntry {
	id: string;
	text: string;
	done?: boolean;
	status?: Status;
}

const migrateEntry = (e: LegacyTodoEntry): TodoEntry => {
	if (e.status) return { id: e.id, text: e.text, status: e.status };
	return { id: e.id, text: e.text, status: e.done ? "done" : "pending" };
};

const renderWidget = (ctx: ExtensionContext, items: TodoEntry[]) => {
	if (items.length === 0) {
		ctx.ui.setWidget("todo", undefined);
		ctx.ui.setStatus("02-todo", undefined);
		return;
	}
	const done = items.filter((t) => t.status === "done").length;
	const inProg = items.find((t) => t.status === "in_progress");
	const badge = inProg ? `▶ ${done}/${items.length}` : `${done}/${items.length}`;
	ctx.ui.setStatus("02-todo", ctx.ui.theme.fg("accent", badge));

	// For short lists keep insertion order so the user reads them top-to-bottom
	// exactly as the model planned. For long lists reorder
	// (in_progress → pending → done) so the "done" tail sinks below truncation.
	const TRUNCATE_THRESHOLD = 10;
	const ordered = items.length > TRUNCATE_THRESHOLD
		? [
			...items.filter((t) => t.status === "in_progress"),
			...items.filter((t) => t.status === "pending"),
			...items.filter((t) => t.status === "done"),
		]
		: items;
	ctx.ui.setWidget("todo", ordered.map((t) => {
		if (t.status === "done") {
			return ctx.ui.theme.fg("success", "■") + " " + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text));
		}
		if (t.status === "in_progress") {
			return ctx.ui.theme.fg("accent", "▶") + " " + t.text;
		}
		return ctx.ui.theme.fg("dim", "□") + " " + t.text;
	}));
};

const MODIFYING_TOOLS = new Set(["edit", "write"]);

const MODIFYING_BASH_PATTERNS = [
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|stash|cherry-pick|revert)/i,
	/\brm\s/i, /\bmv\s/i, /\bcp\s/i, /\bmkdir\s/i,
	/\b(npm|yarn|pnpm|pip|cargo|go|brew)\s+(install|add|remove|update)/i,
];

const isModifyingBash = (cmd: string): boolean =>
	MODIFYING_BASH_PATTERNS.some((p) => p.test(cmd));

const MODIFYING_CALLS_BEFORE_START_NAG = 3;

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("todo")) return;
	let items: TodoEntry[] = [];
	let nextId = 1;

	// Enforcement state per agent run.
	let todoWasUsed = false;
	let hasNaggedStart = false;
	let hasNaggedInProgress = false;
	let modifyingCallsWithoutInProgress = 0;

	const persist = () => pi.appendEntry("todo", { items, nextId });

	const resetEnforcement = () => {
		todoWasUsed = items.length > 0;
		hasNaggedStart = false;
		hasNaggedInProgress = false;
		modifyingCallsWithoutInProgress = 0;
	};

	const startInternal = (id: string) => {
		const target = items.find((t) => t.id === id);
		if (!target) throw new Error(`todo #${id} not found`);
		if (target.status === "done") {
			throw new Error(`todo #${id} already done — use 'pending' to re-open`);
		}
		// Single-active invariant: demote any other in_progress back to pending.
		for (const t of items) {
			if (t.status === "in_progress" && t.id !== id) t.status = "pending";
		}
		target.status = "in_progress";
		return target;
	};

	pi.on("session_start", async (_event, ctx) => {
		items = [];
		nextId = 1;
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "todo")
			.pop() as { data?: { items?: LegacyTodoEntry[]; nextId?: number } } | undefined;
		if (last?.data) {
			items = (last.data.items ?? []).map(migrateEntry);
			nextId = last.data.nextId ?? items.length + 1;
		}
		renderWidget(ctx, items);
		resetEnforcement();
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "todo") {
			todoWasUsed = true;
			return;
		}

		let isModifying = MODIFYING_TOOLS.has(event.toolName);
		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			isModifying = isModifyingBash(cmd);
		}
		if (!isModifying) return;

		// Nag #1: started editing without any todo plan.
		if (!hasNaggedStart && !todoWasUsed) {
			hasNaggedStart = true;
			pi.sendMessage(
				{
					customType: "todo-nag",
					content: "⚠️ Ты начал менять код без плана. Вызови `todo add` по шагам, потом `todo start` → работай → `todo done`.",
					display: true,
				},
				{ deliverAs: "steer" },
			);
			return;
		}

		// Nag #2: running modifying ops without any task in_progress.
		const hasInProgress = items.some((t) => t.status === "in_progress");
		const hasOpenWork = items.some((t) => t.status !== "done");
		if (!hasInProgress && hasOpenWork) {
			modifyingCallsWithoutInProgress++;
			if (!hasNaggedInProgress && modifyingCallsWithoutInProgress >= MODIFYING_CALLS_BEFORE_START_NAG) {
				hasNaggedInProgress = true;
				pi.sendMessage(
					{
						customType: "todo-nag",
						content: "⚠️ Ты пишешь код, но ни одна задача не in_progress. Вызови `todo start <id>` на текущий шаг.",
						display: true,
					},
					{ deliverAs: "steer" },
				);
			}
		} else {
			modifyingCallsWithoutInProgress = 0;
		}
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Multi-step task list with an in_progress cursor. Use BEFORE editing for 3+ step work. " +
			"Flow: add items → start one → do work → done → start next. Only ONE task may be in_progress at a time.",
		promptSnippet: "todo add/start/done/clear — plan multi-step work, single in_progress task",
		promptGuidelines: [
			"Call todo add for each step BEFORE editing code when the task has 3+ steps.",
			"Keep exactly one task in_progress at a time — start the next before you work on it.",
			"Mark tasks done as you finish them; don't batch.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "start", "done", "list", "clear"] as const),
			text: Type.Optional(Type.String({ description: "Task text (for add)" })),
			id: Type.Optional(Type.String({ description: "Task ID (for start/done)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "add": {
					if (!params.text) throw new Error("todo add requires 'text'");
					// Fresh plan: wipe if everything was done.
					if (items.length > 0 && items.every((t) => t.status === "done")) {
						items = [];
						nextId = 1;
					}
					const entry: TodoEntry = { id: String(nextId++), text: params.text, status: "pending" };
					items.push(entry);
					persist();
					renderWidget(ctx, items);
					return {
						content: [{ type: "text", text: `Added #${entry.id} (pending): ${entry.text}` }],
						details: { items },
					};
				}
				case "start": {
					if (!params.id) throw new Error("todo start requires 'id'");
					const target = startInternal(params.id);
					persist();
					renderWidget(ctx, items);
					return {
						content: [{ type: "text", text: `Started #${target.id}: ${target.text}` }],
						details: { items },
					};
				}
				case "done": {
					if (!params.id) throw new Error("todo done requires 'id'");
					const target = items.find((t) => t.id === params.id);
					if (!target) throw new Error(`todo #${params.id} not found`);
					target.status = "done";
					persist();
					renderWidget(ctx, items);
					const next = items.find((t) => t.status === "pending");
					const suffix = next ? ` Next pending: #${next.id} — ${next.text}. Call todo start ${next.id}.` : " All done!";
					return {
						content: [{ type: "text", text: `Done #${target.id}: ${target.text}.${suffix}` }],
						details: { items },
					};
				}
				case "list": {
					const sym = (s: Status) => (s === "done" ? "✓" : s === "in_progress" ? "▶" : "○");
					const list = items.map((t) => `${sym(t.status)} #${t.id} ${t.text}`).join("\n");
					return { content: [{ type: "text", text: list || "(empty)" }], details: { items } };
				}
				case "clear": {
					items = items.filter((t) => t.status !== "done");
					persist();
					renderWidget(ctx, items);
					return { content: [{ type: "text", text: `Cleared done. ${items.length} remaining.` }], details: { items } };
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
			const sym = (s: Status) => (s === "done" ? "✓" : s === "in_progress" ? "▶" : "○");
			ctx.ui.notify(items.map((t) => `${sym(t.status)} #${t.id} ${t.text}`).join("\n"), "info");
		},
	});
}
