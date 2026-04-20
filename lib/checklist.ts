/**
 * Shared checklist widget renderer used by todo and plan-mode.
 *
 * Keeps the visual language (□ ▶ ⇄ ■ glyphs, truncate-ordering for long
 * lists, success-strikethrough for done items) in one place so the plan
 * execution panel and the todo tracker look identical.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type ChecklistStatus = "pending" | "in_progress" | "dispatched" | "done";

export interface ChecklistItem {
	text: string;
	status: ChecklistStatus;
}

export interface RenderOptions {
	/** Widget slot id. */
	widgetKey: string;
	/** Status-bar slot id. Skip bar if omitted. */
	statusKey?: string;
	/** Reorder in_progress/pending before done when count exceeds this. */
	truncateThreshold?: number;
}

export const renderChecklist = (
	ctx: ExtensionContext,
	items: ChecklistItem[],
	opts: RenderOptions,
): void => {
	const { widgetKey, statusKey, truncateThreshold = 10 } = opts;

	if (items.length === 0) {
		ctx.ui.setWidget(widgetKey, undefined);
		if (statusKey) ctx.ui.setStatus(statusKey, undefined);
		return;
	}

	const done = items.filter((t) => t.status === "done").length;
	const inProg = items.some((t) => t.status === "in_progress");
	const dispatchedCount = items.filter((t) => t.status === "dispatched").length;

	if (statusKey) {
		// Three-shape badge: in_progress alone, dispatched alone, both.
		// Lets the user see at a glance whether parallel subagent work is
		// in flight without opening the widget.
		let prefix = "";
		if (inProg && dispatchedCount > 0) prefix = `▶+⇄${dispatchedCount} `;
		else if (inProg) prefix = "▶ ";
		else if (dispatchedCount > 0) prefix = `⇄${dispatchedCount} `;
		const badge = `${prefix}${done}/${items.length}`;
		ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("accent", badge));
	}

	const ordered = items.length > truncateThreshold
		? [
			...items.filter((t) => t.status === "in_progress"),
			...items.filter((t) => t.status === "dispatched"),
			...items.filter((t) => t.status === "pending"),
			...items.filter((t) => t.status === "done"),
		]
		: items;

	ctx.ui.setWidget(widgetKey, ordered.map((t) => {
		if (t.status === "done") {
			return ctx.ui.theme.fg("success", "■") + " " + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text));
		}
		if (t.status === "in_progress") {
			return ctx.ui.theme.fg("accent", "▶") + " " + t.text;
		}
		if (t.status === "dispatched") {
			return ctx.ui.theme.fg("accent", "⇄") + " " + t.text;
		}
		return ctx.ui.theme.fg("dim", "□") + " " + t.text;
	}));
};
