/**
 * Session Summary — brief report after agent finishes work.
 *
 * On agent_end: if agent made ≥3 tool calls, generates a summary
 * from tool call history: files changed, tests run, errors.
 * Shown as a notification, not injected into context.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

interface ToolStat {
	reads: number;
	edits: number;
	writes: number;
	bashes: number;
	editFiles: Set<string>;
	writeFiles: Set<string>;
	readFiles: Set<string>;
	errors: number;
}

const countTools = (ctx: ExtensionContext): ToolStat => {
	const stat: ToolStat = {
		reads: 0, edits: 0, writes: 0, bashes: 0,
		editFiles: new Set(), writeFiles: new Set(), readFiles: new Set(),
		errors: 0,
	};

	try {
		const entries = ctx.sessionManager.getEntries();
		// Only count from the current agent run (last user message onward)
		// Walk backwards to find the last user message, then count forward
		let startIdx = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as { type?: string; message?: { role?: string } };
			if (e.type === "message" && e.message?.role === "user") {
				startIdx = i;
				break;
			}
		}

		for (let i = startIdx; i < entries.length; i++) {
			const e = entries[i] as {
				type?: string;
				message?: {
					role?: string;
					toolName?: string;
					isError?: boolean;
					content?: string | Array<{ type?: string; text?: string }>;
				};
			};
			if (e.type !== "message" || !e.message) continue;
			const msg = e.message;

			if (msg.role === "toolResult" || msg.role === "assistant") {
				if (msg.isError) stat.errors++;
			}

			// Count tool calls from assistant messages
			if (msg.role === "assistant" && typeof msg.content !== "string" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "toolCall") {
						const tc = part as { name?: string; arguments?: Record<string, unknown> };
						switch (tc.name) {
							case "read":
								stat.reads++;
								if (tc.arguments?.path) stat.readFiles.add(String(tc.arguments.path));
								break;
							case "edit":
								stat.edits++;
								if (tc.arguments?.path) stat.editFiles.add(String(tc.arguments.path));
								break;
							case "write":
								stat.writes++;
								if (tc.arguments?.path) stat.writeFiles.add(String(tc.arguments.path));
								break;
							case "bash":
								stat.bashes++;
								break;
						}
					}
				}
			}
		}
	} catch {
		// sessionManager may not be available in all contexts
	}

	return stat;
};

const formatSummary = (stat: ToolStat): string | null => {
	const total = stat.reads + stat.edits + stat.writes + stat.bashes;
	if (total < 3) return null; // not enough activity to summarize

	const lines: string[] = ["═══ Session Summary ═══"];

	if (stat.editFiles.size > 0 || stat.writeFiles.size > 0) {
		const allChanged = [...new Set([...stat.editFiles, ...stat.writeFiles])];
		lines.push(`📝 Modified: ${allChanged.length} file${allChanged.length > 1 ? "s" : ""}`);
		for (const f of allChanged.slice(0, 8)) {
			const short = f.split("/").pop() ?? f;
			lines.push(`   ${short}`);
		}
		if (allChanged.length > 8) lines.push(`   ... +${allChanged.length - 8} more`);
	}

	if (stat.reads > 0) lines.push(`📖 Read: ${stat.reads} file${stat.reads > 1 ? "s" : ""} (${stat.readFiles.size} unique)`);
	if (stat.bashes > 0) lines.push(`⚡ Bash: ${stat.bashes} command${stat.bashes > 1 ? "s" : ""}`);
	if (stat.errors > 0) lines.push(`❌ Errors: ${stat.errors}`);

	return lines.join("\n");
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("session-summary")) return;
	// Listen to plan-mode state broadcasts so we can skip the summary while
	// the user is still iterating on a plan (no point summarising a turn
	// that's part of /plan → refine → submit → still in plan mode).
	let planActive = false;
	pi.events.on("opus-pack:plan-state", (data) => {
		if (data && typeof data === "object" && "active" in data) {
			planActive = Boolean((data as { active: unknown }).active);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (planActive) return;
		const stat = countTools(ctx);
		const summary = formatSummary(stat);
		if (summary) {
			ctx.ui.notify(summary, "info");
		}
	});
}
