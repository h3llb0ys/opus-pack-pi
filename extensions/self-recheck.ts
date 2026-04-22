/**
 * self-recheck — auto-injects a self-critique follow-up turn for weak models.
 *
 * Some providers (notably GLM 4.6 / 5.x and other budget models) produce
 * shallow first-pass output but improve significantly on a "review your
 * own answer" second pass. This extension fires that second pass
 * automatically when the active model id matches a configured glob,
 * using `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` after
 * `agent_end`.
 *
 * Two-stage flow (default):
 *   stage "defects"   — inject DEFECTS_PROMPT, model produces a defect list
 *                       only (or "no defects found")
 *   stage "corrected" — inject CORRECTED_PROMPT, model produces the revised
 *                       answer only; skipped if stage 1 said "no defects"
 *
 * This gives two separate assistant messages in the transcript (defects
 * first, then the corrected answer), instead of both being crammed into one
 * turn. Set `opus-pack.selfRecheck.twoStage = false` (or provide a custom
 * `prompt`) to fall back to the legacy single-stage behavior.
 *
 * Recursion guard: stage is tracked in shared state and cleared on agent_end
 * of the corrected turn so the recheck itself never triggers another.
 *
 * Slash commands: /recheck <on|off|status|now|skip>.
 *   - now  : force one recheck on the next idle turn regardless of model
 *   - skip : suppress recheck for the next turn (one-shot opt-out)
 *
 * Independent of model-router by design — that one chooses *which* model
 * runs, this one decides whether to ask the chosen model to second-guess
 * itself.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";
import {
	recheckState,
	resetRecheckState,
	matchesAny,
	lastAssistantText,
	lastAssistantTextLength,
	type SelfRecheckConfig,
} from "../lib/self-recheck-state.js";

// Exact-match on the whole trimmed reply — avoids false positives when a
// model writes "no defects found in section 2" as part of a longer answer.
const isNoDefectsReply = (text: string): boolean => {
	const t = text.trim().toLowerCase();
	return t === "no defects found" || t === "no defects found.";
};

const DEFECTS_PROMPT = [
	"Critique your own previous answer. Be strict, no hedging.",
	"",
	"1. Correctness: which claims are unverified? Where did you guess instead of checking? Mentally walk edge cases (empty input, errors, concurrency, boundaries).",
	"2. Completeness: what part of the original request did you miss? Which scenario is not covered?",
	"3. Depth: where is the answer shallow? Where did you say WHAT instead of WHY?",
	"4. Code (if any was produced): does it compile? Types correct? Do the imports actually exist? Any race / leak / off-by-one? Is a regression test needed?",
	"",
	"Output ONLY a numbered list of concrete defects — 'line Y does Z, should be W', not vague 'could be improved'. Do NOT rewrite the answer in this turn; the revised version comes in a separate follow-up.",
	"",
	"If you find no real defects, reply with exactly: no defects found",
].join("\n");

const CORRECTED_PROMPT = [
	"Now produce the corrected, improved version of your previous answer, incorporating the defects you just listed.",
	"",
	"Output ONLY the revised answer — no preamble, no restating of defects, no meta-commentary. Treat this as the final answer the user will actually use.",
].join("\n");

// Kept for back-compat: if a user has a custom `prompt` set in settings, we
// honor it via the legacy single-stage path.
const LEGACY_DEFAULT_PROMPT = [
	"Critique your own previous answer. Be strict, no hedging.",
	"",
	"1. Correctness: which claims are unverified? Where did you guess instead of checking? Mentally walk edge cases (empty input, errors, concurrency, boundaries).",
	"2. Completeness: what part of the original request did you miss? Which scenario is not covered?",
	"3. Depth: where is the answer shallow? Where did you say WHAT instead of WHY?",
	"4. Code (if any was produced): does it compile? Types correct? Do the imports actually exist? Any race / leak / off-by-one? Is a regression test needed?",
	"",
	"Output:",
	"  (a) Numbered list of concrete defects — not 'X could be improved' but 'line Y does Z, should be W'.",
	"  (b) The corrected version of the answer.",
	"",
	"If you find no real defects, say exactly 'no defects found' and do not rewrite anything.",
].join("\n");

const DEFAULT_CONFIG: SelfRecheckConfig = {
	enabled: false,
	models: [],
	prompt: "",                           // empty => use two-stage
	defectsPrompt: DEFECTS_PROMPT,
	correctedPrompt: CORRECTED_PROMPT,
	minAssistantChars: 200,
	maxPerSession: 0,
	twoStage: true,
};

const loadConfig = (): SelfRecheckConfig => loadOpusPackSection("selfRecheck", DEFAULT_CONFIG);

// Use two-stage when enabled AND the user didn't override with a custom single-stage prompt.
const useTwoStage = (cfg: SelfRecheckConfig): boolean => {
	if (!cfg.twoStage) return false;
	const custom = (cfg.prompt ?? "").trim();
	if (!custom) return true;
	// Back-compat: treat the old baked-in default as "no override".
	return custom === LEGACY_DEFAULT_PROMPT.trim();
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("self-recheck")) return;

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setStatus("07-recheck", text);
	};

	pi.on("session_start", async (_event, _ctx) => {
		resetRecheckState();
	});

	pi.on("agent_end", async (event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.enabled && !recheckState.forceNext) {
			setStatus(ctx, undefined);
			return;
		}

		// --- Two-stage continuation ---------------------------------------
		if (recheckState.stage === "defects") {
			const lastText = lastAssistantText(event.messages ?? []);
			if (isNoDefectsReply(lastText)) {
				recheckState.stage = "none";
				recheckState.inRecheckTurn = false;
				recheckState.lastDecision = "no defects found (stage 1)";
				setStatus(ctx, ctx.ui.theme.fg("muted", "✓ no defects"));
				pi.events.emit("opus-pack:recheck:completed", { event, ctx, outcome: "no-defects" });
				return;
			}
			// Proceed to corrected stage. Keep inRecheckTurn true.
			recheckState.stage = "corrected";
			recheckState.lastDecision = "defects listed, requesting corrected version";
			setStatus(ctx, ctx.ui.theme.fg("accent", "↻ corrected…"));
			ctx.ui.notify("↻ self-recheck: asking for corrected version", "info");
			try {
				pi.sendUserMessage(cfg.correctedPrompt, { deliverAs: "followUp" });
			} catch (e) {
				recheckState.inRecheckTurn = false;
				recheckState.stage = "none";
				ctx.ui.notify(`self-recheck: sendUserMessage failed — ${(e as Error).message}`, "error");
				pi.events.emit("opus-pack:recheck:completed", { event, ctx, outcome: "failed" });
			}
			return;
		}

		if (recheckState.stage === "corrected") {
			recheckState.stage = "none";
			recheckState.inRecheckTurn = false;
			recheckState.lastDecision = "corrected version delivered";
			setStatus(ctx, ctx.ui.theme.fg("muted", "✓ rechecked"));
			pi.events.emit("opus-pack:recheck:completed", { event, ctx, outcome: "corrected" });
			return;
		}

		// Legacy single-stage continuation.
		if (recheckState.inRecheckTurn) {
			recheckState.inRecheckTurn = false;
			recheckState.lastDecision = "recheck turn finished";
			setStatus(ctx, ctx.ui.theme.fg("muted", "✓ rechecked"));
			pi.events.emit("opus-pack:recheck:completed", { event, ctx, outcome: "legacy" });
			return;
		}

		// --- Initial firing decision --------------------------------------
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

		// Fire. Mark state BEFORE the call so any synchronous observer sees it.
		recheckState.inRecheckTurn = true;
		const wasForced = recheckState.forceNext;
		recheckState.forceNext = false;
		recheckState.countThisSession++;

		const twoStage = useTwoStage(cfg);
		const firstPrompt = twoStage ? cfg.defectsPrompt : cfg.prompt;
		recheckState.stage = twoStage ? "defects" : "none";

		recheckState.lastDecision = `fired (${modelId}${wasForced ? ", forced" : ""}, ${twoStage ? "2-stage" : "1-stage"}, #${recheckState.countThisSession})`;
		setStatus(ctx, ctx.ui.theme.fg("accent", twoStage ? "↻ defects…" : "↻ recheck"));
		ctx.ui.notify(
			`↻ self-recheck: asking ${modelId || "model"} to ${twoStage ? "list defects" : "review its answer"}`,
			"info",
		);
		try {
			pi.sendUserMessage(firstPrompt, { deliverAs: "followUp" });
		} catch (e) {
			recheckState.inRecheckTurn = false;
			recheckState.stage = "none";
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
				const mode = useTwoStage(cfg) ? "two-stage (defects + corrected)" : "single-stage";
				ctx.ui.notify([
					"═ self-recheck status ═",
					`enabled:        ${cfg.enabled}`,
					`mode:           ${mode}`,
					`paused:         ${recheckState.pausedByUser}`,
					`current stage:  ${recheckState.stage}`,
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
				setStatus(ctx, ctx.ui.theme.fg("warning", "recheck off"));
				ctx.ui.notify("self-recheck: paused for this session", "info");
				return;
			}
			if (arg === "now") {
				recheckState.forceNext = true;
				ctx.ui.notify("self-recheck: will fire on next turn (forced, ignores model match)", "info");
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
