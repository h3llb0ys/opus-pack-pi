/**
 * mcp-compress — collapse verbose MCP tool results to a single line.
 *
 * pi renders each tool call as its own card with the full result payload.
 * For MCP tools (memory saves, kb writes, etc.) those cards are noisy: six
 * consecutive `memory_save` calls dump six large JSON blocks. CC collapses
 * such runs into one "Calling X 6 times…" summary, but pi's core doesn't
 * support that grouping. This extension takes the next best thing: shortens
 * each MCP tool's result to a single line, so six calls produce six tiny
 * cards instead of six tall ones.
 *
 * Hook: tool_result event returns a replacement content payload. pi's
 * first-wins resolution of tool definitions means we cannot override MCP
 * tools' renderResult directly, but tool_result event handlers stack and
 * compose across extensions — this one fires for every MCP call.
 *
 * Config opus-pack.mcpCompress:
 *   enabled: boolean
 *   prefixes: string[] — tool name prefixes to compress (default mcp_, server_)
 *   maxLineLen: number — cap per summary line (default 160)
 *   whitelist: string[] — tool names to skip (keep full output)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface CompressConfig {
	enabled: boolean;
	prefixes: string[];
	maxLineLen: number;
	whitelist: string[];
}

const DEFAULT_CONFIG: CompressConfig = {
	enabled: true,
	prefixes: ["mcp_", "mcp__", "server_"],
	maxLineLen: 160,
	whitelist: [],
};

const loadConfig = (): CompressConfig => {
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		const user = parsed?.["opus-pack"]?.["mcpCompress"];
		if (user && typeof user === "object") return { ...DEFAULT_CONFIG, ...user };
	} catch { /* ignore */ }
	return DEFAULT_CONFIG;
};

const matchesPrefix = (name: string, prefixes: string[]): boolean =>
	prefixes.some((p) => name.startsWith(p));

const truncate = (s: string, max: number): string => {
	const clean = s.replace(/\s+/g, " ").trim();
	return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
};

/**
 * Build a compact one-line summary from a tool result payload.
 * Recognises a few common shapes used by MCP servers; otherwise trims the
 * first non-empty line.
 */
const summarize = (text: string, isError: boolean, toolName: string, maxLineLen: number): string => {
	if (!text) return isError ? `err ${toolName}: (no output)` : `ok  ${toolName}: (empty)`;
	// Try JSON first.
	try {
		const obj = JSON.parse(text);
		if (obj && typeof obj === "object") {
			const parts: string[] = [];
			if (obj.saved === true) parts.push("saved");
			if (obj.saved === false) parts.push("not saved");
			if (obj.deduplicated === true) parts.push("deduped");
			if (typeof obj.id === "number" || typeof obj.id === "string") parts.push(`id=${obj.id}`);
			if (obj.episode_id) parts.push(`episode=${String(obj.episode_id).slice(0, 8)}`);
			if (typeof obj.count === "number") parts.push(`count=${obj.count}`);
			if (obj.error) parts.push(`error: ${truncate(String(obj.error), 80)}`);
			if (obj.ok === false && !obj.error) parts.push("ok=false");
			if (Array.isArray(obj.competency_updated) && obj.competency_updated.length > 0) {
				parts.push(`tags=${obj.competency_updated.slice(0, 3).join(",")}`);
			}
			if (parts.length > 0) {
				const prefix = isError ? "err" : "ok ";
				return truncate(`${prefix} ${toolName}: ${parts.join(", ")}`, maxLineLen);
			}
			// Fallback: first top-level key/value.
			const firstKey = Object.keys(obj)[0];
			if (firstKey) {
				const val = typeof obj[firstKey] === "object" ? JSON.stringify(obj[firstKey]) : String(obj[firstKey]);
				return truncate(`${isError ? "err" : "ok"} ${toolName}: ${firstKey}=${val}`, maxLineLen);
			}
		}
	} catch { /* not JSON */ }
	// Fallback: first non-empty line.
	const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return truncate(`${isError ? "err" : "ok"} ${toolName}: ${firstLine}`, maxLineLen);
};

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		const cfg = loadConfig();
		if (!cfg.enabled) return;
		if (!matchesPrefix(event.toolName, cfg.prefixes)) return;
		if (cfg.whitelist.includes(event.toolName)) return;

		const rawText = event.content
			.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof (c as { text?: string }).text === "string")
			.map((c) => c.text)
			.join("\n");
		if (!rawText) return;

		const summary = summarize(rawText, event.isError, event.toolName, cfg.maxLineLen);
		return {
			content: [{ type: "text", text: summary }],
		};
	});
}
