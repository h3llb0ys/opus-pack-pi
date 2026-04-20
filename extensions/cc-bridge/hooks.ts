/**
 * cc-bridge/hooks — Claude-Code-style declarative shell hooks, two sources.
 *
 * 1. Legacy source (back-compat with pre-refactor behaviour): the `hooks`
 *    block inside ~/.pi/agent/settings.json and <cwd>/.pi/settings.json
 *    with the CC schema:
 *      { "PreToolUse": [{ matcher, hooks: [{ type:"command", command, timeout }] }] }
 *
 * 2. File-tree source: ~/.{claude,codex,gemini,pi}/hooks/*.md and
 *    <cwd>/.{claude,codex,gemini,pi}/hooks/*.md. Each file is a single
 *    hook:
 *      ---
 *      event: PreToolUse   # required
 *      matcher: bash       # optional (regex or substring on tool name)
 *      timeout: 5          # optional, seconds, default 5
 *      ---
 *      #!/bin/bash
 *      # script body — receives JSON on stdin, writes JSON on stdout
 *
 * Effective hook list per event = legacy ++ file-based, preserving source
 * order within each group. Project file-tree fires after user file-tree,
 * matching CC's additive-array semantics.
 *
 * Each shell command receives a JSON payload on stdin (CC-shape). Stdout
 * parsed as { block?, reason?, hookSpecificOutput? }. Invalid JSON is
 * treated as non-blocking (defensive). Default timeout: 5s.
 */

import { spawn } from "node:child_process";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadSettingsRoot } from "../../lib/settings.js";
import { findVendorResources } from "./lib/paths.js";
import { parseFrontmatter, walkFiles } from "./lib/md-frontmatter.js";
import type { CcBridgeState } from "./state.js";

const TOGGLE_KEY = "cc-bridge.hooks";
const LEGACY_TOGGLE_KEY = "hook-bridge";

type HookEventName =
	| "SessionStart"
	| "SessionEnd"
	| "UserPromptSubmit"
	| "PreToolUse"
	| "PostToolUse"
	| "Stop"
	| "PreCompact";

type HookEntry = { type?: "command"; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type HookConfig = Partial<Record<HookEventName, HookGroup[]>>;

const DEFAULT_TIMEOUT_MS = 5000;
const HOOK_EVENTS: readonly HookEventName[] = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"PreCompact",
];

// ─── Legacy (settings.json) source ──────────────────────────────────────────

const readLegacyConfig = (path: string): HookConfig => {
	if (path === "settings-root") {
		const parsed = loadSettingsRoot();
		return (parsed?.hooks as HookConfig) ?? {};
	}
	try {
		const raw = readFileSync(path, "utf8");
		return ((JSON.parse(raw) as { hooks?: HookConfig })?.hooks) ?? {};
	} catch {
		return {};
	}
};

const loadLegacyHooks = (cwd: string): HookConfig => {
	const global = readLegacyConfig("settings-root");
	const project = readLegacyConfig(join(cwd, ".pi/settings.json"));
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

// ─── File-tree source ───────────────────────────────────────────────────────

interface FileHook {
	event: HookEventName;
	matcher?: string;
	command: string;
	timeoutMs: number;
	sourceFile: string;
	scope: "project" | "user";
}

interface HookFrontmatter {
	event?: string;
	matcher?: string;
	timeout?: number;
}

const makeExecutable = (path: string): void => {
	try {
		const st = statSync(path);
		// already has any exec bit — leave it
		if ((st.mode & 0o111) !== 0) return;
		chmodSync(path, st.mode | 0o100); // owner-exec only
	} catch {
		// best-effort
	}
};

const loadFileHooks = (cwd: string): FileHook[] => {
	const out: FileHook[] = [];
	// user scope first, project last — project wins on later iteration
	for (const scope of ["user", "project"] as const) {
		const roots = findVendorResources(cwd, "hooks", [scope]);
		for (const root of roots) {
			for (const full of walkFiles(root.path, { extensions: [".md", ".sh"] })) {
				const parsed = parseHookFile(full);
				if (!parsed) continue;
				out.push({ ...parsed, sourceFile: full, scope });
			}
		}
	}
	return out;
};

const parseHookFile = (full: string): Omit<FileHook, "sourceFile" | "scope"> | null => {
	let raw: string;
	try {
		raw = readFileSync(full, "utf8");
	} catch {
		return null;
	}
	const { frontmatter, body } = parseFrontmatter<HookFrontmatter & Record<string, unknown>>(raw);
	const event = frontmatter?.event;
	if (!event || !HOOK_EVENTS.includes(event as HookEventName)) {
		// silently skip files without a valid event — lets users keep README.md
		// alongside hook files without the loader shouting at them
		return null;
	}
	const matcher = frontmatter?.matcher ? String(frontmatter.matcher) : undefined;
	const timeoutMs = (typeof frontmatter?.timeout === "number" ? frontmatter.timeout : 5) * 1000;
	const scriptBody = body.trim();
	if (!scriptBody) return null;
	// For .sh files we run the file directly; for .md we inline the body
	// through `sh -c` just like the legacy settings.json hooks do.
	if (full.endsWith(".sh")) {
		makeExecutable(full);
		return { event: event as HookEventName, matcher, command: full, timeoutMs };
	}
	return { event: event as HookEventName, matcher, command: scriptBody, timeoutMs };
};

// ─── Execution ──────────────────────────────────────────────────────────────

interface HookOutput {
	block?: boolean;
	reason?: string;
	hookSpecificOutput?: unknown;
}

const matcherMatches = (matcher: string | undefined, value: string): boolean => {
	if (!matcher) return true;
	if (matcher === value) return true;
	try {
		return new RegExp(matcher).test(value);
	} catch {
		return value.includes(matcher);
	}
};

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
		child.stdout.on("data", (d) => { stdout += String(d); });
		child.stderr.on("data", (d) => { stderr += String(d); });
		child.on("error", () => { clearTimeout(timer); resolve(null); });
		child.on("close", () => {
			clearTimeout(timer);
			if (stderr) process.stderr.write(`[cc-bridge/hooks] ${cmd}\n${stderr}`);
			const trimmed = stdout.trim();
			if (!trimmed) return resolve(null);
			try { resolve(JSON.parse(trimmed) as HookOutput); }
			catch { resolve(null); }
		});
		try { child.stdin.end(JSON.stringify(payload)); }
		catch { clearTimeout(timer); resolve(null); }
	});

