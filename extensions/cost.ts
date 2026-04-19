/**
 * /cost — token usage dashboard per-session and per-day.
 *
 * Scans session JSONL files in ~/.pi/agent/sessions/,
 * aggregates usage (input, output, cache, cost) by day.
 * Shows today's total, last 7 days, and current session.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

interface UsageEntry {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

interface DayUsage extends UsageEntry {
	sessions: number;
}

const formatTokens = (n: number): string => {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
};

const formatCost = (n: number, tokens: number = 0): string => {
	// Providers without a pricing table in pi-ai (Ollama, local LLMs, some
	// OpenAI proxies) return cost=0 even though tokens flowed. Distinguish
	// "actually $0" from "unknown pricing" by checking the token count.
	if (n === 0) return tokens > 0 ? "—" : "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
};

const extractDateFromFilename = (name: string): string | null => {
	// Format: 2026-04-17T21-21-09-018Z_*.jsonl
	const match = name.match(/^(\d{4})-(\d{2})-(\d{2})T/);
	if (!match) return null;
	return `${match[1]}-${match[2]}-${match[3]}`;
};

const parseSessionUsage = (filePath: string): UsageEntry & { turns: number } => {
	const result: UsageEntry & { turns: number } = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
		totalTokens: 0, cost: 0, turns: 0,
	};
	try {
		const data = readFileSync(filePath, "utf8");
		for (const line of data.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.message?.role === "assistant" && entry.message.usage) {
					const u = entry.message.usage;
					result.input += u.input ?? 0;
					result.output += u.output ?? 0;
					result.cacheRead += u.cacheRead ?? 0;
					result.cacheWrite += u.cacheWrite ?? 0;
					result.totalTokens += u.totalTokens ?? 0;
					result.cost += u.cost?.total ?? 0;
					result.turns++;
				}
			} catch { /* skip malformed lines */ }
		}
	} catch { /* skip unreadable files */ }
	return result;
};

const collectAllSessions = (sessionsDir: string): Map<string, DayUsage> => {
	const byDay = new Map<string, DayUsage>();

	try {
		const projectDirs = readdirSync(sessionsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory());

		for (const projectDir of projectDirs) {
			const dirPath = join(sessionsDir, projectDir.name);
			let files: string[];
			try {
				files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
			} catch { continue; }

			for (const file of files) {
				const date = extractDateFromFilename(file);
				if (!date) continue;

				const usage = parseSessionUsage(join(dirPath, file));
				if (usage.turns === 0) continue;

				const existing = byDay.get(date) ?? {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
					totalTokens: 0, cost: 0, sessions: 0,
				};
				existing.input += usage.input;
				existing.output += usage.output;
				existing.cacheRead += usage.cacheRead;
				existing.cacheWrite += usage.cacheWrite;
				existing.totalTokens += usage.totalTokens;
				existing.cost += usage.cost;
				existing.sessions++;
				byDay.set(date, existing);
			}
		}
	} catch { /* sessions dir may not exist */ }

	return byDay;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("cost")) return;
	pi.registerCommand("cost", {
		description: "Token usage dashboard: per-session, per-day, last 7 days",
		handler: async (_args, ctx) => {
			const sessionsDir = join(homedir(), ".pi/agent/sessions");
			const byDay = collectAllSessions(sessionsDir);

			// Current session stats
			let currentUsage: UsageEntry & { turns: number } = {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
				totalTokens: 0, cost: 0, turns: 0,
			};
			try {
				const entries = ctx.sessionManager.getEntries();
				for (const e of entries) {
					const msg = (e as { message?: { role?: string; usage?: Record<string, number> } }).message;
					if (msg?.role === "assistant" && msg.usage) {
						const u = msg.usage;
						currentUsage.input += u.input ?? 0;
						currentUsage.output += u.output ?? 0;
						currentUsage.cacheRead += u.cacheRead ?? 0;
						currentUsage.cacheWrite += u.cacheWrite ?? 0;
						currentUsage.totalTokens += u.totalTokens ?? 0;
						currentUsage.cost += (u as { cost?: { total?: number } }).cost?.total ?? 0;
						currentUsage.turns++;
					}
				}
			} catch { /* ignore */ }

			const today = new Date().toISOString().slice(0, 10);
			const lines: string[] = ["═══ Token Usage Dashboard ═══"];

			// Current session
			lines.push("");
			lines.push("Current session:");
			lines.push(`  Turns: ${currentUsage.turns}`);
			lines.push(`  Input: ${formatTokens(currentUsage.input)}  Output: ${formatTokens(currentUsage.output)}`);
			if (currentUsage.cacheRead > 0) {
				lines.push(`  Cache: ${formatTokens(currentUsage.cacheRead)} read / ${formatTokens(currentUsage.cacheWrite)} write`);
			}
			lines.push(`  Total tokens: ${formatTokens(currentUsage.totalTokens)}`);
			lines.push(`  Cost: ${formatCost(currentUsage.cost, currentUsage.totalTokens)}`);

			// Today's total (including current session)
			const todayData = byDay.get(today);
			if (todayData) {
				lines.push("");
				lines.push(`Today (${today}):`);
				lines.push(`  Sessions: ${todayData.sessions}  Turns: ~${todayData.turns ?? "n/a"}`);
				lines.push(`  Total tokens: ${formatTokens(todayData.totalTokens)}`);
				lines.push(`  Cost: ${formatCost(todayData.cost, todayData.totalTokens)}`);
				if (todayData.cacheRead > 0) {
					const cacheRate = todayData.totalTokens > 0
						? ((todayData.cacheRead / todayData.totalTokens) * 100).toFixed(0)
						: "0";
					lines.push(`  Cache hit rate: ~${cacheRate}%`);
				}
			}

			// Last 7 days
			const days = [...byDay.keys()].sort().reverse().slice(0, 7);
			if (days.length > 0) {
				lines.push("");
				lines.push("Last 7 days:");
				lines.push("  Date         Sessions  Tokens      Cost");
				lines.push("  ───────────  ────────  ──────────  ──────");
				for (const day of days) {
					const d = byDay.get(day)!;
					lines.push(
						`  ${day}  ${String(d.sessions).padStart(8)}  ${formatTokens(d.totalTokens).padStart(10)}  ${formatCost(d.cost, d.totalTokens).padStart(6)}`,
					);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
