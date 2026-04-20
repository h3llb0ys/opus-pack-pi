/**
 * /extensions, /prompts — list installed resources with descriptions.
 *
 * /extensions doubles as an opus-pack health dashboard: every OPUS_EXTENSIONS
 * entry is listed with its enabled/disabled state so the user can tell at a
 * glance whether something they expected to be active has been toggled off
 * via settings.local.json (or turned off via /opus-pack). Below that we keep
 * the original behaviour — a flat list of slash commands sourced from all
 * extensions (ours + community), so the command also surfaces non-opus-pack
 * packages that registered extensions.
 *
 * /skills is delegated to pi-skills-menu (full CRUD + preview/insert/edit),
 * so we no longer register a read-only version here.
 */

import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, listDisabledExtensions } from "../lib/settings.js";
import { OPUS_EXTENSIONS, type Category, type ExtensionEntry } from "./opus-pack-config.js";

const formatList = (title: string, items: SlashCommandInfo[]): string => {
	if (items.length === 0) return `${title}: (none)`;
	const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
	const nameWidth = Math.min(36, sorted.reduce((m, c) => Math.max(m, c.name.length), 0));
	const lines = sorted.map((c) => {
		const desc = c.description ? c.description.replace(/\s+/g, " ").slice(0, 100) : "";
		return `  ${c.name.padEnd(nameWidth)}  ${desc}`;
	});
	return [`═ ${title} (${sorted.length}) ═`, ...lines].join("\n");
};

const CATEGORY_ORDER: Category[] = ["safety", "tasks", "ui", "integrations", "dev"];
const CATEGORY_LABEL: Record<Category, string> = {
	safety: "Safety",
	tasks: "Tasks & routing",
	ui: "UI & reporting",
	integrations: "Integrations",
	dev: "Dev loop",
};

const buildHealthReport = (pi: ExtensionAPI): string => {
	const disabled = new Set(listDisabledExtensions());
	const enabledCount = OPUS_EXTENSIONS.filter((e) => !disabled.has(e.name)).length;
	const lines: string[] = [
		`═ opus-pack extensions (${enabledCount}/${OPUS_EXTENSIONS.length} enabled) ═`,
	];
	for (const cat of CATEGORY_ORDER) {
		const bucket = OPUS_EXTENSIONS.filter((e) => e.category === cat);
		if (bucket.length === 0) continue;
		lines.push("");
		lines.push(`[${CATEGORY_LABEL[cat]}]`);
		const nameWidth = Math.min(24, bucket.reduce((m: number, e: ExtensionEntry) => Math.max(m, e.name.length), 0));
		for (const e of bucket) {
			const off = disabled.has(e.name);
			const marker = off ? "✗" : "✓";
			const suffix = off ? "  (disabled in settings.local.json)" : "";
			lines.push(`  ${marker} ${e.name.padEnd(nameWidth)}  ${e.description.slice(0, 80)}${suffix}`);
		}
	}

	// Global counters from pi's own introspection APIs. These cover everything
	// the user sees in their session, including extensions from other packages
	// (community pi-extensions, tmustier/pi-extensions, etc.).
	const allCmds = pi.getCommands();
	const byTool = pi.getAllTools();
	const mcp = byTool.filter((t) => /^mcp(_|__)/i.test(t.name)).length;
	const activeTools = new Set(pi.getActiveTools()).size;
	lines.push("");
	lines.push("─ aggregate ─");
	lines.push(`  slash commands:   ${allCmds.length} (ext=${allCmds.filter((c) => c.source === "extension").length}, skill=${allCmds.filter((c) => c.source === "skill").length}, prompt=${allCmds.filter((c) => c.source === "prompt").length})`);
	lines.push(`  tools active:     ${activeTools} / ${byTool.length} (mcp=${mcp})`);
	lines.push(`  opus-pack:        use /opus-pack to toggle; state in settings.local.json`);
	return lines.join("\n");
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("list-resources")) return;
	pi.registerCommand("extensions", {
		description: "List opus-pack extensions with health status + all extension-registered commands",
		handler: async (_args, ctx: ExtensionContext) => {
			const health = buildHealthReport(pi);
			const commands = pi.getCommands().filter((c) => c.source === "extension");
			ctx.ui.notify([health, "", formatList("all extension commands", commands)].join("\n"), "info");
		},
	});

	pi.registerCommand("prompts", {
		description: "List prompt templates with descriptions",
		handler: async (_args, ctx) => {
			const items = pi.getCommands().filter((c) => c.source === "prompt");
			ctx.ui.notify(formatList("prompts", items), "info");
		},
	});
}
