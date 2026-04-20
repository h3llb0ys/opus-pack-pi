/**
 * Todo Tracker — multi-step task list with in_progress tracking.
 *
 * Tool `todo` (add/start/done/dispatch/list/clear) for the LLM.
 * Command /todo for user inspection.
 * Widget shows active tasks above editor.
 * State persists via appendEntry for crash resilience.
 *
 * Single-active invariant: starting a task moves any previously in_progress
 * task back to pending. Mirrors Claude Code's TodoWrite discipline so the
 * model has a familiar single-active cursor.
 *
 * Parallel execution: `dispatch` flips items into `dispatched` (work has
 * been delegated to subagents via the pi-subagents `subagent` tool).
 * Multiple items may be `dispatched` simultaneously without violating
 * the single-active invariant on `in_progress`. Recovery: `start` on a
 * dispatched item flips it back into `in_progress` so the main agent
 * takes the work over (e.g. when a subagent failed or timed out).
 *
 * Enforcement:
 *   - Activity nag: a single steering nag fires when the model racks up
 *     modifying operations without any active task. "Active" means
 *     in_progress OR dispatched — there is no point nagging while work
 *     is delegated.
 *   - Orphan-dispatched nag: if the same set of dispatched ids stays
 *     unchanged for several `before_agent_start` ticks, remind the model
 *     to either close them with `todo done` or take them over with
 *     `todo start`. Avoids silently hung plans when a subagent's result
 *     never gets reconciled.
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

type Status = "pending" | "in_progress" | "dispatched" | "done";

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

// How many modifying operations without an active (in_progress OR
// dispatched) task we allow before nudging the model. Set to 2 so a
// one-shot edit stays silent while a pattern of repeated modifications
// (the actual signal of a multi-step run) triggers a single reminder.
const MODIFYING_CALLS_BEFORE_START_NAG = 2;

// Number of consecutive `before_agent_start` ticks the same set of
// dispatched ids must persist before the orphan-dispatched nag fires.
// Three ticks ≈ several model turns of inactivity on those items —
// long enough to mean "subagent return was probably forgotten" without
// firing on a single slow turn.
const ORPHAN_DISPATCH_TURNS_THRESHOLD = 3;

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("todo")) return;
	let items: TodoEntry[] = [];
	let nextId = 1;

	// Enforcement state per agent run.
	let hasNaggedInProgress = false;
	let modifyingCallsWithoutInProgress = 0;
	// Orphan-dispatched detection: track the dispatched-set across turns.
	let dispatchedSnapshotIds: Set<string> = new Set();
	let dispatchedStaleTurns = 0;
	let hasNaggedOrphaned = false;

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
		dispatchedSnapshotIds = new Set();
		dispatchedStaleTurns = 0;
		hasNaggedOrphaned = false;
	};

	const dispatchedIdSet = (): Set<string> =>
		new Set(items.filter((t) => t.status === "dispatched").map((t) => t.id));

	const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
		if (a.size !== b.size) return false;
		for (const v of a) if (!b.has(v)) return false;
		return true;
	};

	const startInternal = (id: string) => {
		const target = items.find((t) => t.id === id);
		if (!target) throw new Error(`todo #${id} not found`);
		if (target.status === "done") {
			// No re-open path is intentional: re-opening a done task would
			// muddle the audit trail plan-mode persists into done_steps.
			// If the work needs to happen again, add a fresh todo for it.
			throw new Error(`todo #${id} already done — add a new todo for the rework instead of reopening it.`);
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
		// starts over against the new list. Orphan tracker auto-resets
		// on the next before_agent_start tick because the dispatched-set
		// will differ from the prior snapshot (empty for a fresh plan).
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

		// Single nag: detect sustained modifying activity without an
		// active task. This replaces the old zero-threshold "first-edit"
		// nag — small one-shot fixes (a single edit / write / mkdir)
		// should NOT trigger a discipline reminder. Only when the model
		// racks up several modifying operations without any active todo
		// do we tap on the shoulder.
		//
		// "Active" means in_progress OR dispatched: a delegated step
		// counts as active work because the model is intentionally
		// waiting on a subagent, not "modifying without a plan".
		//
		// Two shapes covered by the same counter:
		//   a) No todos at all → nag suggests `todo add` + `todo start`.
		//   b) Todos exist but none is active → nag suggests only
		//      `todo start <id>` (user has already planned).
		const hasActive = items.some((t) => t.status === "in_progress" || t.status === "dispatched");
		const hasOpenWork = items.some((t) => t.status !== "done");
		if (hasActive) {
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
			"Flow: add items → start one → do work → done → start next. Only ONE task may be in_progress at a time. " +
			"Both `add` and `done` accept a batch (`texts: string[]` / `ids: string[]`) so the entire plan or a closing wave of completed steps can land in a single tool call. " +
			"For independent steps, use `dispatch ids:[...]` to mark them as delegated to subagents (via the pi-subagents `subagent` tool); call `done ids:[...]` once results return, or `start id:N` to take a stuck dispatch over locally.",
		promptSnippet: "todo add/start/done/dispatch/clear — plan multi-step work, single in_progress task; add+done accept batches; dispatch flips items into 'delegated to subagent' state",
		promptGuidelines: [
			"When you already know all the steps, call `todo add` ONCE with `texts: [...]` to drop the whole plan in one shot — don't loop one-add-per-step.",
			"Keep exactly one task in_progress at a time — start the next before you work on it.",
			"Mark a task done as soon as you finish it; if several adjacent steps wrap up together, `todo done` with `ids: [...]` flushes them in one call.",
			"For independent steps, parallelize: `todo dispatch ids:[...]` then `subagent({tasks:[...], concurrency:N})`; `todo done ids:[...]` after results return. If a subagent fails or times out, `todo start id:N` flips dispatched → in_progress so you take that step over locally.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "start", "done", "dispatch", "list", "clear"] as const),
			text: Type.Optional(Type.String({ description: "Single task text (for add). Use 'texts' for a batch." })),
			texts: Type.Optional(Type.Array(Type.String(), {
				description: "Batch task texts (for add). Adds every entry in order, sharing one tool call. Prefer this when planning 3+ steps upfront.",
			})),
			id: Type.Optional(Type.String({ description: "Single task ID (for start/done/dispatch). Use 'ids' to operate on multiple in one call (done/dispatch only)." })),
			ids: Type.Optional(Type.Array(Type.String(), {
				description: "Batch task IDs for `done` and `dispatch` — marks every listed task in one call. `start` keeps the single-active invariant and rejects batches.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "add": {
					// Forgiving merge: when the model passes both `text` and
					// `texts`, treat `text` as one more entry instead of
					// silently dropping it. `texts` order is preserved with
					// `text` appended so the model can still tell the
					// "primary" item if it cared about order.
					const inputs: string[] = [];
					if (params.texts) inputs.push(...params.texts);
					if (params.text) inputs.push(params.text);
					if (inputs.length === 0) throw new Error("todo add requires 'text' or non-empty 'texts'");
					// Fresh plan: wipe if everything was done.
					if (items.length > 0 && items.every((t) => t.status === "done")) {
						items = [];
						nextId = 1;
					}
					const added: TodoEntry[] = [];
					for (const raw of inputs) {
						const trimmed = String(raw).trim();
						if (!trimmed) continue;
						const entry: TodoEntry = { id: String(nextId++), text: trimmed, status: "pending" };
						items.push(entry);
						added.push(entry);
					}
					if (added.length === 0) throw new Error("todo add: every text was blank");
					persist();
					renderWidget(ctx, items);
					emitChanged();
					if (added.length === 1) {
						return {
							content: [{ type: "text", text: `Added #${added[0].id} (pending): ${added[0].text}` }],
							details: { items },
						};
					}
					const lines = added.map((e) => `  #${e.id} ${e.text}`).join("\n");
					return {
						content: [{ type: "text", text: `Added ${added.length} todos:\n${lines}` }],
						details: { items },
					};
				}
				case "start": {
					if (params.ids && params.ids.length > 0) {
						throw new Error("todo start can only set ONE task in_progress at a time. Pass a single `id` (use the first step you intend to work on); finish it with `todo done <id>`, then call `todo start` again for the next.");
					}
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
					// Forgiving merge: combine `id` + `ids` instead of
					// dropping one. Trim each id and dedupe so a model
					// that re-lists the same step in a batch (or pads with
					// whitespace) doesn't see a self-conflicting
					// "Done #1. Skipped: #1 (already done)" message.
					const rawIds: string[] = [];
					if (params.ids) rawIds.push(...params.ids);
					if (params.id) rawIds.push(params.id);
					const ids = [...new Set(rawIds.map((s) => String(s).trim()).filter((s) => s.length > 0))];
					if (ids.length === 0) throw new Error("todo done requires 'id' or non-empty 'ids'");
					const completed: TodoEntry[] = [];
					const skipped: Array<{ id: string; reason: string }> = [];
					for (const id of ids) {
						const target = items.find((t) => t.id === id);
						if (!target) {
							skipped.push({ id, reason: "not found" });
							continue;
						}
						if (target.status === "done") {
							skipped.push({ id, reason: "already done" });
							continue;
						}
						target.status = "done";
						completed.push(target);
					}
					if (completed.length === 0 && skipped.length > 0) {
						throw new Error(`todo done: ${skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}`);
					}
					persist();
					renderWidget(ctx, items);
					emitChanged();
					// Suffix has to acknowledge both lanes: a closed batch
					// of `done` may leave pending work AND/OR dispatched
					// (subagent) work still in flight. Saying "All done!"
					// while subagents haven't returned would mislead the
					// model into thinking the plan is complete.
					const next = items.find((t) => t.status === "pending");
					const remainingDispatched = items.filter((t) => t.status === "dispatched").length;
					let suffix: string;
					if (next) {
						suffix = ` Next pending: #${next.id} — ${next.text}. Call todo start ${next.id}.`;
						if (remainingDispatched > 0) suffix += ` (${remainingDispatched} dispatched task(s) still in flight.)`;
					} else if (remainingDispatched > 0) {
						suffix = ` ${remainingDispatched} dispatched task(s) still in flight — close with todo done ids:[...] when subagents return.`;
					} else {
						suffix = " All done!";
					}
					if (completed.length === 1 && skipped.length === 0) {
						return {
							content: [{ type: "text", text: `Done #${completed[0].id}: ${completed[0].text}.${suffix}` }],
							details: { items },
						};
					}
					const doneLine = `Done ${completed.length}: ${completed.map((e) => `#${e.id}`).join(", ")}.`;
					const skipLine = skipped.length > 0 ? ` Skipped: ${skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}.` : "";
					return {
						content: [{ type: "text", text: `${doneLine}${skipLine}${suffix}` }],
						details: { items },
					};
				}
				case "dispatch": {
					// Same forgiving merge + trim + dedupe shape as `done`,
					// since the model usually arrives at this point with the
					// same kind of "I have a list of step ids" mental model.
					const rawIds: string[] = [];
					if (params.ids) rawIds.push(...params.ids);
					if (params.id) rawIds.push(params.id);
					const ids = [...new Set(rawIds.map((s) => String(s).trim()).filter((s) => s.length > 0))];
					if (ids.length === 0) throw new Error("todo dispatch requires 'id' or non-empty 'ids'");
					const dispatched: TodoEntry[] = [];
					const skipped: Array<{ id: string; reason: string }> = [];
					for (const id of ids) {
						const target = items.find((t) => t.id === id);
						if (!target) {
							skipped.push({ id, reason: "not found" });
							continue;
						}
						if (target.status === "done") {
							skipped.push({ id, reason: "already done" });
							continue;
						}
						if (target.status === "dispatched") {
							skipped.push({ id, reason: "already dispatched" });
							continue;
						}
						// pending and in_progress both accepted — model may
						// be promoting current local work into a subagent
						// flow, which is a legitimate transition.
						target.status = "dispatched";
						dispatched.push(target);
					}
					if (dispatched.length === 0 && skipped.length > 0) {
						throw new Error(`todo dispatch: ${skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}`);
					}
					persist();
					renderWidget(ctx, items);
					emitChanged();
					// The dispatched-set just grew. The orphan-detection
					// state will reconcile on the next before_agent_start
					// tick (set comparison resets the counter naturally).
					const idList = dispatched.map((e) => `#${e.id}`).join(", ");
					const skipLine = skipped.length > 0 ? ` Skipped: ${skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}.` : "";
					const followup = ` Now call subagent({tasks:[...], concurrency:${dispatched.length}}) for each, then \`todo done ids:[${dispatched.map((e) => e.id).join(",")}]\` when they return. If a subagent fails, \`todo start id:N\` flips dispatched → in_progress so you take it over.`;
					return {
						content: [{ type: "text", text: `Dispatched ${dispatched.length}: ${idList}.${skipLine}${followup}` }],
						details: { items },
					};
				}
				case "list": {
					const sym = (s: Status) => (s === "done" ? "✓" : s === "in_progress" ? "▶" : s === "dispatched" ? "⇄" : "○");
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
	// Also drives the orphan-dispatched detector — if the same set of
	// dispatched ids survives several ticks unchanged, nag the model.
	pi.on("before_agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		renderWidget(ctx, items);

		const current = dispatchedIdSet();
		if (current.size === 0) {
			// No dispatched work — fully reset the detector so the next
			// dispatch starts a fresh count.
			dispatchedSnapshotIds = current;
			dispatchedStaleTurns = 0;
			hasNaggedOrphaned = false;
			return;
		}
		if (setsEqual(current, dispatchedSnapshotIds)) {
			dispatchedStaleTurns++;
		} else {
			dispatchedSnapshotIds = current;
			dispatchedStaleTurns = 1;
			hasNaggedOrphaned = false;
		}
		if (!hasNaggedOrphaned && dispatchedStaleTurns >= ORPHAN_DISPATCH_TURNS_THRESHOLD) {
			hasNaggedOrphaned = true;
			const idList = [...current].map((id) => `#${id}`).join(", ");
			pi.sendMessage(
				{
					customType: "todo-nag",
					content:
						`⚠ You have ${current.size} task(s) still in \`dispatched\` state for several turns: ${idList}.\n` +
						"If subagents have already returned, call `todo done ids:[...]` to close them.\n" +
						"If a subagent failed or timed out, call `todo start id:<N>` to take the task over locally.",
					display: true,
				},
				{ deliverAs: "steer" },
			);
		}
	});

	pi.registerCommand("todo", {
		description: "Show current todo list",
		handler: async (_args, ctx) => {
			if (items.length === 0) {
				ctx.ui.notify("(no tasks)", "info");
				return;
			}
			const sym = (s: Status) => (s === "done" ? "✓" : s === "in_progress" ? "▶" : s === "dispatched" ? "⇄" : "○");
			ctx.ui.notify(items.map((t) => `${sym(t.status)} #${t.id} ${t.text}`).join("\n"), "info");
		},
	});
}
