/**
 * model-router — context-aware model and thinking-level switcher.
 *
 * Heuristic routing: on before_agent_start the prompt is matched against
 * user-defined rules → a level is chosen → pi.setModel + pi.setThinkingLevel
 * are called for the upcoming turn. Provider-agnostic: the user supplies
 * the provider + model id explicitly in settings.json, so Ollama / OpenAI /
 * custom proxies work the same as Anthropic.
 *
 * Slash commands: /router <level|on|off|status>.
 * Status slot 06-router shows the current decision persistently.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model, ThinkingLevel } from "@mariozechner/pi-ai";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

interface LevelConfig {
	provider?: string;
	model: string;
	thinking: ThinkingLevel;
}

interface RouterRule {
	match?: string;
	minChars?: number;
	pathTouches?: string;
	level: string;
}

interface RouterConfig {
	enabled: boolean;
	default: string;
	autoBumpAfterTurns: number;
	levels: Record<string, LevelConfig>;
	rules: RouterRule[];
}

const DEFAULT_CONFIG: RouterConfig = {
	enabled: false,
	default: "medium",
	autoBumpAfterTurns: 0,
	levels: {},
	rules: [],
};

interface Decision {
	ts: number;
	level: string;
	modelId: string;
	thinking: ThinkingLevel;
	matchedRule: string; // "default" | "override" | "rule:<index>" | "minChars" | "autoBump"
	promptSnippet: string;
}

const MAX_LOG = 20;

interface CompiledRule {
	match?: RegExp;
	minChars?: number;
	pathTouches?: RegExp;
	level: string;
}

const safeCompile = (pattern: string | undefined, flags: string): RegExp | undefined => {
	if (!pattern) return undefined;
	try { return new RegExp(pattern, flags); } catch { return undefined; }
};

const compileRules = (rules: RouterRule[]): CompiledRule[] =>
	rules.map((r) => ({
		match: safeCompile(r.match, "i"),
		minChars: r.minChars,
		pathTouches: safeCompile(r.pathTouches, "i"),
		level: r.level,
	}));

// Cache compiled rules while the config is stable. loadOpusPackSection
// returns a fresh object via spread on every call, so we key the cache on
// the JSON stringification of the raw rules — cheap for <=30 items and
// invalidates automatically when the user edits settings.json.
let lastRulesKey = "";
let lastCompiled: CompiledRule[] = [];

const getCompiledRules = (cfg: RouterConfig): CompiledRule[] => {
	const key = JSON.stringify(cfg.rules);
	if (key === lastRulesKey) return lastCompiled;
	lastCompiled = compileRules(cfg.rules);
	lastRulesKey = key;
	return lastCompiled;
};

const loadConfig = (): RouterConfig => loadOpusPackSection("modelRouter", DEFAULT_CONFIG);

const shortModelName = (m: { id?: string; name?: string } | undefined): string => {
	if (!m) return "?";
	const id = m.id ?? m.name ?? "?";
	const stripped = id.replace(/^claude-/, "");
	const parts = stripped.split(/[-\/]/);
	return parts.slice(0, 2).join("-");
};

const snippet = (s: string, n = 60): string => {
	const cleaned = s.replace(/\s+/g, " ").trim();
	return cleaned.length > n ? cleaned.slice(0, n - 1) + "…" : cleaned;
};

const resolveModel = (ctx: ExtensionContext, lvl: LevelConfig): Model<unknown> | undefined => {
	const reg = ctx.modelRegistry;
	if (lvl.provider) {
		return reg.find(lvl.provider, lvl.model) as Model<unknown> | undefined;
	}
	return reg.getAll().find((m) => m.id === lvl.model) as Model<unknown> | undefined;
};

const evalRules = (prompt: string, cfg: RouterConfig): { level: string; matchedRule: string } => {
	const rules = getCompiledRules(cfg);
	for (let i = 0; i < rules.length; i++) {
		const r = rules[i];
		const matchOk = !r.match || r.match.test(prompt);
		const charsOk = r.minChars === undefined || prompt.length >= r.minChars;
		const pathOk = !r.pathTouches || r.pathTouches.test(prompt);
		if (matchOk && charsOk && pathOk) {
			return { level: r.level, matchedRule: `rule:${i}` };
		}
	}
	return { level: cfg.default, matchedRule: "default" };
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("model-router")) return;
	let pausedByUser = false; // set when user manually switches model mid-session
	let oneShotLevel: string | null = null;
	let lastLevel: string | null = null;
	let turnsSinceBump = 0;
	const log: Decision[] = [];

	const pushLog = (d: Decision) => {
		log.push(d);
		while (log.length > MAX_LOG) log.shift();
		pi.appendEntry("router-log", d);
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		ctx.ui.setStatus("06-router", text);
	};

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "set") return; // our own call from this extension
		if (event.source === "cycle") {
			// User used /model cycle — pause router so we don't fight them.
			pausedByUser = true;
			setStatus(ctx, ctx.ui.theme.fg("warning", "⏸ router (user override)"));
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.enabled) {
			setStatus(ctx, undefined);
			return;
		}
		if (pausedByUser) return;

		let level = cfg.default;
		let matchedRule = "default";
		if (oneShotLevel && cfg.levels[oneShotLevel]) {
			level = oneShotLevel;
			matchedRule = "override";
			oneShotLevel = null;
		} else {
			const evaluated = evalRules(event.prompt, cfg);
			level = evaluated.level;
			matchedRule = evaluated.matchedRule;
		}

		// Auto-bump: if we've been at the same level for N turns without
		// finishing (still streaming), escalate. Simple heuristic.
		if (cfg.autoBumpAfterTurns > 0 && lastLevel === level) {
			turnsSinceBump++;
			if (turnsSinceBump >= cfg.autoBumpAfterTurns) {
				const ordered = Object.keys(cfg.levels);
				const idx = ordered.indexOf(level);
				if (idx >= 0 && idx < ordered.length - 1) {
					level = ordered[idx + 1];
					matchedRule = "autoBump";
					turnsSinceBump = 0;
				}
			}
		} else {
			turnsSinceBump = 0;
		}

		const lvlCfg = cfg.levels[level];
		if (!lvlCfg) {
			ctx.ui.notify(`router: unknown level "${level}" — skipping`, "warning");
			return;
		}
		const model = resolveModel(ctx, lvlCfg);
		if (!model) {
			ctx.ui.notify(`router: model "${lvlCfg.provider ?? "*"}/${lvlCfg.model}" not registered — skipping`, "warning");
			return;
		}
		const available = ctx.modelRegistry.getAvailable().some((m) => m.id === model.id);
		if (!available) {
			ctx.ui.notify(`router: model "${model.id}" has no API key — staying on current model`, "warning");
			return;
		}

		try {
			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`router: setModel("${model.id}") rejected`, "warning");
				return;
			}
			pi.setThinkingLevel(lvlCfg.thinking);
		} catch (e) {
			ctx.ui.notify(`router: switch failed — ${(e as Error).message}`, "error");
			return;
		}

		if (lastLevel !== level) {
			ctx.ui.notify(`↗ Router: ${lastLevel ?? "?"} → ${level} (${shortModelName(model)}·${lvlCfg.thinking})`, "info");
		}
		lastLevel = level;

		const short = shortModelName(model);
		const clock = matchedRule === "override" ? " ⏱" : "";
		setStatus(ctx, ctx.ui.theme.fg("accent", `↗ ${short}·${lvlCfg.thinking}${clock}`));

		pushLog({
			ts: Date.now(),
			level,
			modelId: model.id,
			thinking: lvlCfg.thinking,
			matchedRule,
			promptSnippet: snippet(event.prompt),
		});
	});

	pi.registerCommand("router", {
		description: "Model router: /router <level>|on|off|status|resume",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			const arg = (args ?? "").trim();
			if (!arg || arg === "status") {
				const cur = lastLevel ?? "(none yet)";
				const pause = pausedByUser ? " [paused by user model switch]" : "";
				const lvlKeys = Object.keys(cfg.levels).join(", ") || "(no levels configured)";
				const recent = log.slice(-5).map((d) => `  ${new Date(d.ts).toISOString().slice(11, 19)}  ${d.level.padEnd(8)}  ${d.modelId}·${d.thinking}  [${d.matchedRule}]  ${d.promptSnippet}`).join("\n");
				ctx.ui.notify([
					`═ router status ═`,
					`enabled:  ${cfg.enabled}${pause}`,
					`current:  ${cur}`,
					`default:  ${cfg.default}`,
					`levels:   ${lvlKeys}`,
					`rules:    ${cfg.rules.length}`,
					recent ? `\nlast decisions:\n${recent}` : "",
				].filter(Boolean).join("\n"), "info");
				return;
			}
			if (arg === "on") {
				pausedByUser = false;
				ctx.ui.notify("router: resumed (will apply on next turn if enabled in settings)", "info");
				return;
			}
			if (arg === "off" || arg === "pause") {
				pausedByUser = true;
				setStatus(ctx, ctx.ui.theme.fg("warning", "⏸ router"));
				ctx.ui.notify("router: paused for this session", "info");
				return;
			}
			if (arg === "resume") {
				pausedByUser = false;
				ctx.ui.notify("router: resumed", "info");
				return;
			}
			// Treat as level name override for next turn.
			if (!cfg.levels[arg]) {
				ctx.ui.notify(`unknown level "${arg}". Available: ${Object.keys(cfg.levels).join(", ") || "(none)"}`, "warning");
				return;
			}
			oneShotLevel = arg;
			ctx.ui.notify(`router: next turn will use level "${arg}"`, "info");
		},
	});
}
