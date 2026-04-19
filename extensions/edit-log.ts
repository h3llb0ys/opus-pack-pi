/**
 * edit-log — on-demand history of edits made in this session.
 *
 * Keeps an in-memory map filepath → { tool, ts, snippet } so the user (or
 * the model via /edit-log) can see "what did we change so far?" without
 * rereading every file. Nothing is auto-injected into the system prompt
 * on every turn — that would burn tokens all session for a rarely-needed
 * view. Call /edit-log when you want the answer.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

interface LogEntry {
	tool: "edit" | "write";
	ts: number;
	snippet: string;
}

const MAX_SNIPPET_CHARS = 120;
const MAX_FILES = 200;

const fmtAgo = (ts: number): string => {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
};

const extractEditSnippet = (input: unknown): string => {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	const edits = obj.edits as Array<{ oldText?: string; newText?: string }> | undefined;
	if (Array.isArray(edits) && edits.length > 0) {
		const first = edits[0];
		const newFirstLine = String(first.newText ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
		return newFirstLine.trim().slice(0, MAX_SNIPPET_CHARS);
	}
	const newText = String(obj.newText ?? "");
	if (newText) {
		const firstLine = newText.split("\n").find((l) => l.trim().length > 0) ?? "";
		return firstLine.trim().slice(0, MAX_SNIPPET_CHARS);
	}
	return "";
};

const extractWriteSnippet = (input: unknown): string => {
	if (!input || typeof input !== "object") return "";
	const content = String((input as { content?: string }).content ?? "");
	if (!content) return "(empty)";
	const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
	const lineCount = content.split("\n").length;
	return `${firstLine.trim().slice(0, MAX_SNIPPET_CHARS - 20)} (${lineCount} lines)`;
};

const extractPath = (input: unknown): string => {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	return String(obj.path ?? obj.file_path ?? "");
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("edit-log")) return;

	// filepath → latest entry for that path. Multiple edits collapse to the
	// most recent + a counter. Capped at MAX_FILES — oldest entries drop
	// first so an ultra-long session can't grow the map without bound.
	const log = new Map<string, LogEntry & { count: number }>();

	const recordEntry = (path: string, tool: "edit" | "write", snippet: string) => {
		const prev = log.get(path);
		log.delete(path);
		log.set(path, { tool, ts: Date.now(), snippet, count: (prev?.count ?? 0) + 1 });
		while (log.size > MAX_FILES) {
			const oldest = log.keys().next().value;
			if (oldest === undefined) break;
			log.delete(oldest);
		}
	};

	pi.on("session_start", () => {
		log.clear();
	});

	pi.on("tool_result", async (event) => {
		if (event.isError) return;
		const path = extractPath(event.input);
		if (!path) return;
		if (event.toolName === "edit") {
			recordEntry(path, "edit", extractEditSnippet(event.input));
			return;
		}
		if (event.toolName === "write") {
			recordEntry(path, "write", extractWriteSnippet(event.input));
		}
	});

	pi.registerCommand("edit-log", {
		description: "Show which files were edited or written in this session",
		handler: async (_args, ctx) => {
			if (log.size === 0) {
				ctx.ui.notify("(no edits or writes in this session)", "info");
				return;
			}
			const rows = [...log.entries()]
				.sort((a, b) => b[1].ts - a[1].ts)
				.map(([path, entry]) => {
					const countSuffix = entry.count > 1 ? ` ×${entry.count}` : "";
					return `${entry.tool.padEnd(5)} ${fmtAgo(entry.ts).padEnd(10)} ${path}${countSuffix}${entry.snippet ? `\n        ${entry.snippet}` : ""}`;
				});
			ctx.ui.notify([`═ edit log (${log.size} files) ═`, "", ...rows].join("\n"), "info");
		},
	});
}
