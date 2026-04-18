/**
 * /skills, /extensions, /prompts — list installed resources with descriptions.
 *
 * pi has built-in `/reload` and shows resources at session start, but no
 * runtime listing. Mirrors Claude Code's `/skills` UX.
 */

import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

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

const renderToCtx = (ctx: ExtensionContext, body: string) => {
	ctx.ui.notify(body, "info");
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("list-resources")) return;
	pi.registerCommand("skills", {
		description: "List installed skills with descriptions",
		handler: async (_args, ctx) => {
			const items = pi.getCommands().filter((c) => c.source === "skill");
			renderToCtx(ctx, formatList("skills", items));
		},
	});

	pi.registerCommand("extensions", {
		description: "List commands provided by installed extensions",
		handler: async (_args, ctx) => {
			const items = pi.getCommands().filter((c) => c.source === "extension");
			renderToCtx(ctx, formatList("extensions", items));
		},
	});

	pi.registerCommand("prompts", {
		description: "List prompt templates with descriptions",
		handler: async (_args, ctx) => {
			const items = pi.getCommands().filter((c) => c.source === "prompt");
			renderToCtx(ctx, formatList("prompts", items));
		},
	});
}
