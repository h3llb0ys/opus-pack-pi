/**
 * cc-bridge — one extension, four sub-modules, one /cc-bridge slash.
 *
 * Consolidates the cross-vendor compat layer that used to live in four
 * separate extensions (skills, hook-bridge, claude-md-loader, file-commands).
 * Each sub-module registers its own pi event handlers independently; they
 * are not coupled beyond a shared observation state used by /cc-bridge
 * status to print a consolidated view.
 *
 * Granular toggles are preserved: each sub-module reads its own
 * `cc-bridge.<sub>` key from settings.local.json (plus a legacy key for
 * back-compat) and silently no-ops if disabled.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import registerSkills from "./skills.js";
import registerCommands from "./commands.js";
import registerClaudeMd from "./claude-md.js";
import registerHooks from "./hooks.js";
import { type CcBridgeState, emptyState } from "./state.js";

const formatStatus = (state: CcBridgeState): string => {
	const lines: string[] = [`═ cc-bridge status ═`, ""];

	// Skills
	lines.push(
		state.skills.enabled
			? `skills   (${state.skills.roots.length} root${state.skills.roots.length === 1 ? "" : "s"})`
			: `skills   (disabled)`,
	);
	for (const p of state.skills.roots) lines.push(`  ${p}`);
	lines.push("");

	// Commands
	if (state.commands.enabled) {
		lines.push(`commands (${state.commands.entries.length} loaded, ${state.commands.collisions.length} collisions)`);
		for (const c of state.commands.entries.slice(0, 20)) {
			lines.push(`  /${c.name.padEnd(24)} ${c.description.slice(0, 60)}`);
			lines.push(`    ${c.sourceFile}`);
		}
		if (state.commands.entries.length > 20) {
			lines.push(`  ... +${state.commands.entries.length - 20} more`);
		}
		for (const col of state.commands.collisions) lines.push(`  ! ${col}`);
	} else {
		lines.push(`commands (disabled)`);
	}
	lines.push("");

	// CLAUDE.md
	if (state.claudeMd.enabled) {
		lines.push(
			`claude-md (${state.claudeMd.files.length} file${state.claudeMd.files.length === 1 ? "" : "s"}, ` +
				`${state.claudeMd.totalChars} / ${state.claudeMd.maxTotalChars} chars used)`,
		);
		for (const f of state.claudeMd.files) lines.push(`  ${f.path}  (${f.bytes}B)`);
	} else {
		lines.push(`claude-md (disabled)`);
	}
	lines.push("");

	// Hooks
	if (state.hooks.enabled) {
		const total = state.hooks.legacy.length + state.hooks.fileBased.length;
		lines.push(`hooks    (${state.hooks.legacy.length} legacy + ${state.hooks.fileBased.length} file-based, ${total} total)`);
		for (const h of state.hooks.legacy) {
			const matcher = h.matcher ? ` [${h.matcher}]` : "";
			lines.push(`  [settings.json] ${h.event}${matcher} → ${h.command.slice(0, 60)}  ${h.timeout}s`);
		}
		for (const h of state.hooks.fileBased) {
			const matcher = h.matcher ? ` [${h.matcher}]` : "";
			lines.push(`  [${h.scope}] ${h.event}${matcher} → ${h.file}  ${h.timeout}s`);
		}
	} else {
		lines.push(`hooks    (disabled)`);
	}

	return lines.join("\n");
};

const handleSlash = async (args: string, ctx: ExtensionContext, state: CcBridgeState, reloadCommands: () => { added: number; total: number; collisions: string[]; bangs: string[] }): Promise<void> => {
	const sub = (args ?? "").trim().split(/\s+/)[0] ?? "";
	if (sub === "" || sub === "status") {
		ctx.ui.notify(formatStatus(state), "info");
		return;
	}
	if (sub === "reload") {
		const res = reloadCommands();
		const cwdDisplay = ctx.cwd;
		ctx.ui.notify(
			[
				`═ cc-bridge reload (cwd=${cwdDisplay}) ═`,
				`commands: ${res.total} loaded (${res.added} new this call, ${res.collisions.length} collisions)`,
				`(skills, claude-md, hooks re-scan on next session event)`,
			].join("\n"),
			"info",
		);
		return;
	}
	if (sub === "help") {
		ctx.ui.notify(
			[
				"/cc-bridge              — show status (same as /cc-bridge status)",
				"/cc-bridge status       — dump skills / commands / claude-md / hooks state",
				"/cc-bridge reload       — rescan command files (adds new, drops removed)",
				"/cc-bridge help         — this message",
			].join("\n"),
			"info",
		);
		return;
	}
	ctx.ui.notify(`Unknown subcommand: ${sub}. Try /cc-bridge help.`, "warning");
};

export default function (pi: ExtensionAPI): void {
	const state = emptyState();
	registerSkills(pi, state);
	const commandsApi = registerCommands(pi, state);
	registerClaudeMd(pi, state);
	registerHooks(pi, state);

	pi.registerCommand("cc-bridge", {
		description: "Cross-vendor bridge: /cc-bridge [status|reload|help]",
		handler: async (args, ctx) => {
			await handleSlash(args ?? "", ctx, state, () => commandsApi.reload(ctx));
		},
	});
}
