/**
 * log-tail — pi-native long-running task helpers.
 *
 * Opus launches detached processes with plain bash (`cmd > log 2>&1 & echo $! > pid`)
 * and uses these stateless tools to tail/kill them. No runtime process registry
 * lives in the extension — the source of truth is `/tmp/pi-bg-*.{log,pid}` on disk.
 *
 * Tools:
 *   log_tail(path, lines?, from?) — bounded incremental tail
 *   log_kill(pid? | pattern?)    — kill by PID or pkill pattern
 *   log_ps(pattern?)             — list matching processes
 *
 * UI:
 *   /bg                 — pick a running background task, view its tail or kill it
 *   status slot "bg:N"  — count of alive PIDs from /tmp/pi-bg-*.pid
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const BG_DIR = "/tmp";
const BG_PREFIX = "pi-bg-";
const MAX_OUTPUT_BYTES = 10 * 1024;
const ALLOWED_ROOTS = ["/tmp", "/var/log", "/var/folders", process.env.HOME ? join(process.env.HOME, ".pi") : ""].filter(Boolean);

interface BgEntry {
	slug: string;
	pidPath: string;
	logPath: string;
	pid: number | null;
	alive: boolean;
	cmd: string;
	logBytes: number;
	uptimeSec: number | null;
}

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const readPid = (path: string): number | null => {
	try {
		const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isFinite(n) && n > 0 ? n : null;
	} catch {
		return null;
	}
};

const pathAllowed = (path: string, cwd: string): boolean => {
	const abs = isAbsolute(path) ? path : resolve(cwd, path);
	if (abs.startsWith(cwd + "/") || abs === cwd) return true;
	return ALLOWED_ROOTS.some((root) => root && (abs === root || abs.startsWith(root + "/")));
};

const scanBgEntries = async (pi: ExtensionAPI): Promise<BgEntry[]> => {
	let files: string[] = [];
	try {
		files = readdirSync(BG_DIR).filter((f) => f.startsWith(BG_PREFIX) && f.endsWith(".pid"));
	} catch {
		return [];
	}
	const entries: BgEntry[] = [];
	for (const f of files) {
		const pidPath = join(BG_DIR, f);
		const slug = f.slice(BG_PREFIX.length, -".pid".length);
		const logPath = join(BG_DIR, `${BG_PREFIX}${slug}.log`);
		const pid = readPid(pidPath);
		const alive = pid !== null && isAlive(pid);
		let cmd = "";
		let uptimeSec: number | null = null;
		if (alive && pid !== null) {
			const ps = await pi.exec("ps", ["-p", String(pid), "-o", "args=,etimes="], {});
			if (ps.code === 0) {
				const out = ps.stdout.trim();
				const match = out.match(/^(.*?)\s+(\d+)\s*$/);
				if (match) {
					cmd = match[1].trim();
					uptimeSec = Number.parseInt(match[2], 10);
				} else {
					cmd = out;
				}
			}
		}
		let logBytes = 0;
		try {
			logBytes = statSync(logPath).size;
		} catch {
			// missing log is fine
		}
		entries.push({ slug, pidPath, logPath, pid, alive, cmd, logBytes, uptimeSec });
	}
	return entries;
};

const updateStatus = (ctx: ExtensionContext, entries: BgEntry[]) => {
	const alive = entries.filter((e) => e.alive).length;
	if (alive === 0) {
		ctx.ui.setStatus("03-bg", undefined);
	} else {
		ctx.ui.setStatus("03-bg", ctx.ui.theme.fg("accent", `bg:${alive}`));
	}
};

const fmtBytes = (n: number): string => {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${(n / 1024 / 1024).toFixed(1)}M`;
};

const fmtUptime = (sec: number | null): string => {
	if (sec === null) return "?";
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
};

const tailFile = (path: string, lines: number, from: number | undefined): { text: string; offset: number; truncated: boolean } => {
	const stats = statSync(path);
	const size = stats.size;
	let start = from ?? Math.max(0, size - MAX_OUTPUT_BYTES);
	if (start < 0) start = 0;
	if (start > size) return { text: "", offset: size, truncated: false };
	const buf = Buffer.alloc(Math.min(size - start, MAX_OUTPUT_BYTES));
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	let text = buf.toString("utf8");
	const truncated = size - start > MAX_OUTPUT_BYTES;
	if (from === undefined) {
		// Keep only the trailing `lines` lines.
		const arr = text.split("\n");
		if (arr.length > lines) {
			text = arr.slice(-lines).join("\n");
		}
	}
	return { text, offset: start + buf.length, truncated };
};

export default function (pi: ExtensionAPI) {
	// Status bar refresh on turn boundaries.
	pi.on("turn_end", async (_event, ctx) => {
		const entries = await scanBgEntries(pi);
		updateStatus(ctx, entries);
	});
	pi.on("session_start", async (_event, ctx) => {
		const entries = await scanBgEntries(pi);
		updateStatus(ctx, entries);
	});

	pi.registerTool({
		name: "log_tail",
		label: "Log tail",
		description:
			"Read the tail of a log file with a byte cap of 10KiB. " +
			"For long-running processes launched with `cmd > /tmp/pi-bg-<slug>.log 2>&1 & echo $! > /tmp/pi-bg-<slug>.pid`. " +
			"Pass `from` (byte offset returned by the previous call as `offset`) for incremental reads.",
		promptSnippet: "log_tail(path, lines?, from?) — bounded tail of a log file",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path to the log file." }),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Number of trailing lines when `from` is omitted (default 50)." })),
			from: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset to start reading from (for incremental reads)." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<{ offset: number; truncated: boolean }>> {
			if (!pathAllowed(params.path, ctx.cwd)) {
				return {
					content: [{ type: "text", text: `refused: ${params.path} is outside cwd and allowed log roots (${ALLOWED_ROOTS.join(", ")})` }],
					isError: true,
					details: { offset: 0, truncated: false },
				};
			}
			if (!existsSync(params.path)) {
				return {
					content: [{ type: "text", text: `not found: ${params.path}` }],
					isError: true,
					details: { offset: 0, truncated: false },
				};
			}
			const lines = params.lines ?? 50;
			const result = tailFile(params.path, lines, params.from);
			const suffix = result.truncated ? `\n[truncated — next offset: ${result.offset}]` : `\n[offset: ${result.offset}]`;
			return {
				content: [{ type: "text", text: (result.text || "(empty)") + suffix }],
				isError: false,
				details: { offset: result.offset, truncated: result.truncated },
			};
		},
	});

	pi.registerTool({
		name: "log_kill",
		label: "Log kill",
		description:
			"Kill a background process by PID or by pkill -f pattern. " +
			"Refuses to act on PID 1.",
		promptSnippet: "log_kill({pid} | {pattern}) — terminate background process",
		parameters: Type.Object({
			pid: Type.Optional(Type.Integer({ minimum: 2, description: "PID to kill." })),
			pattern: Type.Optional(Type.String({ description: "Pattern for pkill -f." })),
			signal: Type.Optional(Type.String({ description: "Signal name (TERM/KILL/HUP/INT). Default TERM." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<{ killed: number }>> {
			const sig = params.signal ?? "TERM";
			if (!params.pid && !params.pattern) {
				return {
					content: [{ type: "text", text: "log_kill requires `pid` or `pattern`." }],
					isError: true,
					details: { killed: 0 },
				};
			}
			if (params.pid !== undefined) {
				if (params.pid <= 1) {
					return {
						content: [{ type: "text", text: "refused: will not signal PID ≤ 1" }],
						isError: true,
						details: { killed: 0 },
					};
				}
				const res = await pi.exec("kill", [`-${sig}`, String(params.pid)], {});
				return {
					content: [{ type: "text", text: res.code === 0 ? `sent SIG${sig} to ${params.pid}` : `kill failed: ${res.stderr.trim() || res.code}` }],
					isError: res.code !== 0,
					details: { killed: res.code === 0 ? 1 : 0 },
				};
			}
			// pattern path
			const pattern = params.pattern as string;
			const bounded = /^\w[\w.\-\/]*$/.test(pattern) || pattern.includes("pi-bg-");
			if (!bounded) {
				return {
					content: [{ type: "text", text: `refused: pattern "${pattern}" looks too broad; include a pi-bg- marker or a clear binary name` }],
					isError: true,
					details: { killed: 0 },
				};
			}
			const res = await pi.exec("pkill", [`-${sig}`, "-f", pattern], {});
			// pkill exit codes: 0=killed, 1=no match, 2=syntax, 3=fatal
			const note = res.code === 0 ? "killed" : res.code === 1 ? "no match" : `error code ${res.code}`;
			return {
				content: [{ type: "text", text: `pkill -f ${pattern}: ${note}` }],
				isError: res.code > 1,
				details: { killed: res.code === 0 ? 1 : 0 },
			};
		},
	});

	pi.registerTool({
		name: "log_ps",
		label: "Log ps",
		description:
			"List running processes matching a pattern (pgrep -af). " +
			"Omit pattern to see all tracked /tmp/pi-bg-* tasks.",
		promptSnippet: "log_ps(pattern?) — list matching processes",
		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "pgrep -f pattern." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<{ count: number }>> {
			if (!params.pattern) {
				const entries = await scanBgEntries(pi);
				if (entries.length === 0) {
					return { content: [{ type: "text", text: "no tracked background tasks in /tmp/pi-bg-*" }], isError: false, details: { count: 0 } };
				}
				const lines = entries.map((e) => {
					const state = e.alive ? `alive pid=${e.pid} up=${fmtUptime(e.uptimeSec)}` : "[dead]";
					return `${e.slug}  ${state}  log=${fmtBytes(e.logBytes)}  ${e.cmd}`;
				});
				return { content: [{ type: "text", text: lines.join("\n") }], isError: false, details: { count: entries.filter((e) => e.alive).length } };
			}
			const res = await pi.exec("pgrep", ["-af", params.pattern], {});
			if (res.code === 1) {
				return { content: [{ type: "text", text: "(no match)" }], isError: false, details: { count: 0 } };
			}
			if (res.code > 1) {
				return { content: [{ type: "text", text: `pgrep failed: ${res.stderr.trim() || res.code}` }], isError: true, details: { count: 0 } };
			}
			const lines = res.stdout.trim().split("\n").filter(Boolean);
			return { content: [{ type: "text", text: lines.join("\n") || "(none)" }], isError: false, details: { count: lines.length } };
		},
	});

	pi.registerCommand("bg", {
		description: "Inspect background tasks (/tmp/pi-bg-*): list, tail, kill",
		handler: async (_args, ctx) => {
			const entries = await scanBgEntries(pi);
			updateStatus(ctx, entries);
			if (entries.length === 0) {
				ctx.ui.notify("no tracked background tasks in /tmp/pi-bg-*", "info");
				return;
			}
			if (!ctx.hasUI) {
				const lines = entries.map((e) => {
					const state = e.alive ? `alive pid=${e.pid} up=${fmtUptime(e.uptimeSec)}` : "[dead]";
					return `${e.slug}  ${state}  log=${fmtBytes(e.logBytes)}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			while (true) {
				const fresh = await scanBgEntries(pi);
				updateStatus(ctx, fresh);
				if (fresh.length === 0) {
					ctx.ui.notify("no tracked background tasks remaining", "info");
					return;
				}
				const options = fresh.map((e) => {
					const state = e.alive ? `alive pid=${e.pid} up=${fmtUptime(e.uptimeSec)}` : "[dead]";
					return `${e.slug}  ${state}  log=${fmtBytes(e.logBytes)}`;
				});
				options.push("❌ Done");
				const choice = await ctx.ui.select("Background tasks (pick one):", options);
				if (!choice || choice === "❌ Done") return;
				const idx = options.indexOf(choice);
				const entry = fresh[idx];

				const actions = [
					"📄 Tail log (last 200 lines)",
					entry.alive ? "🛑 Kill (TERM)" : "🗑️  Remove stale pidfile",
					"⬅️  Back",
				];
				const action = await ctx.ui.select(`${entry.slug} — action:`, actions);
				if (!action || action === "⬅️  Back") continue;

				if (action.startsWith("📄")) {
					if (!existsSync(entry.logPath)) {
						ctx.ui.notify(`log not found: ${entry.logPath}`, "warning");
						continue;
					}
					const { text } = tailFile(entry.logPath, 200, undefined);
					ctx.ui.notify(`── ${basename(entry.logPath)} ──\n${text || "(empty)"}`, "info");
					continue;
				}
				if (action.startsWith("🛑")) {
					if (entry.pid !== null) {
						const res = await pi.exec("kill", ["-TERM", String(entry.pid)], {});
						ctx.ui.notify(res.code === 0 ? `killed ${entry.pid}` : `kill failed: ${res.stderr.trim() || res.code}`, res.code === 0 ? "info" : "error");
					}
					continue;
				}
				if (action.startsWith("🗑️")) {
					try {
						unlinkSync(entry.pidPath);
						ctx.ui.notify(`removed ${entry.pidPath}`, "info");
					} catch (e) {
						ctx.ui.notify(`unlink failed: ${(e as Error).message}`, "error");
					}
					continue;
				}
			}
		},
	});
}
