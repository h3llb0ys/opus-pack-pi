/**
 * Auto-Continue — skip manual "continue?" prompts.
 *
 * When the agent stops with max_tokens or tool_use and there are
 * pending tool results or incomplete work, automatically sends
 * a continue message instead of waiting for user input.
 *
 * Config in settings.json: opus-pack.autoContinue
 *   { "enabled": true, "maxAutoContinues": 10 }
 *
 * maxAutoContinues: safety cap on auto-continues per agent run (default: 10).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface AutoContinueConfig {
	enabled: boolean;
	maxAutoContinues: number;
}

const DEFAULT_CONFIG: AutoContinueConfig = { enabled: true, maxAutoContinues: 10 };

const loadConfig = (): AutoContinueConfig => {
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		const cfg = parsed?.["opus-pack"]?.["autoContinue"];
		if (!cfg || typeof cfg !== "object") return DEFAULT_CONFIG;
		return {
			enabled: cfg.enabled ?? DEFAULT_CONFIG.enabled,
			maxAutoContinues: cfg.maxAutoContinues ?? DEFAULT_CONFIG.maxAutoContinues,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
};

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	if (!config.enabled) return;

	let autoContinueCount = 0;

	pi.on("agent_start", async () => {
		autoContinueCount = 0;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (autoContinueCount >= config.maxAutoContinues) return;

		// Check if agent stopped with pending tool calls or hit max_tokens
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		// Find last assistant message
		const lastAssistant = [...messages].reverse().find((m: { role?: string }) => m.role === "assistant");
		if (!lastAssistant) return;

		const stopReason = (lastAssistant as { stopReason?: string }).stopReason;

		// Auto-continue if stopped due to max_tokens (output length limit)
		if (stopReason === "max_tokens" || stopReason === "end_turn") {
			// Check if there are unfinished tool calls
			const content = (lastAssistant as { content?: Array<{ type?: string }> }).content;
			if (!Array.isArray(content)) return;

			const hasToolCalls = content.some((part: { type?: string }) => part.type === "toolCall");
			if (!hasToolCalls && stopReason !== "max_tokens") return;

			autoContinueCount++;
			pi.sendUserMessage("continue", { deliverAs: "steer" });
		}
	});
}
