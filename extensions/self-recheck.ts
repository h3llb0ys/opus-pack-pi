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
 * Recursion guard: a flag is set before injecting and cleared on the
 * next agent_end so the recheck turn itself never triggers another
 * recheck.
 *
 * Slash commands: /recheck <on|off|status|now|skip>.
 *   - now  : force one recheck on the next idle turn regardless of model
 *   - skip : suppress recheck for the next turn (one-shot opt-out)
 *
 * Independent of model-router by design — that one chooses *which* model
 * runs, this one decides whether to ask the chosen model to second-guess
 * itself. See README in extensions/.
 */

import { minimatch } from "minimatch";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

interface SelfRecheckConfig {
	enabled: boolean;
	models: string[];           // glob list, e.g. ["glm-*", "*qwen*", "deepseek*"]
	prompt: string;             // the critique prompt sent as follow-up
	minAssistantChars: number;  // skip recheck if last assistant text shorter than this
	maxPerSession: number;      // 0 = unlimited
}

const DEFAULT_PROMPT = [
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
	prompt: DEFAULT_PROMPT,
	minAssistantChars: 200,
	maxPerSession: 0,
};

const loadConfig = (): SelfRecheckConfig => loadOpusPackSection("selfRecheck", DEFAULT_CONFIG);

const matchesAny = (modelId: string, globs: string[]): boolean =>
	globs.some((g) => {
		try { return minimatch(modelId, g, { nocase: true }); } catch { return false; }
	});

const lastAssistantTextLength = (messages: any[]): number => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content.length;
		if (Array.isArray(content)) {
			let n = 0;
			for (const part of content) {
				if (part && part.type === "text" && typeof part.text === "string") n += part.text.length;
			}
			return n;
		}
		return 0;
	}
	return 0;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("self-recheck")) return;

	let pausedByUser = false;
	let inRecheckTurn = false;     // set when we just injected a follow-up; cleared on next agent_end
	let forceNext = false;         // /recheck now
	let skipNext = false;          // /recheck skip
	let countThisSession = 0;
	let lastDecision = "";

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setStatus("07-recheck", text);
	};

	pi.on("session_start", async (_event, _ctx) => {
		// Per-session counters reset; transient flags do not survive a
		// new session anyway, but reset them defensively.
		countThisSession = 0;
		inRecheckTurn = false;
		forceNext = false;
		skipNext = false;
		lastDecision = "";
	});

	pi.on("agent_end", async (event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.enabled && !forceNext) {
			setStatus(ctx, undefined);
			return;
		}

		// Clear the flag if the just-finished turn WAS the recheck turn we
		// injected. Don't fire again — that would be infinite recursion.
		if (inRecheckTurn) {
			inRecheckTurn = false;
			lastDecision = "recheck turn finished";
			setStatus(ctx, ctx.ui.theme.fg("muted", "✓ rechecked"));
			return;
		}

		if (pausedByUser) {
			lastDecision = "paused";
			return;
		}

		if (skipNext) {
			skipNext = false;
			lastDecision = "skipped (one-shot)";
			ctx.ui.notify("self-recheck: skipped this turn", "info");
			return;
		}

		// Cap blocks auto-fires only — `/recheck now` is an explicit user
		// request and should always go through.
		if (!forceNext && cfg.maxPerSession > 0 && countThisSession >= cfg.maxPerSession) {
			lastDecision = `cap reached (${cfg.maxPerSession})`;
			return;
		}

		const modelId = ctx.model?.id ?? "";
		const matched = forceNext || (modelId !== "" && matchesAny(modelId, cfg.models));
		if (!matched) {
			lastDecision = `no match (${modelId || "?"})`;
			return;
		}

		const textLen = lastAssistantTextLength(event.messages ?? []);
		if (!forceNext && textLen < cfg.minAssistantChars) {
			lastDecision = `too short (${textLen} < ${cfg.minAssistantChars})`;
			return;
		}

		// Fire the follow-up. Mark the flag BEFORE the call to win any race
		// with synchronous handlers that might observe agent state.
		inRecheckTurn = true;
		const wasForced = forceNext;
		forceNext = false;
		countThisSession++;
		lastDecision = `fired (${modelId}${wasForced ? ", forced" : ""}, #${countThisSession})`;
		setStatus(ctx, ctx.ui.theme.fg("accent", `↻ recheck`));
		ctx.ui.notify(`↻ self-recheck: asking ${modelId || "model"} to review its answer`, "info");
		try {
			pi.sendUserMessage(cfg.prompt, { deliverAs: "followUp" });
		} catch (e) {
			inRecheckTurn = false;
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
					`paused:         ${pausedByUser}`,
					`current model:  ${modelId}`,
					`would fire:     ${matchNow ? "yes" : "no"}  (globs: ${cfg.models.join(", ") || "(none)"})`,
					`min chars:      ${cfg.minAssistantChars}`,
					`cap/session:    ${cfg.maxPerSession || "∞"}   used: ${countThisSession}`,
					`pending flags:  ${forceNext ? "force-next " : ""}${skipNext ? "skip-next " : ""}${(forceNext || skipNext) ? "" : "(none)"}`,
					`last decision:  ${lastDecision || "(none yet)"}`,
				].join("\n"), "info");
				return;
			}
			if (arg === "on") { pausedByUser = false; ctx.ui.notify("self-recheck: resumed", "info"); return; }
			if (arg === "off" || arg === "pause") {
				pausedByUser = true;
				setStatus(ctx, ctx.ui.theme.fg("warning", "recheck off"));
				ctx.ui.notify("self-recheck: paused for this session", "info");
				return;
			}
			if (arg === "now") {
				forceNext = true;
				ctx.ui.notify("self-recheck: will fire on next turn (forced, ignores model match)", "info");
				return;
			}
			if (arg === "skip") {
				skipNext = true;
				ctx.ui.notify("self-recheck: next turn will be skipped", "info");
				return;
			}
			ctx.ui.notify(`unknown arg "${arg}". Use: on | off | status | now | skip`, "warning");
		},
	});
}
