/**
 * Iteration Guard — caps runaway agent loops.
 *
 * Default cap is 40 turns per agent run; override via --max-turns=<N> or env PI_MAX_TURNS.
 * Use /continue to extend the cap by +20 once hit.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

const DEFAULT_CAP = Number(process.env.PI_MAX_TURNS ?? 40);

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("iteration-guard")) return;
	pi.registerFlag("max-turns", { type: "string", description: "Hard cap on agent turns per run" });

	let cap = DEFAULT_CAP;
	let count = 0;

	const resolveCap = () => {
		const raw = pi.getFlag("max-turns");
		const n = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
		return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
	};

	pi.on("agent_start", () => {
		count = 0;
		cap = resolveCap();
	});

	pi.on("turn_start", (_event, ctx) => {
		count += 1;
		if (count >= cap) {
			ctx.ui.notify(
				`iteration-guard: hit ${cap}-turn cap, aborting. /continue to extend by +20.`,
				"warning",
			);
			ctx.abort();
		}
	});

	pi.registerCommand("continue", {
		description: "Extend max-turns cap by +20 for the current agent run",
		handler: async (_args, ctx) => {
			cap += 20;
			ctx.ui.notify(`iteration-guard: cap raised to ${cap}.`, "info");
		},
	});
}
