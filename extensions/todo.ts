/**
 * Todo Tracker — multi-step task list with in_progress tracking.
 *
 * Tool `todo` (add/start/done/clear) for the LLM.
 * Command /todo for user inspection.
 * Widget shows active tasks above editor.
 * State persists via appendEntry for crash resilience.
 *
 * Single-active invariant: starting a task moves any previously in_progress
 * task back to pending. Mirrors Claude Code's TodoWrite discipline so the
 * model has a familiar single-active cursor.
 *
 * Enforcement: a single steering nag fires only after the model racks
 * up several modifying operations without any `in_progress` task — the
 * actual signal of an unstructured multi-step run. One-shot edits stay
 * silent; the nag's wording adapts to whether there are todos at all.
 *
 * Cross-extension API (event bus):
 *   emit "opus-pack:todo:replace"  { items: Array<{text, done?}>, source? }
 *     — wipe list and install new items; ids renumber from 1.
 *   emit "opus-pack:todo:mark-done-by-step" { step }
 *     — mark the Nth (1-based) item as done.
 *   emit "opus-pack:todo:clear"
 *     — wipe every task.
 *   listen "opus-pack:todo:changed" { items }
 *     — fires after every mutation. Used by plan-mode to writeback progress.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";
import { renderChecklist, type ChecklistItem } from "../lib/checklist.js";

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
	const checklistItems: ChecklistItem[] = items.map((t) => ({ text: t.text, status: t.status }));
	renderChecklist(ctx, checklistItems, { widgetKey: "todo", statusKey: "02-todo" });
};

const MODIFYING_TOOLS = new Set(["edit", "write"]);

const MODIFYING_BASH_PATTERNS = [
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|stash|cherry-pick|revert)/i,
	/\brm\s/i, /\bmv\s/i, /\bcp\s/i, /\bmkdir\s/i,
	/\b(npm|yarn|pnpm|pip|cargo|go|brew)\s+(install|add|remove|update)/i,
];

const isModifyingBash = (cmd: string): boolean =>
	MODIFYING_BASH_PATTERNS.some((p) => p.test(cmd));

// How many modifying operations without an `in_progress` task we allow
// before nudging the model. Set to 2 so a one-shot edit stays silent
// while a pattern of repeated modifications (the actual signal of a
// multi-step run) triggers a single reminder.
const MODIFYING_CALLS_BEFORE_START_NAG = 2;

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("todo")) return;
	let items: TodoEntry[] = [];
	let nextId = 1;

	// Enforcement state per agent run.
	let hasNaggedInProgress = false;
	let modifyingCallsWithoutInProgress = 0;

	const persist = () => pi.appendEntry("todo", { items, nextId });

	// Latest context captured from any event handler. Used so the event-bus
	// listeners (which receive no ctx) can still update the widget right
	// after a cross-extension replace/mark call.
	let lastCtx: ExtensionContext | null = null;
	const rerender = () => {
		if (lastCtx) renderWidget(lastCtx, items);
	};

	const emitChanged = () => {
		pi.events.emit("opus-pack:todo:changed", { items: items.map((t) => ({ ...t })) });
	};

	const resetEnforcement = () => {
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
		lastCtx = ctx;
		resetEnforcement();
		// Re-broadcast restored state so cross-extension consumers
		// (plan-mode's progress mirror) rebuild their snapshots after
		// a session resume. No-op if no one is listening yet.
		emitChanged();
	});

	// Cross-extension listeners. plan-mode emits :replace when a plan is
	// approved and :mark-done-by-step if it ever tracks progress externally.
	pi.events.on("opus-pack:todo:replace", (data) => {
		const payload = data as { items?: Array<{ text?: string; done?: boolean }> } | undefined;
		const incoming = Array.isArray(payload?.items) ? payload!.items : [];
		items = [];
		nextId = 1;
		for (const inc of incoming) {
			const text = typeof inc.text === "string" ? inc.text : "";
			if (!text) continue;
			items.push({ id: String(nextId++), text, status: inc.done ? "done" : "pending" });
		}
		// Fresh plan installed externally: reset nag state so enforcement
		// starts over against the new list.
		hasNaggedInProgress = false;
		modifyingCallsWithoutInProgress = 0;
		persist();
		rerender();
		emitChanged();
	});

	pi.events.on("opus-pack:todo:mark-done-by-step", (data) => {
		const payload = data as { step?: number } | undefined;
		const step = Number(payload?.step);
		if (!Number.isFinite(step) || step < 1 || step > items.length) return;
		const target = items[step - 1];
		if (target.status === "done") return;
		target.status = "done";
		persist();
		rerender();
		emitChanged();
	});

	pi.events.on("opus-pack:todo:clear", () => {
		if (items.length === 0) return;
		items = [];
		nextId = 1;
		persist();
		rerender();
		emitChanged();
	});

	pi.on("tool_call", async (event, _ctx) => {
		if (event.toolName === "todo") return;

		let isModifying = MODIFYING_TOOLS.has(event.toolName);
		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			isModifying = isModifyingBash(cmd);
		}
		if (!isModifying) return;

		// Single nag: detect sustained modifying activity without a task
		// in_progress. This replaces the old zero-threshold "first-edit"
		// nag — small one-shot fixes (a single edit / write / mkdir)
		// should NOT trigger a discipline reminder. Only when the model
		// racks up several modifying operations without any todo cursor
		// do we tap on the shoulder.
		//
		// Two shapes covered by the same counter:
		//   a) No todos at all → nag suggests `todo add` + `todo start`.
		//   b) Todos exist but none is in_progress → nag suggests only
		//      `todo start <id>` (user has already planned).
		const hasInProgress = items.some((t) => t.status === "in_progress");
		const hasOpenWork = items.some((t) => t.status !== "done");
		if (hasInProgress) {
			modifyingCallsWithoutInProgress = 0;
			return;
		}

		modifyingCallsWithoutInProgress++;
		if (hasNaggedInProgress) return;
		if (modifyingCallsWithoutInProgress < MODIFYING_CALLS_BEFORE_START_NAG) return;

		hasNaggedInProgress = true;
		const msg = hasOpenWork
			? "⚠ You are writing code but no task is in_progress. Call `todo start <id>` on the current step."
			: "⚠ You have made several modifications without a plan. If this is a multi-step task (3+ steps), call `todo add` for each step, then `todo start <id>` on the first.";
		pi.sendMessage(
			{ customType: "todo-nag", content: msg, display: true },
			{ deliverAs: "steer" },
		);
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
					emitChanged();
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
					emitChanged();
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
					emitChanged();
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
					emitChanged();
					return { content: [{ type: "text", text: `Cleared done. ${items.length} remaining.` }], details: { items } };
				}
			}
		},
	});

	// Refresh the widget on every turn and keep lastCtx fresh so event-bus
	// listeners can re-render widgets when plan-mode mutates state.
	pi.on("before_agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		renderWidget(ctx, items);
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
