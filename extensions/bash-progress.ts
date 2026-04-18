/**
 * bash-progress — live widget for long-running bash tool calls.
 *
 * pi already streams bash stdout via ToolExecutionUpdateEvent, but the
 * user only sees the buffered result after the command finishes. For
 * slow commands (build, migrations, long tests) that's poor UX.
 *
 * This extension listens to tool_execution_start/update/end for the
 * built-in bash tool and renders a compact widget with the tail of
 * stdout + elapsed time once a command has been running longer than the
 * configured threshold. The widget disappears the moment the tool
 * finishes. Zero effect on the tool's own result.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadOpusPackSection } from "../lib/settings.js";

interface ProgressConfig {
	enabled: boolean;
	minDurationMs: number;
	tailLines: number;
}

const DEFAULT_CONFIG: ProgressConfig = {
	enabled: true,
	minDurationMs: 2000,
	tailLines: 5,
};

const loadConfig = (): ProgressConfig => loadOpusPackSection("bashProgress", DEFAULT_CONFIG);

interface BashRun {
	toolCallId: string;
	startedAt: number;
	command: string;
	timer: NodeJS.Timeout | null;
	tickTimer: NodeJS.Timeout | null;
	lastText: string;
	shown: boolean;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const extractText = (partial: unknown): string => {
	if (!partial || typeof partial !== "object") return "";
	const result = partial as { content?: Array<{ type?: string; text?: string }> };
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("");
};

const truncateTail = (text: string, lines: number): string => {
	const arr = text.split("\n");
	if (arr.length <= lines) return text;
	return arr.slice(-lines).join("\n");
};

const fmtElapsed = (ms: number): string => {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	return `${Math.floor(sec / 60)}m${sec % 60}s`;
};

export default function (pi: ExtensionAPI) {
	const runs = new Map<string, BashRun>();

	pi.on("tool_execution_start", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const cfg = loadConfig();
		if (!cfg.enabled) return;
		const command = String((event.args as { command?: string })?.command ?? "");
		const run: BashRun = {
			toolCallId: event.toolCallId,
			startedAt: Date.now(),
			command,
			timer: null,
			tickTimer: null,
			lastText: "",
			shown: false,
		};
		runs.set(event.toolCallId, run);

		// Deferred render: only show widget if the command is still running
		// after the threshold. This prevents widget churn on fast commands.
		run.timer = setTimeout(() => {
			run.timer = null;
			run.shown = true;
			renderWidget(ctx, run, cfg);
		}, cfg.minDurationMs);

		// Tick the elapsed counter while visible. Store the timer handle so
		// tool_execution_end can clear it — otherwise a phantom tick fires
		// after the widget has already been torn down.
		const tick = () => {
			if (!runs.has(run.toolCallId) || !run.shown) {
				run.tickTimer = null;
				return;
			}
			renderWidget(ctx, run, cfg);
			run.tickTimer = setTimeout(tick, 1000);
		};
		run.tickTimer = setTimeout(tick, cfg.minDurationMs + 1000);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		const run = runs.get(event.toolCallId);
		if (!run) return;
		run.lastText = extractText(event.partialResult);
		if (run.shown) {
			renderWidget(ctx, run, loadConfig());
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const run = runs.get(event.toolCallId);
		if (!run) return;
		if (run.timer) {
			clearTimeout(run.timer);
			run.timer = null;
		}
		if (run.tickTimer) {
			clearTimeout(run.tickTimer);
			run.tickTimer = null;
		}
		if (run.shown) {
			ctx.ui.setWidget("bash-progress", undefined);
			ctx.ui.setStatus("05-bash", undefined);
		}
		runs.delete(event.toolCallId);
	});

	const renderWidget = (ctx: ExtensionContext, run: BashRun, cfg: ProgressConfig) => {
		const elapsed = Date.now() - run.startedAt;
		const spinner = SPINNER[Math.floor(elapsed / 100) % SPINNER.length];
		const head = `${spinner} bash · ${fmtElapsed(elapsed)} · ${run.command.slice(0, 80)}`;
		const tail = truncateTail(run.lastText, cfg.tailLines).trimEnd();
		const widgetLines = tail ? [head, ...tail.split("\n").slice(-cfg.tailLines)] : [head];
		ctx.ui.setWidget("bash-progress", widgetLines.map((l) => ctx.ui.theme.fg("dim", l)));
		ctx.ui.setStatus("05-bash", ctx.ui.theme.fg("warning", `⏳ ${fmtElapsed(elapsed)}`));
	};
}
