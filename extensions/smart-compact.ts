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
import { loadSettingsRoot } from "../lib/settings.js";

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

export default function (pi: ExtensionAPI) {
	let compactStartTime = 0;

	// The built-in /compact [focus] slash already forwards `focus` as
	// event.customInstructions. We just merge configured hints with whatever
	// the user typed, so both sources land in the compaction prompt.
	pi.on("session_before_compact", async (event, ctx) => {
		compactStartTime = Date.now();
		ctx.ui.setStatus("04-compact", ctx.ui.theme.fg("warning", "⏳ compacting..."));

		const hints = loadHints(ctx.cwd);
		if (!hints) return;

		const existing = event.customInstructions?.trim() ?? "";
		const header = existing ? "COMPACT HINTS (also preserve)" : "COMPACT HINTS (preserve these topics)";
		const merged = existing ? `${existing}\n\n---\n${header}:\n${hints}` : `${header}:\n${hints}`;
		return { customInstructions: merged };
	});

	pi.on("session_compact", async (event, ctx) => {
		ctx.ui.setStatus("04-compact", undefined);
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
