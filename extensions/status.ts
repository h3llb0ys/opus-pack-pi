/**
 * Status Indicator — /status slash + persistent footer counter.
 *
 * Rolls up: loaded extensions, skills, prompts, MCP tool count, hooks,
 * current model + thinking level, session turns + cost + ctx usage.
 *
 * pi out-of-the-box only renders these blocks at session start. /status
 * lets you re-check at any moment; footer shows compact ext/skills/mcp.
 */

import { exec } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

interface ShellStatusConfig {
	command: string;
	timeoutMs: number;
}

const DEFAULT_SHELL_STATUS: ShellStatusConfig = { command: "", timeoutMs: 500 };

const runShellLine = (cfg: ShellStatusConfig, cwd: string): Promise<string> =>
	new Promise((resolve) => {
		if (!cfg.command.trim()) {
			resolve("");
			return;
		}
		exec(
			cfg.command,
			{ cwd, timeout: Math.max(50, cfg.timeoutMs), windowsHide: true, maxBuffer: 64 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve("");
					return;
				}
				const firstLine = String(stdout).split("\n").find((l) => l.trim().length > 0) ?? "";
				resolve(firstLine.trim().slice(0, 200));
			},
		);
	});

const renderFooter = (ext: number, skills: number, mcp: number) =>
	`ext:${ext} skills:${skills} mcp:${mcp}`;

const basename = (p: string) => {
	const i = p.lastIndexOf("/");
	return i >= 0 ? p.slice(i + 1) : p;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("status")) return;
	const refreshFooter = (ctx: ExtensionContext) => {
		try {
			const cmds = pi.getCommands();
			const ext = cmds.filter((c) => c.source === "extension").length;
			const skills = cmds.filter((c) => c.source === "skill").length;
			const tools = pi.getAllTools();
			const mcp = tools.filter((t) => /^mcp(_|$)/i.test(t.name)).length;
			ctx.ui.setStatus("90-pack", renderFooter(ext, skills, mcp));
		} catch {
			// pi internals may not be ready; ignore.
		}
	};

	const refreshStatusline = async (ctx: ExtensionContext) => {
		try {
			let branch = "";
			try {
				const b = await pi.exec("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: ctx.cwd, timeout: 500 });
				if (b.code === 0) branch = b.stdout.trim();
			} catch { /* ignore */ }
			const dir = basename(ctx.cwd) || ctx.cwd;
			// CC-style: dir in accent (blue on default themes), branch muted.
			const dirColoured = ctx.ui.theme.fg("accent", dir);
			const label = branch
				? `${dirColoured} ${ctx.ui.theme.fg("muted", `(${branch})`)}`
				: dirColoured;
			ctx.ui.setStatus("80-line", label);
		} catch {
			// ignore
		}
	};

	const refreshShellLine = async (ctx: ExtensionContext) => {
		const cfg = loadOpusPackSection("statusLine", DEFAULT_SHELL_STATUS);
		if (!cfg.command.trim()) {
			ctx.ui.setStatus("85-shell", undefined);
			return;
		}
		const out = await runShellLine(cfg, ctx.cwd);
		ctx.ui.setStatus("85-shell", out || undefined);
	};

	const refreshQueue = (ctx: ExtensionContext) => {
		try {
			ctx.ui.setStatus(
				"92-queue",
				ctx.hasPendingMessages() ? ctx.ui.theme.fg("warning", "queued") : undefined,
			);
		} catch { /* ignore */ }
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshFooter(ctx);
		void refreshStatusline(ctx);
		void refreshShellLine(ctx);
		refreshQueue(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		refreshFooter(ctx);
		void refreshStatusline(ctx);
		void refreshShellLine(ctx);
		refreshQueue(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		refreshQueue(ctx);
	});
	pi.on("message_end", async (_event, ctx) => {
		refreshQueue(ctx);
	});


	pi.registerCommand("status", {
		description: "Show pi status: extensions, skills, MCP tools, model, session, hooks",
		handler: async (_args, ctx) => {
			const cmds = pi.getCommands();
			const tools = pi.getAllTools();
			const active = new Set(pi.getActiveTools());

			const skills = cmds.filter((c) => c.source === "skill");
			const exts = cmds.filter((c) => c.source === "extension");
			const prompts = cmds.filter((c) => c.source === "prompt");
			const mcpTools = tools.filter((t) => /^mcp(_|$)/i.test(t.name));
			const builtinTools = tools.filter((t) => !/^mcp(_|$)/i.test(t.name) && !exts.some((e) => e.name === t.name));

			const model = ctx.model;
			const usage = ctx.getContextUsage();
			const usagePct = usage?.percent ?? undefined;
			let turns: number | string = "?";
			try {
				const entries = ctx.sessionManager?.getEntries?.() ?? [];
				turns = entries.filter((e: { type?: string }) => e?.type === "message").length;
			} catch { /* ignore */ }

			const lines = [
				"═ pi status ═",
				`Model        : ${(model as { id?: string } | undefined)?.id ?? "unknown"}  (thinking: ${pi.getThinkingLevel?.() ?? "n/a"})`,
				`Session      : ${turns} entries${usagePct !== undefined ? `, ${usagePct}% ctx` : ""}`,
				`Extensions   : ${exts.length} commands from extensions`,
				`Skills       : ${skills.length} loaded`,
				`Prompts      : ${prompts.length} loaded`,
				`MCP tools    : ${mcpTools.length}`,
				`Tools active : ${active.size} / ${tools.length} (${builtinTools.length} builtin + ${exts.length} ext + ${mcpTools.length} mcp)`,
				`cwd          : ${ctx.cwd}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
			refreshFooter(ctx);
		},
	});
}
