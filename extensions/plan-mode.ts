/**
 * Plan Mode — read-only exploration + plan/execute cycle.
 *
 * /plan or Ctrl+Alt+P toggles plan mode (read-only tools only).
 * Agent creates numbered plan under "Plan:" header.
 * User chooses "Execute" → full tools restored.
 *
 * Execution progress is owned by the `todo` extension: on plan approval
 * plan-mode emits `opus-pack:todo:replace` with the parsed steps, and the
 * model drives progress with the normal `todo done` tool. plan-mode
 * listens to `opus-pack:todo:changed` and mirrors done-state into the
 * persisted plan file's `done_steps` frontmatter so a future session can
 * resume from disk.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

interface PlanModeConfig {
	autoSave: boolean;
	dir: string;
	mcpPattern?: string;
	gateGranularity?: "tool" | "server";
	nonInteractivePolicy?: "allow" | "deny";
}

const DEFAULT_MCP_PATTERN = "^mcp__";
const DEFAULT_PLAN_CFG: PlanModeConfig = {
	autoSave: false,
	dir: ".pi/plans",
	mcpPattern: DEFAULT_MCP_PATTERN,
	gateGranularity: "tool",
	nonInteractivePolicy: "deny",
};

const compileMcpPattern = (pattern?: string): RegExp => {
	try { return new RegExp(pattern ?? DEFAULT_MCP_PATTERN, "i"); } catch { return new RegExp(DEFAULT_MCP_PATTERN, "i"); }
};

// `server` granularity assumes canonical pi MCP convention `mcp__<server>__<tool>`.
// Names not matching that shape fall through to full-name granularity.
const gateKey = (toolName: string, granularity: "tool" | "server" | undefined): string => {
	if (granularity !== "server") return toolName;
	const parts = toolName.split("__");
	return parts.length >= 3 && parts[0] === "mcp" ? `${parts[0]}__${parts[1]}` : toolName;
};

// Redact values of fields whose names smell sensitive, for the approval dialog
// preview only. Best-effort shallow pass; untrusted MCP args shouldn't leak
// credentials into the TUI title.
const SENSITIVE_KEY = /^(.*(token|api[_-]?key|password|passwd|secret|authorization|auth|cookie|session).*)$/i;
const redactPreview = (input: unknown): string => {
	try {
		const redact = (v: unknown): unknown => {
			if (Array.isArray(v)) return v.map(redact);
			if (v && typeof v === "object") {
				const out: Record<string, unknown> = {};
				for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
					out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(val);
				}
				return out;
			}
			return v;
		};
		return JSON.stringify(redact(input ?? {})).slice(0, 200);
	} catch { return ""; }
};

const slugify = (s: string): string =>
	s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "plan";

type PlanStatus = "approved" | "rejected" | "non-interactive" | "completed" | "closed";

interface PlanFrontmatter {
	created?: string;
	status?: string;
	done_steps?: number[];
}

const formatFrontmatter = (fm: PlanFrontmatter, body: string): string => {
	const lines = ["---"];
	if (fm.created) lines.push(`created: ${fm.created}`);
	if (fm.status) lines.push(`status: ${fm.status}`);
	if (fm.done_steps && fm.done_steps.length > 0) {
		lines.push(`done_steps: [${fm.done_steps.join(", ")}]`);
	}
	lines.push("---", "", body.trim(), "");
	return lines.join("\n");
};

const savePlanToFile = (
	cwd: string,
	dirRel: string,
	plan: string,
	status: PlanStatus,
	firstStep: string,
	customName?: string,
): { path: string } | { error: string } => {
	try {
		const dirAbs = join(cwd, dirRel);
		mkdirSync(dirAbs, { recursive: true });
		const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const slug = customName ? slugify(customName) : slugify(firstStep);
		const path = join(dirAbs, `${ts}-${slug}.md`);
		writeFileSync(path, formatFrontmatter({ created: new Date().toISOString(), status }, plan));
		return { path };
	} catch (e) {
		return { error: (e as Error).message };
	}
};

/**
 * Update an existing plan file's frontmatter — typically to record
 * `done_steps` as the model marks progress, or to flip `status` to
 * `completed`/`closed` when the plan finishes. Body is preserved verbatim.
 * Silent on failure so a read-only fs doesn't break the agent run.
 */
