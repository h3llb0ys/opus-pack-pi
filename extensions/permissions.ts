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
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

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

const SETTINGS_PATH = join(homedir(), ".pi/agent/settings.json");
const LOCAL_SETTINGS_PATH = join(homedir(), ".pi/agent/settings.local.json");

const loadConfig = (): PermissionsConfig | null => {
	try {
		const raw = readFileSync(SETTINGS_PATH, "utf8");
		const parsed = JSON.parse(raw);
		const main = parsed?.["opus-pack"]?.["permissions"] ?? null;
		// Merge in local overrides (allow-always rules persisted from prior prompts).
		let localRules: Rule[] = [];
		if (existsSync(LOCAL_SETTINGS_PATH)) {
			try {
				const localRaw = readFileSync(LOCAL_SETTINGS_PATH, "utf8");
				const localParsed = JSON.parse(localRaw);
				localRules = localParsed?.["opus-pack"]?.["permissions"]?.["rules"] ?? [];
			} catch { /* ignore */ }
		}
		if (!main) {
			return localRules.length > 0
				? { default: "confirm", rules: localRules, interactive: true }
				: null;
		}
		// Local rules evaluated FIRST (they were user's explicit persistent decisions).
		return { ...main, rules: [...localRules, ...(main.rules ?? [])] };
	} catch {
		return null;
	}
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

// Build a diff preview for edit tool calls
const buildEditPreview = (input: Record<string, unknown>): string => {
	const filePath = String(input["path"] ?? input["file_path"] ?? "");
	const edits = input["edits"] as Array<{ oldText: string; newText: string }> | undefined;

	if (!edits || edits.length === 0) {
		// Single oldText/newText format
		const oldText = String(input["oldText"] ?? "");
		const newText = String(input["newText"] ?? "");
		if (!oldText && !newText) return filePath;
		return `${filePath}\n${formatMiniDiff(oldText, newText)}`;
	}

	const parts = edits.map((e, i) => {
		const oldLines = e.oldText.split("\n");
		const newLines = e.newText.split("\n");
		const maxPreview = 8;
		const oldPreview = oldLines.slice(0, maxPreview).map((l) => `- ${l}`).join("\n");
		const newPreview = newLines.slice(0, maxPreview).map((l) => `+ ${l}`).join("\n");
		const suffix = oldLines.length > maxPreview ? `\n  ... (${oldLines.length} lines)` : "";
		return `@@ edit ${i + 1} @@\n${oldPreview}\n${newPreview}${suffix}`;
	});

	return `${filePath}\n${parts.join("\n")}`;
};

const formatMiniDiff = (oldText: string, newText: string): string => {
	const oldLines = oldText.split("\n").slice(0, 6).map((l) => `- ${l}`);
	const newLines = newText.split("\n").slice(0, 6).map((l) => `+ ${l}`);
	return [...oldLines, ...newLines].join("\n");
};

// Build preview for write tool calls (new file content)
const buildWritePreview = (input: Record<string, unknown>, cwd: string): string => {
	const filePath = String(input["path"] ?? input["file_path"] ?? "");
	const content = String(input["content"] ?? "");
	const absPath = filePath.startsWith("/") ? filePath : resolve(cwd, filePath);

	if (!existsSync(absPath)) {
		// New file
		const lines = content.split("\n").slice(0, 8).map((l) => `+ ${l}`).join("\n");
		const total = content.split("\n").length;
		const suffix = total > 8 ? `\n... (${total} lines total)` : "";
		return `${filePath} (NEW FILE)\n${lines}${suffix}`;
	}

	// Existing file — show what's being replaced
	const lines = content.split("\n").slice(0, 5).map((l) => `+ ${l}`).join("\n");
	const total = content.split("\n").length;
	return `${filePath} (REWRITE, ${total} lines)\n${lines}`;
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

	pi.on("session_start", async () => {
		config = loadConfig();
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
				preview = buildEditPreview(input);
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
