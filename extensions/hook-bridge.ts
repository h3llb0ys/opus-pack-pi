/**
 * Hook Bridge — Claude Code-style declarative shell hooks for pi.
 *
 * Reads `hooks` block from ~/.pi/agent/settings.json and .pi/settings.json
 * (project overrides global), wires shell commands to pi events.
 *
 * Config format is 1:1 with Claude Code:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "bash",
 *         "hooks": [{ "type": "command", "command": "/path/to/check.sh", "timeout": 5 }]
 *       }],
 *       "Stop": [{ "hooks": [{ "type": "command", "command": "..." }] }]
 *     }
 *   }
 *
 * Each shell command receives a JSON payload on stdin (CC-shape).
 * Stdout is parsed as JSON: { block?: bool, reason?: string, hookSpecificOutput?: any }.
 * Invalid JSON → not blocking (defensive). Timeout default: 5s.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadSettingsRoot } from "../lib/settings.js";

type HookEntry = { type?: "command"; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type HookConfig = Partial<Record<HookEventName, HookGroup[]>>;

type HookEventName =
	| "SessionStart"
	| "SessionEnd"
	| "UserPromptSubmit"
	| "PreToolUse"
	| "PostToolUse"
	| "Stop"
	| "PreCompact";

const DEFAULT_TIMEOUT_MS = 5000;

const SETTINGS_PATH = join(
	process.env.HOME ?? "/dev/null",
	".pi/agent/settings.json",
);

const safeReadJson = (path: string): HookConfig => {
	if (path === SETTINGS_PATH) {
		const parsed = loadSettingsRoot();
		return (parsed?.hooks as HookConfig) ?? {};
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		return (parsed?.hooks as HookConfig) ?? {};
	} catch {
		return {};
	}
};

/**
 * Merge global and project hook configs. Project hooks come AFTER global,
 * so they fire later — same as CC's effective semantics for additive arrays.
 */
const loadHooks = (cwd: string): HookConfig => {
	const global = safeReadJson(SETTINGS_PATH);
	const project = safeReadJson(join(cwd, ".pi/settings.json"));
	const merged: HookConfig = {};
	for (const cfg of [global, project]) {
		for (const [evt, groups] of Object.entries(cfg)) {
			if (!groups) continue;
			const key = evt as HookEventName;
			merged[key] = (merged[key] ?? []).concat(groups);
		}
	}
	return merged;
};

const matcherMatches = (matcher: string | undefined, value: string): boolean => {
	if (!matcher) return true;
	if (matcher === value) return true;
	try {
		return new RegExp(matcher).test(value);
	} catch {
		return value.includes(matcher);
	}
};

interface HookOutput {
	block?: boolean;
	reason?: string;
	hookSpecificOutput?: unknown;
}

const runShellHook = (cmd: string, payload: unknown, timeoutMs: number): Promise<HookOutput | null> =>
	new Promise((resolve) => {
		const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", cmd], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve(null);
		}, timeoutMs);

		child.stdout.on("data", (d) => {
			stdout += String(d);
		});
		child.stderr.on("data", (d) => {
			stderr += String(d);
		});

		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});

		child.on("close", () => {
			clearTimeout(timer);
			if (stderr) {
				// preserve stderr as a side channel; surfaced through pi notify path elsewhere
				process.stderr.write(`[hook-bridge] ${cmd}\n${stderr}`);
			}
			const trimmed = stdout.trim();
			if (!trimmed) return resolve(null);
			try {
				resolve(JSON.parse(trimmed) as HookOutput);
			} catch {
				resolve(null);
			}
		});

		try {
			child.stdin.end(JSON.stringify(payload));
		} catch {
			clearTimeout(timer);
			resolve(null);
		}
	});

const runGroupsBlocking = async (
	groups: HookGroup[] | undefined,
	matcherValue: string | undefined,
	payload: unknown,
): Promise<HookOutput | null> => {
	if (!groups) return null;
	for (const grp of groups) {
		if (matcherValue !== undefined && !matcherMatches(grp.matcher, matcherValue)) continue;
		for (const h of grp.hooks ?? []) {
			if (h.type !== undefined && h.type !== "command") continue;
			const out = await runShellHook(h.command, payload, (h.timeout !== undefined ? h.timeout * 1000 : DEFAULT_TIMEOUT_MS));
			if (out?.block) return out;
		}
	}
	return null;
};

const runGroupsFireAndForget = async (
	groups: HookGroup[] | undefined,
	matcherValue: string | undefined,
	payload: unknown,
): Promise<void> => {
	if (!groups) return;
	for (const grp of groups) {
		if (matcherValue !== undefined && !matcherMatches(grp.matcher, matcherValue)) continue;
		for (const h of grp.hooks ?? []) {
			if (h.type !== undefined && h.type !== "command") continue;
			void runShellHook(h.command, payload, (h.timeout !== undefined ? h.timeout * 1000 : DEFAULT_TIMEOUT_MS));
		}
	}
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("hook-bridge")) return;
	pi.on("session_start", async (event, ctx) => {
		const hooks = loadHooks(ctx.cwd);
		await runGroupsFireAndForget(hooks.SessionStart, undefined, {
			hook_event_name: "SessionStart",
			cwd: ctx.cwd,
			reason: event.reason,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const hooks = loadHooks(ctx.cwd);
		await runGroupsFireAndForget(hooks.SessionEnd, undefined, {
			hook_event_name: "SessionEnd",
			cwd: ctx.cwd,
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		const hooks = loadHooks(ctx.cwd);
		await runGroupsFireAndForget(hooks.Stop, undefined, {
			hook_event_name: "Stop",
			cwd: ctx.cwd,
		});
	});

	pi.on("input", async (event, ctx) => {
		const hooks = loadHooks(ctx.cwd);
		const out = await runGroupsBlocking(hooks.UserPromptSubmit, undefined, {
			hook_event_name: "UserPromptSubmit",
			cwd: ctx.cwd,
			prompt: event.text,
		});
		if (out?.block) return { action: "handled" };
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const hooks = loadHooks(ctx.cwd);
		const out = await runGroupsBlocking(hooks.PreToolUse, event.toolName, {
			hook_event_name: "PreToolUse",
			cwd: ctx.cwd,
			tool_name: event.toolName,
			tool_input: event.input,
			tool_use_id: event.toolCallId,
		});
		if (out?.block) {
			return { block: true, reason: out.reason ?? "Blocked by hook" };
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const hooks = loadHooks(ctx.cwd);
		await runGroupsFireAndForget(hooks.PostToolUse, event.toolName, {
			hook_event_name: "PostToolUse",
			cwd: ctx.cwd,
			tool_name: event.toolName,
			tool_input: event.input,
			tool_response: event.content,
			tool_use_id: event.toolCallId,
			is_error: event.isError,
		});
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		const hooks = loadHooks(ctx.cwd);
		await runGroupsFireAndForget(hooks.PreCompact, undefined, {
			hook_event_name: "PreCompact",
			cwd: ctx.cwd,
		});
	});
}
