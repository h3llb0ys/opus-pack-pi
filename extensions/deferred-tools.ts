/**
 * deferred-tools — hide most MCP tools behind a lazy proxy.
 *
 * MCP parks with 20+ tools blow up the per-request prompt because every
 * tool schema is serialised on every call. This extension exposes only a
 * curated whitelist (non-MCP built-ins + user-listed regex) plus two proxy
 * tools `tool_search` and `tool_load`. The model searches for a tool by
 * keyword, loads it explicitly, then uses it on the next turn.
 *
 * Feature-flagged: opus-pack.deferredTools.enabled = true.
 * On session_start we compute the whitelist and call pi.setActiveTools().
 * turn_end clears the one-shot visibility bump so only the most recent
 * tool_load is honoured.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

interface DeferredToolsConfig {
	enabled: boolean;
	alwaysVisible: string[];
	mcpPattern: string;
	maxSearchResults: number;
}

const DEFAULT_CFG: DeferredToolsConfig = {
	enabled: false,
	alwaysVisible: [],
	mcpPattern: "^(mcp_|mcp__)",
	maxSearchResults: 10,
};

const compileList = (patterns: string[]): RegExp[] =>
	patterns
		.map((p) => {
			try { return new RegExp(p, "i"); } catch { return null; }
		})
		.filter((r): r is RegExp => r !== null);

const compileMcp = (pattern: string): RegExp => {
	try { return new RegExp(pattern, "i"); } catch { return /^(mcp_|mcp__)/i; }
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("deferred-tools")) return;

	// Names added via tool_load. Kept visible for the turn they were loaded
	// in AND the following turn, so the model actually gets a chance to call
	// the tool. Without the +1 delay, turn_end of the loading turn would
	// clear the set before the next LLM request sees it.
	const tempVisible = new Set<string>();
	let loadedThisTurn = false;

	const allowed = (toolName: string, cfg: DeferredToolsConfig, mcpRe: RegExp, extraRes: RegExp[]): boolean => {
		if (toolName === "tool_search" || toolName === "tool_load") return true;
		if (!mcpRe.test(toolName)) return true; // non-MCP always visible
		if (extraRes.some((re) => re.test(toolName))) return true;
		return tempVisible.has(toolName);
	};

	const applyWhitelist = (ctx: ExtensionContext): { hidden: number; shown: number } => {
		const cfg = loadOpusPackSection("deferredTools", DEFAULT_CFG);
		if (!cfg.enabled) {
			ctx.ui.setStatus("05-deferred", undefined);
			return { hidden: 0, shown: 0 };
		}
		const mcpRe = compileMcp(cfg.mcpPattern);
		const extraRes = compileList(cfg.alwaysVisible);
		const all = pi.getAllTools();
		const keep = all.filter((t) => allowed(t.name, cfg, mcpRe, extraRes)).map((t) => t.name);
		pi.setActiveTools(keep);
		const hidden = all.length - keep.length;
		ctx.ui.setStatus(
			"05-deferred",
			hidden > 0 ? ctx.ui.theme.fg("muted", `hidden:${hidden}`) : undefined,
		);
		return { hidden, shown: keep.length };
	};

	pi.on("session_start", async (_event, ctx) => {
		applyWhitelist(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Two-phase clear. Turn that set tempVisible only flips the flag;
		// the turn AFTER that actually drops the names, since the provider
		// request for "next turn" uses the whitelist computed between these
		// two turn_ends.
		if (loadedThisTurn) {
			loadedThisTurn = false;
			return;
		}
		if (tempVisible.size > 0) {
			tempVisible.clear();
			applyWhitelist(ctx);
		}
	});

	pi.registerTool({
		name: "tool_search",
		label: "Tool search",
		description:
			"Search the full tool catalogue (including hidden MCP tools) by keyword. " +
			"Returns a ranked list of candidates with short descriptions. Use tool_load(names[]) to make a tool usable on the next turn.",
		promptSnippet: "tool_search(query) — find a hidden MCP tool by keyword",
		parameters: Type.Object({
			query: Type.String({ description: "Keyword(s) to match against tool name or description (case-insensitive substring)." }),
			max: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max results (default 10)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<{ matches: string[] }>> {
			const cfg = loadOpusPackSection("deferredTools", DEFAULT_CFG);
			const max = params.max ?? cfg.maxSearchResults;
			const q = params.query.trim().toLowerCase();
			if (!q) {
				return {
					content: [{ type: "text", text: "tool_search: empty query" }],
					isError: true,
					details: { matches: [] },
				};
			}
			const all = pi.getAllTools();
			const scored = all
				.map((t) => {
					const name = t.name.toLowerCase();
					const desc = String((t as { description?: string }).description ?? "").toLowerCase();
					let score = 0;
					if (name === q) score += 100;
					if (name.includes(q)) score += 40;
					if (desc.includes(q)) score += 10;
					// split query into tokens for partial multi-word queries
					for (const tok of q.split(/\s+/)) {
						if (tok && name.includes(tok)) score += 5;
						if (tok && desc.includes(tok)) score += 1;
					}
					return { name: t.name, desc: String((t as { description?: string }).description ?? "").slice(0, 120), score };
				})
				.filter((s) => s.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, max);
			if (scored.length === 0) {
				return {
					content: [{ type: "text", text: `tool_search: no matches for "${params.query}"` }],
					isError: false,
					details: { matches: [] },
				};
			}
			const lines = scored.map((s) => `${s.name}  —  ${s.desc || "(no description)"}`);
			return {
				content: [{ type: "text", text: lines.join("\n") + `\n\nTo use one, call tool_load({names: [...]}). New tools become available starting with the next turn.` }],
				isError: false,
				details: { matches: scored.map((s) => s.name) },
			};
		},
	});

	pi.registerTool({
		name: "tool_load",
		label: "Tool load",
		description:
			"Make previously hidden tools visible for the NEXT turn. " +
			"One-shot: after the next turn they go back to hidden unless listed in opus-pack.deferredTools.alwaysVisible. " +
			"Use tool_search first to discover tool names.",
		promptSnippet: "tool_load(names) — expose hidden MCP tools for the next turn",
		parameters: Type.Object({
			names: Type.Array(Type.String(), { description: "Tool names to expose." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<{ added: string[]; unknown: string[] }>> {
			const cfg = loadOpusPackSection("deferredTools", DEFAULT_CFG);
			if (!cfg.enabled) {
				return {
					content: [{ type: "text", text: "tool_load: deferred-tools is disabled (opus-pack.deferredTools.enabled=false)." }],
					isError: true,
					details: { added: [], unknown: [] },
				};
			}
			const all = new Set(pi.getAllTools().map((t) => t.name));
			const added: string[] = [];
			const unknown: string[] = [];
			for (const name of params.names) {
				if (all.has(name)) {
					tempVisible.add(name);
					added.push(name);
				} else {
					unknown.push(name);
				}
			}
			if (added.length > 0) loadedThisTurn = true;
			applyWhitelist(ctx);
			const parts: string[] = [];
			if (added.length > 0) parts.push(`loaded (usable next turn): ${added.join(", ")}`);
			if (unknown.length > 0) parts.push(`unknown (skipped): ${unknown.join(", ")}`);
			return {
				content: [{ type: "text", text: parts.join("\n") || "nothing to load" }],
				isError: unknown.length > 0 && added.length === 0,
				details: { added, unknown },
			};
		},
	});

	pi.registerCommand("deferred-tools", {
		description: "Show deferred-tools status (hidden/shown counts) and reload whitelist",
		handler: async (_args, ctx) => {
			const res = applyWhitelist(ctx);
			const cfg = loadOpusPackSection("deferredTools", DEFAULT_CFG);
			ctx.ui.notify(
				[
					`═ deferred-tools ═`,
					`enabled:       ${cfg.enabled}`,
					`mcp pattern:   ${cfg.mcpPattern}`,
					`alwaysVisible: ${cfg.alwaysVisible.join(", ") || "(none)"}`,
					`hidden this session: ${res.hidden}`,
					`shown:         ${res.shown}`,
					`tempVisible:   ${tempVisible.size === 0 ? "(none)" : [...tempVisible].join(", ")}`,
				].join("\n"),
				"info",
			);
		},
	});
}
