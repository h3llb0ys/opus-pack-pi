/**
 * Iteration Guard — caps runaway agent loops.
 *
 * Default cap is 40 turns per agent run; override via
 *   - opus-pack.iterationGuard.defaultCap in settings.json
 *   - --max-turns=<N> flag
 *   - PI_MAX_TURNS env var (highest priority)
 * Use /continue to extend the cap (amount: opus-pack.iterationGuard.extendBy, default 20).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

interface IterationGuardConfig {
	defaultCap: number;
	extendBy: number;
}

const DEFAULT_IG_CFG: IterationGuardConfig = { defaultCap: 40, extendBy: 20 };

const resolveDefaultCap = (): number => {
	const env = Number(process.env.PI_MAX_TURNS);
	if (Number.isFinite(env) && env > 0) return env;
	const cfg = loadOpusPackSection("iterationGuard", DEFAULT_IG_CFG);
	return cfg.defaultCap;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("iteration-guard")) return;
	pi.registerFlag("max-turns", { type: "string", description: "Hard cap on agent turns per run" });

	let cap = resolveDefaultCap();
	let count = 0;
	let extendBy = DEFAULT_IG_CFG.extendBy;

	const resolveCap = () => {
		const raw = pi.getFlag("max-turns");
		const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
		if (Number.isFinite(n) && n > 0) return n;
		return resolveDefaultCap();
	};

	pi.on("agent_start", () => {
		count = 0;
		cap = resolveCap();
		extendBy = loadOpusPackSection("iterationGuard", DEFAULT_IG_CFG).extendBy;
	});

	pi.on("turn_start", (_event, ctx) => {
		count += 1;
		if (count >= cap) {
			ctx.ui.notify(
				`iteration-guard: hit ${cap}-turn cap, aborting. /continue to extend by +${extendBy}.`,
				"warning",
			);
			ctx.abort();
		}
	});

	pi.registerCommand("continue", {
		description: "Extend max-turns cap for the current agent run",
		handler: async (_args, ctx) => {
			cap += extendBy;
			ctx.ui.notify(`iteration-guard: cap raised to ${cap}.`, "info");
		},
	});
}
