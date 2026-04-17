/**
 * Smart Compact — custom compaction hints.
 *
 * Reads compact-hints from settings.json or .pi/compact-hints.md.
 * Injects them as custom instructions into the compaction prompt.
 * Shows token savings notification after compact.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

	// settings.json opus-pack.compactHints
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		const hints = parsed?.["opus-pack"]?.["compactHints"];
		if (typeof hints === "string" && hints.trim()) return hints.trim();
		if (Array.isArray(hints)) return hints.filter((h: unknown) => typeof h === "string").join("\n");
	} catch { /* ignore */ }

	return null;
};

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const hints = loadHints(ctx.cwd);
		if (!hints) return;

		const existing = event.customInstructions ?? "";
		const merged = existing
			? `${existing}\n\n---\nCOMPACT HINTS (preserve these topics):\n${hints}`
			: `COMPACT HINTS (preserve these topics in the summary):\n${hints}`;

		return { customInstructions: merged };
	});

	pi.on("session_compact", async (event, ctx) => {
		if (event.fromExtension) return;
		const compaction = event.compactionEntry;
		if (!compaction) return;

		const tokensBefore = compaction.tokensBefore ?? 0;
		const summaryLen = typeof compaction.summary === "string" ? compaction.summary.length : 0;
		ctx.ui.notify(
			`Compaction done: ${tokensBefore.toLocaleString()} tokens before, ~${summaryLen.toLocaleString()} chars summary.`,
			"info",
		);
	});
}
