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
	let compactStartTime = 0;
	// Inline focus set by /compact <focus> overrides loaded hints for next run.
	let inlineFocus: string | null = null;

	pi.on("session_before_compact", async (event, ctx) => {
		compactStartTime = Date.now();
		ctx.ui.setStatus("04-compact", ctx.ui.theme.fg("warning", "⏳ compacting..."));

		const focus = inlineFocus;
		inlineFocus = null;
		const hints = focus ?? loadHints(ctx.cwd);
		if (!hints) return;

		const existing = event.customInstructions ?? "";
		const header = focus ? "COMPACT FOCUS (prioritize these topics in the summary)" : "COMPACT HINTS (preserve these topics)";
		const merged = existing ? `${existing}\n\n---\n${header}:\n${hints}` : `${header}:\n${hints}`;

		return { customInstructions: merged };
	});

	pi.registerCommand("compact", {
		description: "Compact conversation. Optional inline focus: /compact preserve auth logic",
		handler: async (args, ctx) => {
			const focus = args?.trim();
			if (focus) {
				inlineFocus = focus;
				ctx.ui.notify(`Compacting with focus: ${focus}`, "info");
			} else {
				ctx.ui.notify("Compacting (using configured hints)...", "info");
			}
			ctx.compact({});
		},
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
