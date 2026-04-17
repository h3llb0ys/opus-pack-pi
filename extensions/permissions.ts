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

import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
	rules: Rule[];
}

const loadConfig = (): PermissionsConfig | null => {
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		return parsed?.["opus-pack"]?.["permissions"] ?? null;
	} catch {
		return null;
	}
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
	let config: PermissionsConfig | null = null;

	// Smart mode: track read files
	const readFiles = new Set<string>();

	pi.on("session_start", async () => {
		config = loadConfig();
		readFiles.clear();
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

			// Build diff preview for edit/write
			let preview: string;
			if (event.toolName === "edit") {
				preview = buildEditPreview(input);
			} else if (event.toolName === "write") {
				preview = buildWritePreview(input, ctx.cwd);
			} else {
				const cmd = String(input["command"] ?? "");
				preview = cmd.length > 400 ? cmd.slice(0, 400) + "…" : cmd;
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
