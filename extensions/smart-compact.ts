/**
 * Smart Compact — custom compaction hints + session-scoped advisor.
 *
 * Two sources of hints are merged into the compaction prompt:
 *   1. Static hints: .pi/compact-hints.md, ~/.pi/agent/compact-hints.md,
 *      or opus-pack.compactHints in settings.json.
 *   2. Dynamic session log: files the agent edited/wrote and bash commands
 *      that exited non-zero since the session started. Compactor gets a
 *      "what this session was actually doing" summary so it doesn't drop
 *      the active refactor context.
 *
 * The dynamic log is capped at 30 entries per kind and 4KB total so the
 * compaction prompt doesn't balloon. Older entries drop first (FIFO).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadSettingsRoot } from "../lib/settings.js";

const loadHints = (cwd: string): string | null => {
	// Project-local .pi/compact-hints.md
	const localPath = join(cwd, ".pi/compact-hints.md");
	if (existsSync(localPath)) {
		try { return readFileSync(localPath, "utf8").trim(); } catch { /* ignore */ }
	}

	// Global ~/.pi/agent/compact-hints.md
	const globalPath = join(homedir(), ".pi/agent/compact-hints.md");
	if (existsSync(globalPath)) {
		try { return readFileSync(globalPath, "utf8").trim(); } catch { /* ignore */ }
	}

	// settings.json opus-pack.compactHints (mtime-cached through lib/settings)
	const parsed = loadSettingsRoot();
	const hints = parsed?.["opus-pack"]?.["compactHints"];
	if (typeof hints === "string" && hints.trim()) return hints.trim();
	if (Array.isArray(hints)) return hints.filter((h: unknown) => typeof h === "string").join("\n");

	return null;
};

interface EditLogEntry { tool: string; path: string; ts: number }
interface ErrorLogEntry { command: string; snippet: string; ts: number }

const MAX_EDITS = 30;
const MAX_ERRORS = 15;
const MAX_ADVISOR_CHARS = 4_000;

const extractPath = (input: unknown): string => {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	return String(obj.path ?? obj.file_path ?? "");
};

const extractErrorSnippet = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = String((part as { text?: string }).text ?? "");
			if (!text) continue;
			// First non-empty line, trimmed to 140 chars.
			const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
			return firstLine.trim().slice(0, 140);
		}
	}
	return "";
};

const formatAdvisor = (edits: EditLogEntry[], errors: ErrorLogEntry[]): string | null => {
	const lines: string[] = [];
	if (edits.length > 0) {
		lines.push("Recently touched files (preserve knowledge of what was changed):");
		for (const e of edits.slice(-MAX_EDITS)) {
			lines.push(`  ${e.tool.padEnd(5)} ${e.path}`);
		}
	}
	if (errors.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Recent failing commands (preserve these errors — active work):");
		for (const e of errors.slice(-MAX_ERRORS)) {
			lines.push(`  $ ${e.command.slice(0, 80)}`);
			if (e.snippet) lines.push(`    ${e.snippet}`);
		}
	}
	if (lines.length === 0) return null;
	const joined = lines.join("\n");
	return joined.length > MAX_ADVISOR_CHARS ? joined.slice(-MAX_ADVISOR_CHARS) : joined;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("smart-compact")) return;
	let compactStartTime = 0;

	// Session-scoped activity log. Resets after compaction so the advisor
	// doesn't keep reinjecting the same "was touched" info after the
	// compacted summary already captured it.
	let edits: EditLogEntry[] = [];
	let errors: ErrorLogEntry[] = [];

	pi.on("session_start", () => {
		edits = [];
		errors = [];
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			const path = extractPath(event.input);
			if (path) {
				edits.push({ tool: event.toolName, path, ts: Date.now() });
				if (edits.length > MAX_EDITS * 2) edits = edits.slice(-MAX_EDITS);
			}
			return;
		}
		if (event.toolName === "bash" && event.isError) {
			const command = String((event.input as { command?: string }).command ?? "").trim();
			const snippet = extractErrorSnippet(event.content);
			if (command) {
				errors.push({ command, snippet, ts: Date.now() });
				if (errors.length > MAX_ERRORS * 2) errors = errors.slice(-MAX_ERRORS);
			}
		}
	});

	// The built-in /compact [focus] slash already forwards `focus` as
	// event.customInstructions. We merge configured hints + the
	// session-scoped advisor into whatever the user typed so everything
	// lands in the compaction prompt.
	pi.on("session_before_compact", async (event, ctx) => {
		compactStartTime = Date.now();
		ctx.ui.setStatus("04-compact", ctx.ui.theme.fg("warning", "⏳ compacting..."));

		const configured = loadHints(ctx.cwd);
		const advisor = formatAdvisor(edits, errors);
		if (!configured && !advisor) return;

		const parts: string[] = [];
		const existing = event.customInstructions?.trim() ?? "";
		if (existing) parts.push(existing);
		if (configured) {
			parts.push((existing || advisor ? "COMPACT HINTS (also preserve)" : "COMPACT HINTS (preserve these topics)") + ":\n" + configured);
		}
		if (advisor) {
			parts.push("SESSION ADVISOR (preserve this ongoing work):\n" + advisor);
		}
		return { customInstructions: parts.join("\n\n---\n") };
	});

	pi.on("session_compact", async (event, ctx) => {
		ctx.ui.setStatus("04-compact", undefined);
		// Drop the session advisor after a successful compact — the summary
		// now carries the context, no point reinjecting.
		edits = [];
		errors = [];
		if (event.fromExtension) return;
		const compaction = event.compactionEntry;
		if (!compaction) return;

		const elapsed = ((Date.now() - compactStartTime) / 1000).toFixed(1);
		const tokensBefore = compaction.tokensBefore ?? 0;
		const summaryLen = typeof compaction.summary === "string" ? compaction.summary.length : 0;
		ctx.ui.notify(
			`✓ Compacted in ${elapsed}s: ${tokensBefore.toLocaleString()} tokens → ~${summaryLen.toLocaleString()} chars summary.`,
			"info",
		);
	});
}
