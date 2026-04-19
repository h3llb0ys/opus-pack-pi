/**
 * Permissions — granular allow/deny/confirm per tool and path.
 *
 * Config in settings.json under opus-pack.permissions:
 *   {
 *     default: "confirm"|"allow"|"deny",
 *     smart: true,
 *     rules: [{ tool, path?, pattern?, action }]
 *   }
 * First match wins. safe-deny.ts still runs as hardcoded safety net.
 *
 * Smart mode: track files the agent has read in this session.
 * Edits to read files → auto-approve. New/critical paths → confirm.
 *
 * Diff preview: in confirm mode for edit/write, shows a unified diff
 * of what will change before asking the user.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	isExtensionDisabled,
	loadLocalSettingsRoot,
	loadProjectLocalSettingsRoot,
	loadProjectSettingsRoot,
	loadSettingsRoot,
} from "../lib/settings.js";

type Action = "allow" | "confirm" | "deny";

interface Rule {
	tool: string;
	path?: string;
	pattern?: string;
	action: Action;
}

interface PermissionsConfig {
	default: Action;
	smart?: boolean;
	interactive?: boolean; // 4-way prompt instead of confirm
	rules: Rule[];
}

const LOCAL_SETTINGS_PATH = join(homedir(), ".pi/agent/settings.local.json");

const extractRules = (root: any): Rule[] => {
	const rules = root?.["opus-pack"]?.["permissions"]?.["rules"];
	return Array.isArray(rules) ? rules : [];
};

const extractBase = (root: any): Partial<PermissionsConfig> | null => {
	const block = root?.["opus-pack"]?.["permissions"];
	if (!block || typeof block !== "object") return null;
	const { rules: _drop, ...rest } = block;
	return rest;
};

/**
 * Load permissions config merged across four layers (higher = more specific,
 * matched first):
 *   1. <cwd>/.pi/settings.local.json — project-local user decisions
 *   2. <cwd>/.pi/settings.json       — project-shared policy (committed)
 *   3. ~/.pi/agent/settings.local.json — global local overrides
 *   4. ~/.pi/agent/settings.json       — global baseline
 *
 * Defaults (default/smart/interactive) come from the most specific layer that
 * provides them; rules are concatenated in the above order so specific matches
 * win on first-match-wins.
 */
const loadConfig = (cwd: string): PermissionsConfig | null => {
	const roots = [
		loadProjectLocalSettingsRoot(cwd),
		loadProjectSettingsRoot(cwd),
		loadLocalSettingsRoot(),
		loadSettingsRoot(),
	];

	const allRules: Rule[] = roots.flatMap(extractRules);
	const bases = roots.map(extractBase);

	// Pick the most specific base that actually defines a default; everything
	// else falls back to sensible defaults so a .pi/settings.json with only
	// `rules: [...]` still works.
	let merged: Partial<PermissionsConfig> = {};
	for (const b of bases) {
		if (!b) continue;
		merged = { ...b, ...merged }; // earlier (more specific) wins; fill missing keys
	}

	if (allRules.length === 0 && !merged.default) return null;

	return {
		default: (merged.default as Action) ?? "confirm",
		smart: merged.smart ?? false,
		interactive: merged.interactive ?? true,
		rules: allRules,
	};
};

type PersistResult =
	| { saved: true }
	| { saved: false; reason: "duplicate" }
	| { saved: false; reason: "io-failed"; error: string };