const updatePlanFile = (
	path: string,
	patch: { done_steps?: number[]; status?: string },
): void => {
	try {
		if (!existsSync(path)) return;
		const raw = readFileSync(path, "utf8");
		const { frontmatter, body } = parseFrontmatter<PlanFrontmatter>(raw);
		const next: PlanFrontmatter = {
			created: typeof frontmatter.created === "string" ? frontmatter.created : new Date().toISOString(),
			status: patch.status ?? (typeof frontmatter.status === "string" ? frontmatter.status : "approved"),
			done_steps: patch.done_steps ?? (Array.isArray(frontmatter.done_steps) ? frontmatter.done_steps : undefined),
		};
		writeFileSync(path, formatFrontmatter(next, body));
	} catch {
		/* best-effort */
	}
};

interface PlanFileInfo {
	path: string;
	created: string;
	status: string;
	doneSteps: number[];
	mtimeMs: number;
	slug: string;
}

const listPlanFiles = (cwd: string, dirRel: string): PlanFileInfo[] => {
	const dirAbs = join(cwd, dirRel);
	if (!existsSync(dirAbs)) return [];
	let entries: string[];
	try { entries = readdirSync(dirAbs); } catch { return []; }
	const out: PlanFileInfo[] = [];
	for (const name of entries) {
		if (!name.endsWith(".md")) continue;
		const full = join(dirAbs, name);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (!stat.isFile()) continue;
		let raw: string;
		try { raw = readFileSync(full, "utf8"); } catch { continue; }
		const { frontmatter } = parseFrontmatter<PlanFrontmatter>(raw);
		out.push({
			path: full,
			created: typeof frontmatter.created === "string" ? frontmatter.created : "",
			status: typeof frontmatter.status === "string" ? frontmatter.status : "unknown",
			doneSteps: Array.isArray(frontmatter.done_steps) ? frontmatter.done_steps.map(Number).filter((n) => Number.isFinite(n)) : [],
			mtimeMs: stat.mtimeMs,
			slug: name.replace(/\.md$/, ""),
		});
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
};

const PLAN_MODE_BASE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// Read-only allowlist of command names that may appear in any segment
// of a pipeline / compound command in plan mode.
const SAFE_COMMANDS = new Set([
	"cat", "head", "tail", "grep", "egrep", "fgrep", "find", "ls", "pwd", "echo", "printf",
	"wc", "sort", "uniq", "cut", "tr", "awk", "xargs", "tee",
	"diff", "file", "stat", "du", "df", "tree",
	"which", "type", "whereis", "env", "uname", "whoami", "id", "hostname", "date",
	"basename", "dirname", "realpath", "readlink",
	"jq", "yq", "rg", "fd", "bat",
	"test", "expr", "true", "false", "yes",
]);

// Read-only subcommand allowlist for tools that are only safe with specific args.
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
	git: new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files", "ls-tree", "config", "rev-parse", "describe", "blame"]),
	npm: new Set(["list", "ls", "view", "outdated"]),
	cargo: new Set(["tree", "metadata", "check"]),
	go: new Set(["list", "env", "version"]),
	sed: new Set([]), // sed without -i is read-only; handled below
	python: new Set(["-c", "--version"]),
	node: new Set(["--version", "-v"]),
};

