/**
 * self-recheck — single-injection second pass for weak models.
 *
 * Some providers (notably GLM 4.6 / 5.x and other budget models) produce
 * shallow first-pass output but improve when asked "did you really think
 * this through?". This extension fires that follow-up automatically when
 * the active model id matches a configured glob, using a single
 * `pi.sendUserMessage` injection. The model's reply becomes a real
 * assistant turn and lands in session history, so the LLM is aware of
 * the revised answer on subsequent turns.
 *
 * Recursion guard: a flag is set before injecting and cleared on the
 * next agent_end so the recheck turn itself never triggers another.
 *
 * Slash commands: /recheck <on|off|status|now|skip>.
 *   - now  : force one recheck on the next idle turn regardless of model
 *   - skip : suppress recheck for the next turn (one-shot opt-out)
 *
 * The opus-pack:recheck:completed event is emitted on the agent_end of
 * the recheck turn so plan-mode can defer its dialog until after.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";
import {
	recheckState,
	resetRecheckState,
	matchesAny,
	lastAssistantTextLength,
	type SelfRecheckConfig,
} from "../lib/self-recheck-state.js";

const DEFAULT_PROMPT = [
	"Review your previous answer against my original prompt.",
	"",
	"Step 1. Re-read my original prompt. Identify every constraint, filter, requirement, and emphasized phrase in it — including the subjective and qualitative ones.",
	"",
	"Step 2. Go through your previous answer item by item. For each item, decide:",
	"- KEEP — it satisfies every relevant constraint",
	"- DROP — it violates a constraint, is irrelevant, redundant, or just filler",
	"- FIX — it's mostly right but needs a correction (factual, depth, scope)",
	"",
	"Step 3. If anything required by my prompt is missing from your answer, add it.",
	"",
	"Step 4. Output the full revised answer, clean top-to-bottom, as if it were your first reply. No preamble, no defect list, no 'here is the corrected version' framing, no meta-commentary on what you changed. Length is not a virtue — a short answer that satisfies the prompt beats a long one that doesn't.",
	"",
	"If after honest review nothing needs to change, simply repeat your previous answer verbatim.",
].join("\n");

const DEFAULT_CONFIG: SelfRecheckConfig = {
	enabled: false,
	models: [],
	prompt: DEFAULT_PROMPT,
	minAssistantChars: 200,
	maxPerSession: 0,
};

const loadConfig = (): SelfRecheckConfig => loadOpusPackSection("selfRecheck", DEFAULT_CONFIG);

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("self-recheck")) return;

	pi.on("session_start", async (_event, _ctx) => {
		resetRecheckState();
	});

	pi.on("agent_end", async (event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.enabled && !recheckState.forceNext) return;

		// Recheck turn just finished — clear flag, emit completion, return.
		if (recheckState.inRecheckTurn) {
			recheckState.inRecheckTurn = false;
			recheckState.lastDecision = "recheck turn finished";
			pi.events.emit("opus-pack:recheck:completed", { event, ctx, outcome: "corrected" });
			return;
		}

		if (recheckState.pausedByUser) {
			recheckState.lastDecision = "paused";
			return;
		}

		if (recheckState.skipNext) {
			recheckState.skipNext = false;
			recheckState.lastDecision = "skipped (one-shot)";
			ctx.ui.notify("self-recheck: skipped this turn", "info");
			return;
		}

		if (!recheckState.forceNext && cfg.maxPerSession > 0 && recheckState.countThisSession >= cfg.maxPerSession) {
			recheckState.lastDecision = `cap reached (${cfg.maxPerSession})`;
			return;
		}

		const modelId = ctx.model?.id ?? "";
		const matched = recheckState.forceNext || (modelId !== "" && matchesAny(modelId, cfg.models));
		if (!matched) {
			recheckState.lastDecision = `no match (${modelId || "?"})`;
			return;
		}

		const textLen = lastAssistantTextLength(event.messages ?? []);
		if (!recheckState.forceNext && textLen < cfg.minAssistantChars) {
			recheckState.lastDecision = `too short (${textLen} < ${cfg.minAssistantChars})`;
			return;
		}

		// Fire. Mark BEFORE the call so plan-mode's synchronous peek sees
		// the in-flight flag.
		recheckState.inRecheckTurn = true;
		const wasForced = recheckState.forceNext;
		recheckState.forceNext = false;
		recheckState.countThisSession++;

		recheckState.lastDecision = `fired (${modelId}${wasForced ? ", forced" : ""}, #${recheckState.countThisSession})`;

		try {
			pi.sendUserMessage(cfg.prompt, { deliverAs: "followUp" });
		} catch (e) {
			recheckState.inRecheckTurn = false;
			recheckState.countThisSession = Math.max(0, recheckState.countThisSession - 1);
			ctx.ui.notify(`self-recheck: sendUserMessage failed — ${(e as Error).message}`, "error");
		}
	});

	pi.registerCommand("recheck", {
		description: "Self-recheck: /recheck <on|off|status|now|skip>",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			const arg = (args ?? "").trim().toLowerCase();
			if (!arg || arg === "status") {
				const modelId = ctx.model?.id ?? "(no model)";
				const matchNow = modelId !== "(no model)" && matchesAny(modelId, cfg.models);
				ctx.ui.notify([
					"═ self-recheck status ═",
					`enabled:        ${cfg.enabled}`,
					`paused:         ${recheckState.pausedByUser}`,
					`in-flight:      ${recheckState.inRecheckTurn}`,
					`current model:  ${modelId}`,
					`would fire:     ${matchNow ? "yes" : "no"}  (globs: ${cfg.models.join(", ") || "(none)"})`,
					`min chars:      ${cfg.minAssistantChars}`,
					`cap/session:    ${cfg.maxPerSession || "∞"}   used: ${recheckState.countThisSession}`,
					`pending flags:  ${recheckState.forceNext ? "force-next " : ""}${recheckState.skipNext ? "skip-next " : ""}${(recheckState.forceNext || recheckState.skipNext) ? "" : "(none)"}`,
					`last decision:  ${recheckState.lastDecision || "(none yet)"}`,
				].join("\n"), "info");
				return;
			}
			if (arg === "on") { recheckState.pausedByUser = false; ctx.ui.notify("self-recheck: resumed", "info"); return; }
			if (arg === "off" || arg === "pause") {
				recheckState.pausedByUser = true;
				ctx.ui.notify("self-recheck: paused for this session", "info");
				return;
			}
			if (arg === "now") {
				recheckState.forceNext = true;
				ctx.ui.notify("self-recheck: will fire on next turn (forced)", "info");
				return;
			}
			if (arg === "skip") {
				recheckState.skipNext = true;
				ctx.ui.notify("self-recheck: next turn will be skipped", "info");
				return;
			}
			ctx.ui.notify(`unknown arg "${arg}". Use: on | off | status | now | skip`, "warning");
		},
	});
}