const persistAllowAlways = (rule: Rule): PersistResult => {
	try {
		let data: any = {};
		if (existsSync(LOCAL_SETTINGS_PATH)) {
			try { data = JSON.parse(readFileSync(LOCAL_SETTINGS_PATH, "utf8")); } catch { /* overwrite */ }
		}
		if (!data["opus-pack"]) data["opus-pack"] = {};
		if (!data["opus-pack"]["permissions"]) data["opus-pack"]["permissions"] = { rules: [] };
		if (!Array.isArray(data["opus-pack"]["permissions"]["rules"])) data["opus-pack"]["permissions"]["rules"] = [];
		const existing: Rule[] = data["opus-pack"]["permissions"]["rules"];
		const isDup = existing.some((r) => r.tool === rule.tool && r.path === rule.path && r.pattern === rule.pattern && r.action === rule.action);
		if (isDup) return { saved: false, reason: "duplicate" };
		existing.push(rule);
		const tmp = `${LOCAL_SETTINGS_PATH}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, LOCAL_SETTINGS_PATH);
		return { saved: true };
	} catch (e) {
		return { saved: false, reason: "io-failed", error: (e as Error).message };
	}
};

const buildAllowRule = (toolName: string, input: Record<string, unknown>, cwd: string): Rule => {
	if (toolName === "bash") {
		const cmd = String(input["command"] ?? "");
		// Pattern: escaped prefix + wildcard.
		const firstToken = cmd.trim().split(/\s+/)[0] ?? "";
		const safeToken = firstToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return { tool: "bash", pattern: `^${safeToken}\\b`, action: "allow" };
	}
	const raw = String(input["path"] ?? input["file_path"] ?? "");
	if (!raw) return { tool: toolName, action: "allow" };
	const abs = raw.startsWith("/") ? raw : resolve(cwd, raw);
	const rel = abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
	// Generalize to glob for the directory.
	const parts = rel.split("/");
	if (parts.length > 1) {
		parts[parts.length - 1] = "**";
		return { tool: toolName, path: parts.join("/"), action: "allow" };
	}
	return { tool: toolName, path: rel, action: "allow" };
};

const matchRule = (rule: Rule, toolName: string, toolInput: Record<string, unknown>, cwd: string): boolean => {
	if (rule.tool !== "*" && rule.tool !== toolName) return false;

	if (rule.path) {
		const rawPath = String(toolInput["path"] ?? toolInput["file_path"] ?? "");
		if (!rawPath) return false;
		const abs = rawPath.startsWith("/") ? rawPath : resolve(cwd, rawPath);
		const rel = abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
		if (!minimatch(rel, rule.path)) return false;
	}

	if (rule.pattern) {
		const cmd = String(toolInput["command"] ?? "");
		try {
			if (!new RegExp(rule.pattern).test(cmd)) return false;
		} catch {
			return false;
		}
	}

	return true;
};

/**
 * Naive line-diff with small lookahead. Not LCS-optimal but catches the
 * common shapes (inserted block, deleted block, modified line) without
 * pulling in a diff dependency. Output is a list of hunks of the form:
 *   " context"
 *   "-old"
 *   "+new"
 * Truncated at MAX_DIFF_LINES so a huge rewrite doesn't spam the prompt.
 */
const LOOKAHEAD = 3;
const MAX_DIFF_LINES = 40;
const CONTEXT_LINES = 2;

interface DiffLine { tag: " " | "-" | "+"; text: string; aLine?: number; bLine?: number }

const naiveLineDiff = (oldText: string, newText: string): DiffLine[] => {
	const A = oldText.split("\n");
	const B = newText.split("\n");
	const out: DiffLine[] = [];
	let i = 0, j = 0;
	while (i < A.length && j < B.length) {
		if (A[i] === B[j]) {
			out.push({ tag: " ", text: A[i], aLine: i + 1, bLine: j + 1 });
			i++; j++;
			continue;
		}
		// Is A[i] a few lines ahead in B? Then B inserted lines.
		let inserted = -1;
		for (let k = 1; k <= LOOKAHEAD && j + k < B.length; k++) {
			if (A[i] === B[j + k]) { inserted = k; break; }
		}
		if (inserted > 0) {
			for (let k = 0; k < inserted; k++) out.push({ tag: "+", text: B[j + k], bLine: j + 1 + k });
			j += inserted;
			continue;
		}
		// Is B[j] a few lines ahead in A? Then A deleted lines.
		let deleted = -1;
		for (let k = 1; k <= LOOKAHEAD && i + k < A.length; k++) {
			if (B[j] === A[i + k]) { deleted = k; break; }
		}
		if (deleted > 0) {
			for (let k = 0; k < deleted; k++) out.push({ tag: "-", text: A[i + k], aLine: i + 1 + k });
			i += deleted;
			continue;
		}
		// Neither side matches — treat as modified line pair.
		out.push({ tag: "-", text: A[i], aLine: i + 1 });
		out.push({ tag: "+", text: B[j], bLine: j + 1 });
		i++; j++;
	}
	// Tail.
	while (i < A.length) { out.push({ tag: "-", text: A[i], aLine: i + 1 }); i++; }
	while (j < B.length) { out.push({ tag: "+", text: B[j], bLine: j + 1 }); j++; }
	return out;
};

/**
 * Format a DiffLine sequence into hunks with limited context around changes.
 * Collapses long runs of unchanged lines between changes.
 */
const formatHunks = (diff: DiffLine[]): string => {
	// Identify change indices.
	const changed = diff.map((d, i) => (d.tag !== " " ? i : -1)).filter((i) => i >= 0);
	if (changed.length === 0) return "(no textual changes)";
	// Build ranges [start..end] of changes within CONTEXT_LINES of each other.
	const ranges: Array<[number, number]> = [];
	for (const ci of changed) {
		const lo = Math.max(0, ci - CONTEXT_LINES);
		const hi = Math.min(diff.length - 1, ci + CONTEXT_LINES);
		if (ranges.length && ranges[ranges.length - 1][1] >= lo - 1) {
			ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi);
		} else {
			ranges.push([lo, hi]);
		}
	}
	const lines: string[] = [];
	let emitted = 0;
	for (const [lo, hi] of ranges) {
		if (emitted >= MAX_DIFF_LINES) { lines.push(`  ... (truncated, ${diff.length - emitted} more lines)`); break; }
		const first = diff[lo];
		const anchor = first.aLine ?? first.bLine ?? 0;
		lines.push(`@@ line ${anchor} @@`);
		for (let k = lo; k <= hi; k++) {
			if (emitted >= MAX_DIFF_LINES) { lines.push(`  ... (truncated)`); break; }
			const d = diff[k];
			lines.push(`${d.tag} ${d.text}`);
			emitted++;
		}
	}
	return lines.join("\n");
};

// Build a diff preview for edit tool calls. Each edit hunk now carries an
// approximate line number derived from indexOf(oldText) in the current file
// contents (falls back to "?" when the file is absent or the oldText can't be
// located — e.g. edit against a staged but unread file).
const buildEditPreview = (input: Record<string, unknown>, cwd: string): string => {
	const filePath = String(input["path"] ?? input["file_path"] ?? "");
	const edits = input["edits"] as Array<{ oldText: string; newText: string }> | undefined;
	const absPath = filePath.startsWith("/") ? filePath : resolve(cwd, filePath);
	let source = "";
	try { source = existsSync(absPath) ? readFileSync(absPath, "utf8") : ""; } catch { /* ignore */ }
	const lineOf = (needle: string): number | null => {
		if (!source || !needle) return null;
		const idx = source.indexOf(needle);
		if (idx < 0) return null;
		return source.slice(0, idx).split("\n").length;
	};

	if (!edits || edits.length === 0) {
		const oldText = String(input["oldText"] ?? "");
		const newText = String(input["newText"] ?? "");
		if (!oldText && !newText) return filePath;
		const at = lineOf(oldText);
		const hunk = formatHunks(naiveLineDiff(oldText, newText));
		return `${filePath}${at ? ` (line ~${at})` : ""}\n${hunk}`;
	}

	const parts = edits.map((e, i) => {
		const at = lineOf(e.oldText);
		const hunk = formatHunks(naiveLineDiff(e.oldText, e.newText));
		return `@@ edit ${i + 1}${at ? `, line ~${at}` : ""} @@\n${hunk}`;
	});

	return `${filePath}\n${parts.join("\n")}`;
};

// Build preview for write tool calls. For new files: head of new content.
// For rewrites: real line-diff between disk and proposed content so the user
// sees what actually changes, not just the first few lines of the new file.
const buildWritePreview = (input: Record<string, unknown>, cwd: string): string => {
	const filePath = String(input["path"] ?? input["file_path"] ?? "");
	const content = String(input["content"] ?? "");
	const absPath = filePath.startsWith("/") ? filePath : resolve(cwd, filePath);

	if (!existsSync(absPath)) {
		const lines = content.split("\n").slice(0, 8).map((l) => `+ ${l}`).join("\n");
		const total = content.split("\n").length;
		const suffix = total > 8 ? `\n... (${total} lines total)` : "";
		return `${filePath} (NEW FILE)\n${lines}${suffix}`;
	}

	let old = "";
	try { old = readFileSync(absPath, "utf8"); } catch { /* fall through to head-only */ }
	if (!old) {
		const lines = content.split("\n").slice(0, 5).map((l) => `+ ${l}`).join("\n");
		const total = content.split("\n").length;
		return `${filePath} (REWRITE, ${total} lines — old contents unreadable)\n${lines}`;
	}
	if (old === content) {
		return `${filePath} (REWRITE, no textual change)`;
	}
	const diff = naiveLineDiff(old, content);
	const changedLines = diff.filter((d) => d.tag !== " ").length;
	const total = content.split("\n").length;
	return `${filePath} (REWRITE, ${total} lines, ${changedLines} changed)\n${formatHunks(diff)}`;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("permissions")) return;
	let config: PermissionsConfig | null = null;

	// Smart mode: track read files
	const readFiles = new Set<string>();
	// Session-scoped allow list for "allow for this session".
	const sessionAllowed: Rule[] = [];

	const matchesSessionAllowed = (toolName: string, input: Record<string, unknown>, cwd: string): boolean => {
		return sessionAllowed.some((rule) => matchRule(rule, toolName, input, cwd));
	};

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		readFiles.clear();
		sessionAllowed.length = 0;
	});

	// Track files the agent reads
	pi.on("tool_call", async (event) => {
		if (event.toolName === "read") {
			const rawPath = String((event.input as { path?: string; file_path?: string }).path
				?? (event.input as { file_path?: string }).file_path ?? "");
			if (rawPath) readFiles.add(rawPath);
		}
	});

	pi.registerCommand("permissions", {
		description: "Show current permission rules",
		handler: async (_args, ctx) => {
			if (!config) {
				ctx.ui.notify("No permission rules configured. Add opus-pack.permissions to settings.json.", "info");
				return;
			}
			const lines = [
				`Default: ${config.default}`,
				`Smart: ${config.smart ?? false}`,
				...config.rules.map((r, i) => {
					const target = r.path ? `path:${r.path}` : r.pattern ? `pattern:${r.pattern}` : "*";
					return `${i + 1}. ${r.tool} ${target} → ${r.action}`;
				}),
			];
			if (config.smart && readFiles.size > 0) {
				lines.push(`\nRead files (auto-approve): ${[...readFiles].slice(-10).join(", ")}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config) return;
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;

		const input = event.input as Record<string, unknown>;
		let action: Action = config.default;

		// Smart mode: auto-approve edits to files the agent has read
		if (config.smart && (event.toolName === "edit" || event.toolName === "write")) {
			const rawPath = String(input["path"] ?? input["file_path"] ?? "");
			if (rawPath && readFiles.has(rawPath)) {
				action = "allow";
			}
		}

		// Explicit rules override smart mode
		for (const rule of config.rules) {
			if (matchRule(rule, event.toolName, input, ctx.cwd)) {
				action = rule.action;
				break;
			}
		}

		if (action === "allow") return;
		if (action === "deny") {
			return { block: true, reason: `permissions: ${event.toolName} denied by rule.` };
		}
		if (action === "confirm") {
			if (!ctx.hasUI) return;

			// Session-scoped allow already granted for this match?
			if (matchesSessionAllowed(event.toolName, input, ctx.cwd)) return;

			// Build diff preview for edit/write.
			let preview: string;
			if (event.toolName === "edit") {
				preview = buildEditPreview(input, ctx.cwd);
			} else if (event.toolName === "write") {
				preview = buildWritePreview(input, ctx.cwd);
			} else {
				const cmd = String(input["command"] ?? "");
				preview = cmd.length > 400 ? cmd.slice(0, 400) + "…" : cmd;
			}

			// Interactive mode → 4-way prompt with persist. Default mode → legacy binary confirm.
			if (config.interactive) {
				const answer = await promptInteractive(ctx, event.toolName, preview);
				if (answer === "deny") return { block: true, reason: `permissions: user denied ${event.toolName}.` };
				if (answer === "once") return;
				const generalized = buildAllowRule(event.toolName, input, ctx.cwd);
				if (answer === "session") {
					sessionAllowed.push(generalized);
					return;
				}
				if (answer === "always") {
					sessionAllowed.push(generalized);
					const result = persistAllowAlways(generalized);
					if (result.saved) {
						ctx.ui.notify(`Saved allow rule to settings.local.json`, "info");
					} else if (result.reason === "duplicate") {
						ctx.ui.notify(`Rule already in settings.local.json — session-scoped allow applied`, "info");
					} else {
						ctx.ui.notify(`Failed to persist rule: ${result.error}`, "warning");
					}
					return;
				}
				// fallthrough: treat as deny on timeout/dismiss.
				return { block: true, reason: `permissions: no response for ${event.toolName}.` };
			}

			const ok = await ctx.ui.confirm(
				`Allow ${event.toolName}?`,
				preview,
				{ timeout: 15000 },
			);
			if (!ok) return { block: true, reason: `permissions: user denied ${event.toolName}.` };
		}
	});
}

type InteractiveAnswer = "once" | "session" | "always" | "deny" | "none";

const promptInteractive = async (ctx: ExtensionContext, toolName: string, preview: string): Promise<InteractiveAnswer> => {
	const options = [
		"Allow once",
		"Allow for this session",
		"Allow always (persist to settings.local.json)",
		"Deny",
	];
	ctx.ui.notify(`── ${toolName} preview ──\n${preview}`, "info");
	const picked = await ctx.ui.select(`Permission for ${toolName}?`, options, { timeout: 30_000 });
	if (!picked) return "none";
	if (picked === "Allow once") return "once";
	if (picked === "Allow for this session") return "session";
	if (picked.startsWith("Allow always")) return "always";
	if (picked === "Deny") return "deny";
	return "none";
};