interface EffectiveHook {
	matcher?: string;
	command: string;
	timeoutMs: number;
}

const effectiveFor = (event: HookEventName, cwd: string): EffectiveHook[] => {
	const out: EffectiveHook[] = [];
	// legacy first
	const legacy = loadLegacyHooks(cwd)[event] ?? [];
	for (const grp of legacy) {
		for (const h of grp.hooks ?? []) {
			if (h.type !== undefined && h.type !== "command") continue;
			out.push({
				matcher: grp.matcher,
				command: h.command,
				timeoutMs: h.timeout !== undefined ? h.timeout * 1000 : DEFAULT_TIMEOUT_MS,
			});
		}
	}
	// file-tree next
	for (const fh of loadFileHooks(cwd)) {
		if (fh.event !== event) continue;
		out.push({ matcher: fh.matcher, command: fh.command, timeoutMs: fh.timeoutMs });
	}
	return out;
};

const runBlocking = async (event: HookEventName, cwd: string, matcherValue: string | undefined, payload: unknown): Promise<HookOutput | null> => {
	for (const h of effectiveFor(event, cwd)) {
		if (matcherValue !== undefined && !matcherMatches(h.matcher, matcherValue)) continue;
		const out = await runShellHook(h.command, payload, h.timeoutMs);
		if (out?.block) return out;
	}
	return null;
};

const runFireAndForget = async (event: HookEventName, cwd: string, matcherValue: string | undefined, payload: unknown): Promise<void> => {
	for (const h of effectiveFor(event, cwd)) {
		if (matcherValue !== undefined && !matcherMatches(h.matcher, matcherValue)) continue;
		void runShellHook(h.command, payload, h.timeoutMs);
	}
};

// ─── State publishing ───────────────────────────────────────────────────────

const publishState = (state: CcBridgeState, cwd: string): void => {
	const legacy = loadLegacyHooks(cwd);
	const legacyEntries: CcBridgeState["hooks"]["legacy"] = [];
	for (const evt of HOOK_EVENTS) {
		for (const grp of legacy[evt] ?? []) {
			for (const h of grp.hooks ?? []) {
				if (h.type !== undefined && h.type !== "command") continue;
				legacyEntries.push({
					event: evt,
					matcher: grp.matcher,
					command: h.command,
					timeout: h.timeout ?? DEFAULT_TIMEOUT_MS / 1000,
					source: "settings.json",
				});
			}
		}
	}
	const fileBased: CcBridgeState["hooks"]["fileBased"] = loadFileHooks(cwd).map((fh) => ({
		event: fh.event,
		matcher: fh.matcher,
		file: fh.sourceFile,
		timeout: fh.timeoutMs / 1000,
		scope: fh.scope,
	}));
	state.hooks = { enabled: true, legacy: legacyEntries, fileBased };
};

// ─── Entry ──────────────────────────────────────────────────────────────────

export default function register(pi: ExtensionAPI, state: CcBridgeState): void {
	if (isExtensionDisabled(TOGGLE_KEY) || isExtensionDisabled(LEGACY_TOGGLE_KEY)) {
		state.hooks = { enabled: false, legacy: [], fileBased: [] };
		return;
	}

	pi.on("session_start", async (event, ctx) => {
		publishState(state, ctx.cwd);
		await runFireAndForget("SessionStart", ctx.cwd, undefined, {
			hook_event_name: "SessionStart",
			cwd: ctx.cwd,
			reason: event.reason,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await runFireAndForget("SessionEnd", ctx.cwd, undefined, {
			hook_event_name: "SessionEnd",
			cwd: ctx.cwd,
		});
	});

	pi.on("agent_end", async (_event, ctx) => {
		await runFireAndForget("Stop", ctx.cwd, undefined, {
			hook_event_name: "Stop",
			cwd: ctx.cwd,
		});
	});

	pi.on("input", async (event, ctx) => {
		const out = await runBlocking("UserPromptSubmit", ctx.cwd, undefined, {
			hook_event_name: "UserPromptSubmit",
			cwd: ctx.cwd,
			prompt: event.text,
		});
		if (out?.block) return { action: "handled" };
		return undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const out = await runBlocking("PreToolUse", ctx.cwd, event.toolName, {
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
		await runFireAndForget("PostToolUse", ctx.cwd, event.toolName, {
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
		await runFireAndForget("PreCompact", ctx.cwd, undefined, {
			hook_event_name: "PreCompact",
			cwd: ctx.cwd,
		});
	});
}
