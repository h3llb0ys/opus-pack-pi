/**
 * /context — visualize what's eating your context window.
 *
 * Scans session entries, counts tokens by category:
 * system prompt, user messages, assistant messages, tool calls/results.
 * Shows breakdown + usage % from ctx.getContextUsage().
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ContextBreakdown {
	systemPrompt: number;
	userMessages: number;
	assistantText: number;
	toolCalls: number;
	toolResults: number;
	images: number;
	totalEntries: number;
	toolCallCounts: Record<string, number>;
	fileReadCounts: Record<string, number>;
}

const analyzeSession = (ctx: any): ContextBreakdown => {
	const bd: ContextBreakdown = {
		systemPrompt: 0,
		userMessages: 0,
		assistantText: 0,
		toolCalls: 0,
		toolResults: 0,
		images: 0,
		totalEntries: 0,
		toolCallCounts: {},
		fileReadCounts: {},
	};

	try {
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries) {
			if (entry.type !== "message" || !entry.message) continue;
			bd.totalEntries++;
			const msg = entry.message;

			if (msg.role === "system") {
				bd.systemPrompt += estimateTokens(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
			}

			if (msg.role === "user") {
				if (typeof msg.content === "string") {
					bd.userMessages += estimateTokens(msg.content);
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text") bd.userMessages += estimateTokens(part.text ?? "");
						if (part.type === "image") bd.images++;
					}
				}
			}

			if (msg.role === "assistant") {
				if (typeof msg.content === "string") {
					bd.assistantText += estimateTokens(msg.content);
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text") bd.assistantText += estimateTokens(part.text ?? "");
						if (part.type === "toolCall") {
							bd.toolCalls++;
							const name = part.name ?? "unknown";
							bd.toolCallCounts[name] = (bd.toolCallCounts[name] ?? 0) + 1;
							// Track file paths for read/edit/write
							const args = part.arguments as Record<string, unknown> | undefined;
							if (args) {
								const filePath = String(args.path ?? args.file_path ?? "");
								if (filePath) bd.fileReadCounts[filePath] = (bd.fileReadCounts[filePath] ?? 0) + 1;
							}
						}
					}
				}
				// Count usage from assistant messages
				if (msg.usage?.totalTokens) {
					// Already counted via content estimation
				}
			}

			if (msg.role === "toolResult" || msg.role === "tool_result") {
				if (typeof msg.content === "string") {
					bd.toolResults += estimateTokens(msg.content);
				} else if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text") bd.toolResults += estimateTokens(part.text ?? "");
					}
				}
			}
		}
	} catch { /* ignore */ }

	return bd;
};

// Rough: 1 token ≈ 4 chars
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const formatTk = (n: number): string => {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
};

const bar = (pct: number, width = 30): string => {
	const filled = Math.round(pct * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show context window breakdown: what's using your tokens",
		handler: async (_args, ctx) => {
			const bd = analyzeSession(ctx);
			const usage = ctx.getContextUsage();

			const total = bd.systemPrompt + bd.userMessages + bd.assistantText + bd.toolCalls + bd.toolResults;
			const pct = usage?.percent ?? 0;
			const maxTokens = usage?.maxTokens ?? 200_000;

			const lines: string[] = [
				"═══ Context Window ═══",
				"",
				`Usage: ${pct}%  ${bar(pct / 100)}  ${formatTk(total)} / ${formatTk(maxTokens)}`,
				"",
				"Breakdown:",
				`  System prompt    ${formatTk(bd.systemPrompt).padStart(8)}  (${pctOf(bd.systemPrompt, total)}%)`,
				`  User messages    ${formatTk(bd.userMessages).padStart(8)}  (${pctOf(bd.userMessages, total)}%)`,
				`  Assistant text   ${formatTk(bd.assistantText).padStart(8)}  (${pctOf(bd.assistantText, total)}%)`,
				`  Tool calls       ${formatTk(bd.toolCalls).padStart(8)}  (${pctOf(bd.toolCalls, total)}%)`,
				`  Tool results     ${formatTk(bd.toolResults).padStart(8)}  (${pctOf(bd.toolResults, total)}%)`,
			];

			if (bd.images > 0) {
				lines.push(`  Images           ${String(bd.images).padStart(8)}`);
			}

			lines.push(`  ─────────────────────────`);
			lines.push(`  Total entries    ${String(bd.totalEntries).padStart(8)}`);

			// Top tool calls
			const topTools = Object.entries(bd.toolCallCounts)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6);
			if (topTools.length > 0) {
				lines.push("");
				lines.push("Top tools:");
				for (const [name, count] of topTools) {
					lines.push(`  ${name.padEnd(12)} ×${count}`);
				}
			}

			// Top files (by access count)
			const topFiles = Object.entries(bd.fileReadCounts)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 6);
			if (topFiles.length > 0) {
				lines.push("");
				lines.push("Most accessed files:");
				for (const [path, count] of topFiles) {
					const short = path.split("/").pop() ?? path;
					lines.push(`  ${short.padEnd(30)} ×${count}`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

const pctOf = (part: number, total: number): string =>
	total === 0 ? "0" : ((part / total) * 100).toFixed(0);