// Hard-block these anywhere in the command string.
const HARD_BLOCK_PATTERNS = [
	/\bsudo\b/i,
	/\brm\s+-[rf]|\brm\s+-[rR]?[fF]|\brm\s+--/i,
	/\b(mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\s/i,
	/\bkill(all)?\s+-[0-9A-Z]/i, /\bpkill\b/i,
	/\b(npm|yarn|pnpm|pip|pipx|brew|apt|apt-get|dnf|yum|pacman|cargo)\s+(install|add|remove|uninstall|update|upgrade)/i,
	/\bgit\s+(add|commit|push|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|clean|reflog\s+expire)/i,
	/\b(curl|wget)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/(^|[^<>])>(?!>)/, />>/, // output redirection
];

const isSegmentSafe = (seg: string): boolean => {
	const trimmed = seg.trim();
	if (!trimmed) return false;
	const tokens = trimmed.split(/\s+/);
	const cmd = tokens[0].replace(/^\\/, ""); // strip escape
	const base = cmd.includes("/") ? cmd.slice(cmd.lastIndexOf("/") + 1) : cmd;
	if (SAFE_COMMANDS.has(base)) return true;
	const allowedSubs = SAFE_SUBCOMMANDS[base];
	if (allowedSubs) {
		if (base === "sed") {
			// sed without -i is read-only.
			return !tokens.some((t) => t === "-i" || t.startsWith("-i") || t === "--in-place");
		}
		if (allowedSubs.size === 0) return false;
		return tokens.slice(1).some((t) => allowedSubs.has(t));
	}
	return false;
};

function isSafeCommand(cmd: string): boolean {
	// Blank out quoted string literals before hard-block scan so patterns like
	// `grep 'curl …'` don't trip the curl rule on their own argument text.
	// Command substitution (`$(…)`, backticks) intentionally stays visible to
	// hard-block, otherwise `cat $(curl evil)` would slip past as a cat call.
	const stripped = cmd
		.replace(/'[^']*'/g, "''")
		.replace(/"(?:\\.|[^"\\])*"/g, '""');
	if (HARD_BLOCK_PATTERNS.some((p) => p.test(stripped))) return false;
	const segments = cmd.split(/\|\||&&|;|\||&(?!\d)/).map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return false;
	return segments.every(isSegmentSafe);
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(msg: AssistantMessage): string {
	return msg.content
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function extractPlanSteps(message: string): string[] {
	const steps: string[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return steps;
	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	for (const match of planSection.matchAll(/^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm)) {
		const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
		if (text.length > 5) steps.push(text.slice(0, 80));
	}
	return steps;
}

interface TodoChangedItem { status: "pending" | "in_progress" | "dispatched" | "done"; text: string }

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("plan-mode")) return;
	let planModeEnabled = false;
	let executionMode = false;
	// Per-plan-session approval cache. Cleared on plan toggle / finalize /
	// resume. Keys depend on gateGranularity: full tool name ("tool") or
	// server prefix ("server"). Not persisted — decisions expire with the
	// session for safety.
	const planApprovals = new Map<string, "allow" | "deny">();
	// Config + MCP tool list are snapshotted on plan entry to avoid repeated
	// `loadOpusPackSection` + registry scans on every tool_call, and to pin
	// behaviour against mid-session config edits.
	let planCfgSnapshot: PlanModeConfig | null = null;
	let planMcpTools: string[] = [];
	let planMcpToolSet: Set<string> = new Set();

	// Detect MCP tools via (a) pi-mcp-adapter `sourceInfo` — works regardless
	// of toolPrefix setting ("server"/"short"/"none"); (b) unified proxy tool
	// literally named "mcp"; (c) user-configurable regex for third-party MCP
	// providers or custom naming. Base tools (read/bash/...) are always
	// excluded so a misconfigured MCP server cannot shadow a builtin and
	// trigger the gate for native tool calls.
	//
	// NOTE on unified proxy mode: when `toolPrefix: "none"` *and* unified
	// proxy is enabled, a single `Allow (session)` for the `mcp` key grants
	// broad access to every MCP server for the plan-session lifetime. Users
	// who want per-server granularity should run pi-mcp-adapter with direct
	// tools (`toolPrefix: "server"` or `"short"`) instead.
	const MCP_ADAPTER_PKG = "pi-mcp-adapter";
	const matchesAdapterSource = (src: string | undefined, path: string | undefined): boolean => {
		if (src === MCP_ADAPTER_PKG) return true;
		if (path && /[\\/]pi-mcp-adapter([\\/]|$)/.test(path)) return true;
		return false;
	};
	const isMcpToolInfo = (t: { name: string; sourceInfo?: { source?: string; path?: string } }, re: RegExp): boolean => {
		if (PLAN_MODE_BASE_TOOLS.includes(t.name)) return false;
		if (t.name === "mcp") return true;
		if (matchesAdapterSource(t.sourceInfo?.source, t.sourceInfo?.path)) return true;
		return re.test(t.name);
	};

	const collectMcpTools = (cfg: PlanModeConfig): string[] => {
		const re = compileMcpPattern(cfg.mcpPattern);
		const mcp: string[] = [];
		try {
			for (const t of pi.getAllTools()) {
				if (isMcpToolInfo(t, re)) mcp.push(t.name);
			}
		} catch { /* best-effort: older pi versions or registry not ready */ }
		return mcp;
	};

	const snapshotPlanCfg = (): PlanModeConfig => {
		const cfg = loadOpusPackSection("planMode", DEFAULT_PLAN_CFG);
		planCfgSnapshot = cfg;
		planMcpTools = collectMcpTools(cfg);
		planMcpToolSet = new Set(planMcpTools);
		return cfg;
	};

	const clearPlanCfg = () => {
		planCfgSnapshot = null;
		planMcpTools = [];
		planMcpToolSet = new Set();
	};

	const buildPlanModeTools = (): string[] => {
		const cfg = planCfgSnapshot ?? snapshotPlanCfg();
		// Re-scan registry every call so tools registered between plan-entry
		// and this call are picked up. Cheap: single getAllTools() iteration.
		planMcpTools = collectMcpTools(cfg);
		planMcpToolSet = new Set(planMcpTools);
		return [...PLAN_MODE_BASE_TOOLS, ...planMcpTools];
	};
	// Path to the .pi/plans/<slug>.md file currently driving execution. Set
	// when exit_plan_mode persists and when /plan-resume picks an old plan up.
	// Used to write done_steps back into the file as todo progresses, so a
	// future session can resume from disk even if the session entry is gone.
	let activePlanPath: string | null = null;
	// Snapshot of the last todo list broadcast by the todo extension. Used
	// by finalizePlan to know how many steps landed "done" for the closing
	// message, and to compute done_steps for the plan-file writeback.
	let lastTodoItems: TodoChangedItem[] = [];

	const broadcastPlanState = () => {
		pi.events.emit("opus-pack:plan-state", { active: planModeEnabled || executionMode });
	};

	const persist = () => {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			executing: executionMode,
			activePlanPath,
		});
	};

	const updateStatus = (ctx: ExtensionContext) => {
		broadcastPlanState();
		if (planModeEnabled) {
			const label = ctx.ui.theme.fg("accent", "plan mode on") + " " + ctx.ui.theme.fg("muted", "(cmd+p)");
			ctx.ui.setStatus("01-plan", label);
		} else {
			ctx.ui.setStatus("01-plan", undefined);
		}
	};

	const writebackProgress = (status?: PlanStatus) => {
		if (!activePlanPath) return;
		const done: number[] = [];
		lastTodoItems.forEach((t, i) => { if (t.status === "done") done.push(i + 1); });
		updatePlanFile(activePlanPath, { done_steps: done, status });
	};

	const finalizePlan = (ctx: ExtensionContext, terminal?: PlanStatus) => {
		const total = lastTodoItems.length;
		const completed = lastTodoItems.filter((t) => t.status === "done").length;
		const status: PlanStatus = terminal ?? (total > 0 && completed === total ? "completed" : "closed");
		writebackProgress(status);
		executionMode = false;
		activePlanPath = null;
		planApprovals.clear();
		clearPlanCfg();
		pi.setActiveTools(NORMAL_MODE_TOOLS);
		updateStatus(ctx);
		persist();
		return { total, completed };
	};

	const togglePlanMode = (ctx: ExtensionContext) => {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		activePlanPath = null;
		planApprovals.clear();
		if (planModeEnabled) {
			const cfg = snapshotPlanCfg();
			const tools = buildPlanModeTools();
			pi.setActiveTools(tools);
			const mcpCount = planMcpTools.length;
			const mcpNote = mcpCount > 0 ? `, ${mcpCount} MCP tools (gated per-call)` : ", no MCP tools detected";
			ctx.ui.notify(`Plan mode ON. Base: ${PLAN_MODE_BASE_TOOLS.join(", ")}${mcpNote}.`, "info");
			if (cfg.gateGranularity === "server" && mcpCount > 0 && !planMcpTools.some((n) => /^mcp__[^_]+__/.test(n))) {
				ctx.ui.notify(
					"planMode.gateGranularity=\"server\" but none of detected MCP tools use the mcp__<server>__<tool> naming — falling back to per-tool approvals.",
					"warning",
				);
			}
		} else {
			clearPlanCfg();
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode OFF. Full access.", "info");
		}
		updateStatus(ctx);
	};

	// Keep snapshot of todo state + writeback to plan file as model progresses.
	// Also detect "all done" → auto-finalize.
	// No ctx here; finalization that needs ctx is deferred to agent_end /
	// before_agent_start handlers.
	let pendingCompletionAnnounce = false;
	pi.events.on("opus-pack:todo:changed", (data) => {
		const payload = data as { items?: TodoChangedItem[] } | undefined;
		const items = Array.isArray(payload?.items) ? payload!.items : [];
		lastTodoItems = items.map((t) => ({ status: t.status, text: t.text }));
		if (!executionMode) return;
		// Writeback even if nothing changed terminally — one-off write is cheap.
		writebackProgress();
		if (lastTodoItems.length > 0 && lastTodoItems.every((t) => t.status === "done")) {
			pendingCompletionAnnounce = true;
		}
	});

	pi.registerFlag("plan", { type: "boolean", description: "Start in plan mode", default: false });

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("plan-close", {
		description: "Force-close the active plan (stop tracking progress against the plan file)",
		handler: async (_args, ctx) => {
			if (!executionMode) {
				ctx.ui.notify("No active plan.", "info");
				return;
			}
			const { total, completed } = finalizePlan(ctx);
			ctx.ui.notify(`Plan closed manually (${completed}/${total} steps marked done).`, "info");
		},
	});

	pi.registerCommand("plan-resume", {
		description: "Resume a saved plan from <cwd>/.pi/plans. No args → picker; arg → filename substring match.",
		handler: async (args, ctx) => {
			const cfg = loadOpusPackSection("planMode", DEFAULT_PLAN_CFG);
			const all = listPlanFiles(ctx.cwd, cfg.dir);
			if (all.length === 0) {
				ctx.ui.notify(`No plans in ${join(ctx.cwd, cfg.dir)}. Create one via /plan → exit_plan_mode(plan, save: "...").`, "info");
				return;
			}
			const query = (args ?? "").trim();
			let picked: PlanFileInfo | undefined;
			if (query) {
				picked = all.find((p) => p.slug.toLowerCase().includes(query.toLowerCase()));
				if (!picked) {
					ctx.ui.notify(`No plan matching "${query}". Try /plan-resume without args to pick from the list.`, "warning");
					return;
				}
			} else if (!ctx.hasUI) {
				ctx.ui.notify("plan-resume requires an arg in non-interactive mode.", "warning");
				return;
			} else {
				const options = all.slice(0, 20).map((p) => {
					const progress = p.doneSteps.length > 0 ? ` [${p.doneSteps.length} done]` : "";
					return `${p.slug}  ·  ${p.status}${progress}`;
				});
				options.push("Cancel");
				const choice = await ctx.ui.select("Pick a plan to resume:", options);
				if (!choice || choice === "Cancel") return;
				picked = all[options.indexOf(choice)];
			}
			if (!picked) return;

			let raw: string;
			try { raw = readFileSync(picked.path, "utf8"); } catch (e) {
				ctx.ui.notify(`Can't read ${picked.path}: ${(e as Error).message}`, "error");
				return;
			}
			const { body } = parseFrontmatter<PlanFrontmatter>(raw);
			const steps = extractPlanSteps(body.startsWith("Plan:") ? body : `Plan:\n${body}`);
			if (steps.length === 0) {
				ctx.ui.notify(`Plan ${picked.slug} has no numbered steps to resume.`, "warning");
				return;
			}
			const doneSet = new Set(picked.doneSteps);
			const todoPayload = steps.map((text, i) => ({ text, done: doneSet.has(i + 1) }));

			planModeEnabled = false;
			executionMode = true;
			activePlanPath = picked.path;
			planApprovals.clear();
			clearPlanCfg();
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			pi.events.emit("opus-pack:todo:replace", { items: todoPayload, source: "plan-resume" });
			updateStatus(ctx);
			persist();
			const done = todoPayload.filter((t) => t.done).length;
			ctx.ui.notify(
				`Resumed plan ${picked.slug} (${done}/${todoPayload.length} steps marked done). Continue execution — call todo start/done to track progress.`,
				"info",
			);
		},
	});

	pi.registerShortcut(Key.alt("tab"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});
	pi.registerShortcut(Key.super("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode (fallback)",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Explicit LLM-callable exit: model proposes the full plan, user confirms,
	// execution starts immediately. Steps flow into the `todo` extension so
	// progress tracking uses the normal todo tool.
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit plan mode",
		description:
			"Call when you have finished the plan and are ready to execute. " +
			"Pass the plan as a numbered list (1. step one, 2. step two). " +
			"The user is asked to approve; on approval plan mode exits, the " +
			"steps are installed in the todo list, and execution starts.",
		promptSnippet: "exit_plan_mode(plan) — finish planning, request user approval to execute",
		parameters: Type.Object({
			plan: Type.String({ description: "The final plan as a numbered markdown list." }),
			save: Type.Optional(Type.String({
				description: "Optional filename slug. If set (or opus-pack.planMode.autoSave=true), plan is written to <cwd>/.pi/plans/<ts>-<slug>.md with frontmatter.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cfg = loadOpusPackSection("planMode", DEFAULT_PLAN_CFG);
			const wantSave = typeof params.save === "string" && params.save.trim().length > 0;
			if (!planModeEnabled) {
				return {
					content: [{ type: "text", text: "refused: not currently in plan mode" }],
					isError: true,
					details: { approved: false },
				};
			}
			const steps = extractPlanSteps(`Plan:\n${params.plan}`);
			const firstStep = steps[0] ?? "plan";

			const installSteps = () => {
				pi.events.emit("opus-pack:todo:replace", {
					items: steps.map((s) => ({ text: s })),
					source: "exit_plan_mode",
				});
			};

			if (!ctx.hasUI) {
				// Non-interactive: auto-approve.
				planModeEnabled = false;
				executionMode = steps.length > 0;
				planApprovals.clear();
				clearPlanCfg();
				installSteps();
				pi.setActiveTools(NORMAL_MODE_TOOLS);
				updateStatus(ctx);
				let savedPathNI: string | undefined;
				if (wantSave || cfg.autoSave) {
					const res = savePlanToFile(ctx.cwd, cfg.dir, params.plan, "non-interactive", firstStep, params.save);
					if ("path" in res) {
						savedPathNI = res.path;
						activePlanPath = res.path;
					}
				}
				persist();
				return {
					content: [{ type: "text", text: `plan accepted (non-interactive). ${steps.length} steps. execute now.${savedPathNI ? ` saved: ${savedPathNI}` : ""}` }],
					isError: false,
					details: { approved: true, steps: steps.length },
				};
			}

			const approved = await ctx.ui.confirm(
				"Exit plan mode and execute?",
				`${steps.length} step${steps.length === 1 ? "" : "s"} queued.`,
			);
			if (!approved) {
				if (wantSave || cfg.autoSave) {
					savePlanToFile(ctx.cwd, cfg.dir, params.plan, "rejected", firstStep, params.save);
				}
				return {
					content: [{ type: "text", text: "user declined execution. stay in plan mode." }],
					isError: false,
					details: { approved: false },
				};
			}
			planModeEnabled = false;
			executionMode = steps.length > 0;
			planApprovals.clear();
			clearPlanCfg();
			installSteps();
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			let savedPath: string | undefined;
			if (wantSave || cfg.autoSave) {
				const res = savePlanToFile(ctx.cwd, cfg.dir, params.plan, "approved", firstStep, params.save);
				if ("path" in res) {
					savedPath = res.path;
					activePlanPath = res.path;
					ctx.ui.notify(`plan saved: ${res.path}`, "info");
				} else {
					ctx.ui.notify(`plan save failed: ${res.error}`, "warning");
				}
			}
			persist();
			return {
				content: [{ type: "text", text: `plan approved. proceed with step 1. mark progress with the todo tool (todo start <id> → work → todo done <id>).${savedPath ? ` saved: ${savedPath}` : ""}` }],
				isError: false,
				details: { approved: true, steps: steps.length },
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;
		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			if (!isSafeCommand(cmd)) {
				return { block: true, reason: `plan-mode: blocked (not allowlisted). Use /plan to disable.\nCommand: ${cmd}` };
			}
			return;
		}
		const cfg = planCfgSnapshot ?? snapshotPlanCfg();
		if (!planMcpToolSet.has(event.toolName)) return;

		const key = gateKey(event.toolName, cfg.gateGranularity);
		const cached = planApprovals.get(key);
		if (cached === "allow") return;
		if (cached === "deny") {
			return { block: true, reason: `plan-mode: ${event.toolName} denied for this plan session` };
		}

		if (!ctx.hasUI) {
			if (cfg.nonInteractivePolicy === "allow") return;
			return { block: true, reason: `plan-mode: ${event.toolName} blocked (no UI for approval)` };
		}

		const preview = redactPreview(event.input);
		const title = preview
			? `Plan mode — allow ${event.toolName}?  ${preview}`
			: `Plan mode — allow ${event.toolName}?`;
		const choice = await ctx.ui.select(title, [
			"Allow (session)",
			"Allow once",
			"Deny (session)",
			"Deny once",
		]);
		switch (choice) {
			case "Allow (session)":
				planApprovals.set(key, "allow");
				return;
			case "Allow once":
				return;
			case "Deny (session)":
				planApprovals.set(key, "deny");
				return { block: true, reason: `plan-mode: user denied ${event.toolName} (session)` };
			case "Deny once":
				return { block: true, reason: `plan-mode: user declined ${event.toolName}` };
			case undefined:
			default:
				return { block: true, reason: `plan-mode: approval dialog cancelled for ${event.toolName}` };
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				return msg.customType !== "plan-mode-context";
			}),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// Defensive finalize if todo signalled all-done between turns.
		if (executionMode && pendingCompletionAnnounce) {
			pendingCompletionAnnounce = false;
			const { total } = finalizePlan(ctx, "completed");
			pi.sendMessage(
				{ customType: "plan-complete", content: `**Plan complete!** ✓ All ${total} steps done.`, display: true },
				{ triggerTurn: false },
			);
		}
		if (planModeEnabled) {
			// Re-assert active tools every turn — other extensions (e.g.
			// deferred-tools) may have rewritten the list via their own
			// setActiveTools between turns. Idempotent; cheap.
			try { pi.setActiveTools(buildPlanModeTools()); } catch { /* best-effort */ }

			const mcpLine = planMcpTools.length > 0
				? `MCP tools available (${planMcpTools.length}) — each call is gated by a per-session user approval dialog. Prefer read-only MCP (e.g. search, read, recall) for exploration.`
				: `No MCP tools detected.`;
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
Read-only exploration. Base tools: ${PLAN_MODE_BASE_TOOLS.join(", ")}. No edit/write.
${mcpLine}
Create a numbered plan under a "Plan:" header. Do NOT make changes.`,
					display: false,
				},
			};
		}
		if (executionMode && lastTodoItems.length > 0) {
			const remaining = lastTodoItems
				.map((t, i) => ({ step: i + 1, text: t.text, status: t.status }))
				.filter((t) => t.status !== "done");
			if (remaining.length === 0) return;

			// Group by status so the model sees parallel-in-flight work
			// distinctly from local work and from untouched pending steps.
			// The hint at the bottom explains how to fan out independent
			// pending steps via dispatch + subagent.
			const fmt = (rows: typeof remaining) =>
				rows.map((t) => `  #${t.step} ${t.text}`).join("\n");
			const sections: string[] = [];
			const inProg = remaining.filter((t) => t.status === "in_progress");
			const dispatched = remaining.filter((t) => t.status === "dispatched");
			const pending = remaining.filter((t) => t.status === "pending");
			if (inProg.length > 0) sections.push(`In progress:\n${fmt(inProg)}`);
			if (dispatched.length > 0) sections.push(`Dispatched (delegated to subagents):\n${fmt(dispatched)}`);
			if (pending.length > 0) sections.push(`Pending:\n${fmt(pending)}`);

			return {
				message: {
					customType: "plan-execution-context",
					content:
						`[EXECUTING PLAN]\n${sections.join("\n\n")}\n\n` +
						"Drive progress with the todo tool: `todo start <id>` before working on a step, `todo done <id>` (or `ids:[...]`) when finished. " +
						"Independent pending steps can run in parallel: `todo dispatch ids:[...]` then `subagent({tasks:[...], concurrency:N})`; mark them done when results return. " +
						"If a dispatched subagent fails, `todo start id:<N>` flips it back so you take it over locally.",
					display: false,
				},
			};
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode) {
			// Completion handled lazily via pendingCompletionAnnounce so we
			// don't double-fire if todo:changed already flipped the flag.
			if (pendingCompletionAnnounce) {
				pendingCompletionAnnounce = false;
				const { total } = finalizePlan(ctx, "completed");
				pi.sendMessage(
					{ customType: "plan-complete", content: `**Plan complete!** ✓ All ${total} steps done.`, display: true },
					{ triggerTurn: false },
				);
			}
			return;
		}
		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		let steps: string[] = [];
		if (lastAssistant) {
			steps = extractPlanSteps(getTextContent(lastAssistant));
		}

		if (steps.length > 0) {
			pi.sendMessage(
				{ customType: "plan-todo-list", content: `**Plan (${steps.length} steps):**\n${steps.map((t, i) => `${i + 1}. ☐ ${t}`).join("\n")}`, display: true },
				{ triggerTurn: false },
			);
		}

		const choice = await ctx.ui.select("Plan mode — what next?", [
			"Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice === "Execute the plan") {
			planModeEnabled = false;
			executionMode = steps.length > 0;
			planApprovals.clear();
			clearPlanCfg();
			if (steps.length > 0) {
				pi.events.emit("opus-pack:todo:replace", {
					items: steps.map((s) => ({ text: s })),
					source: "plan-mode-manual-execute",
				});
			}
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			updateStatus(ctx);
			persist();
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: `Execute the plan. Start with: ${steps[0] ?? "the plan you created."} — use the todo tool to track progress.`, display: true },
				{ triggerTurn: true },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine:", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) planModeEnabled = true;

		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: { enabled?: boolean; executing?: boolean; activePlanPath?: string | null } } | undefined;

		if (last?.data) {
			planModeEnabled = last.data.enabled ?? planModeEnabled;
			executionMode = last.data.executing ?? executionMode;
			activePlanPath = last.data.activePlanPath ?? null;
		}

		// Hydrate the todo snapshot directly from the session log so
		// execution-context injection works on the very first turn after
		// resume — regardless of whether the todo extension's session_start
		// handler runs before or after ours.
		if (executionMode) {
			const lastTodo = entries
				.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "todo")
				.pop() as { data?: { items?: Array<{ status?: string; text?: string }> } } | undefined;
			const restored = lastTodo?.data?.items;
			if (Array.isArray(restored)) {
				lastTodoItems = restored
					.filter((t): t is { status: string; text: string } => typeof t.text === "string" && typeof t.status === "string")
					.map((t) => {
						// Whitelist must include every Status the todo
						// extension can write — otherwise resume silently
						// downgrades the value (the original bug was
						// `dispatched` collapsing to `pending`, leading
						// the execution-context to mis-categorise items
						// the model had already delegated to subagents).
						const isKnown = t.status === "done"
							|| t.status === "in_progress"
							|| t.status === "dispatched";
						const status = (isKnown ? t.status : "pending") as TodoChangedItem["status"];
						return { status, text: t.text };
					});
				// Resume safety: if the plan was fully done in the previous
				// session but the completion announcement never landed,
				// queue it so the next before_agent_start finalizes cleanly.
				if (lastTodoItems.length > 0 && lastTodoItems.every((t) => t.status === "done")) {
					pendingCompletionAnnounce = true;
				}
			}
		}

		if (planModeEnabled) {
			snapshotPlanCfg();
			pi.setActiveTools(buildPlanModeTools());
		}
		updateStatus(ctx);
	});
}
