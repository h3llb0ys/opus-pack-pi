/**
 * /clear — wipe conversation context and start fresh.
 *
 * Unlike /compact (which summarizes), /clear nukes everything.
 * Session file is preserved — you can /tree back if needed.
 * Optionally keeps system prompt context (AGENTS.md etc).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Clear all conversation history (start fresh, session preserved)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/clear requires interactive mode.", "warning");
				return;
			}

			const choice = await ctx.ui.select("Clear context — how much?", [
				"🔥 Everything (full reset)",
				"📋 Keep system prompt, clear conversation",
				"❌ Cancel",
			]);

			if (!choice || choice === "❌ Cancel") return;

			// Use compact with empty instructions to effectively clear
			const confirmed = await ctx.ui.confirm(
				"Clear conversation?",
				"History will be compacted to nothing. Session file preserved for /tree.",
			);
			if (!confirmed) return;

			ctx.compact({
				customInstructions: choice.startsWith("🔥")
					? "DISCARD ALL previous conversation. Return only: 'Context cleared.'"
					: "DISCARD ALL conversation. Keep only the system prompt instructions. Return: 'Context cleared.'",
				onComplete: () => {
					ctx.ui.notify("✓ Context cleared. /tree to browse old history.", "info");
				},
				onError: (err) => {
					ctx.ui.notify(`Clear failed: ${err.message}`, "error");
				},
			});
		},
	});
}
