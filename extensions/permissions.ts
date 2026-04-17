/**
 * Permissions — granular allow/deny/confirm per tool and path.
 *
 * Config in settings.json under opus-pack.permissions:
 *   { default: "confirm"|"allow"|"deny", rules: [{ tool, path?, pattern?, action }] }
 * First match wins. safe-deny.ts still runs as hardcoded safety net.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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

export default function (pi: ExtensionAPI) {
	let config: PermissionsConfig | null = null;

	pi.on("session_start", async () => {
		config = loadConfig();
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
				...config.rules.map((r, i) => {
					const target = r.path ? `path:${r.path}` : r.pattern ? `pattern:${r.pattern}` : "*";
					return `${i + 1}. ${r.tool} ${target} → ${r.action}`;
				}),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config) return;
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return;

		const input = event.input as Record<string, unknown>;
		let action: Action = config.default;

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
			const cmd = event.toolName === "bash"
				? String(input["command"] ?? "")
				: String(input["path"] ?? input["file_path"] ?? "");
			const ok = await ctx.ui.confirm(
				`Allow ${event.toolName}?`,
				cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd,
				{ timeout: 15000 },
			);
			if (!ok) return { block: true, reason: `permissions: user denied ${event.toolName}.` };
		}
	});
}
