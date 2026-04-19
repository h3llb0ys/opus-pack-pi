/**
 * /opus-pack — toggle on/off for any opus-pack extension.
 *
 * Overlays/trees via ctx.ui.custom were considered, but we already have
 * a consistent, robust UX built on ctx.ui.select loops elsewhere in the
 * pack (log-tail /bg, diff picker). Reuse that pattern:
 *
 *   1. Build the option list from OPUS_EXTENSIONS + current disabled set.
 *   2. Show a pinned header row with save/reload/cancel actions.
 *   3. On a toggle pick, update in-memory state and rebuild.
 *   4. On save, atomically write settings.local.json via lib/settings.
 *   5. On reload, also call ctx.reload() so the change takes effect
 *      without the user running /reload manually.
 *
 * Extensions are grouped by category to stay navigable as the pack
 * grows. Disabling a safety-critical extension requires confirmation.
 *
 * Each opus-pack extension checks isExtensionDisabled() on load and
 * early-returns when its name is in the disabled list — done in a
 * separate commit.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { listDisabledExtensions, setExtensionDisabled } from "../lib/settings.js";

export type Category = "safety" | "tasks" | "ui" | "integrations" | "dev";

export interface ExtensionEntry {
	name: string;
	category: Category;
	description: string;
	critical?: boolean;
}

// Single source of truth for what `/opus-pack` shows. Keep in sync when
// adding or renaming extensions in this pack.
export const OPUS_EXTENSIONS: ExtensionEntry[] = [
	// safety
	{ name: "permissions", category: "safety", description: "Granular allow/deny rules + interactive 4-way prompt" },
	{ name: "safe-deny", category: "safety", description: "Structured bash denylist (argv parser)", critical: true },
	{ name: "dirty-repo-guard", category: "safety", description: "Warn when session starts on a dirty worktree" },
	{ name: "iteration-guard", category: "safety", description: "Cap agent turns per run (/continue to extend)" },

	// tasks
	{ name: "plan-mode", category: "tasks", description: "Read-only exploration + numbered plan + execute tracking" },
	{ name: "todo", category: "tasks", description: "Multi-step task list with in_progress state" },
	{ name: "model-router", category: "tasks", description: "Auto-switch model + thinking level per prompt" },

	// ui
	{ name: "status", category: "ui", description: "/status slash + live statusline (cwd / branch)" },
	{ name: "bash-progress", category: "ui", description: "Live widget for long bash commands" },
	{ name: "mcp-compress", category: "ui", description: "Collapse verbose MCP tool results to one line" },
	{ name: "desktop-notify", category: "ui", description: "OS notification on long agent completion" },
	{ name: "session-summary", category: "ui", description: "Post-turn summary of files changed, commands, errors" },
	{ name: "context", category: "ui", description: "/context dashboard — what eats the context window" },
	{ name: "cost", category: "ui", description: "/cost dashboard — tokens + price breakdown" },
	{ name: "list-resources", category: "ui", description: "/skills, /extensions, /prompts slashes" },

	// integrations
	{ name: "skills", category: "integrations", description: "CC-compat discovery of ~/.claude/skills" },
	{ name: "hook-bridge", category: "integrations", description: "CC-format hooks block from settings.json" },
	{ name: "pi-search", category: "integrations", description: "/pi-search community extension discovery" },
	{ name: "claude-md-loader", category: "integrations", description: "Auto-load CLAUDE.md / AGENTS.md into system prompt" },
	{ name: "ask-user", category: "integrations", description: "LLM tool to ask clarifying questions" },
	{ name: "smart-compact", category: "integrations", description: "Merge compact-hints.md into /compact focus" },
	{ name: "log-tail", category: "integrations", description: "log_tail/log_kill/log_ps + /bg picker" },
	{ name: "edit-log", category: "integrations", description: "/edit-log — on-demand list of files edited this session" },
	{ name: "file-commands", category: "integrations", description: "Load slash commands from ~/.{pi,claude}/commands + <cwd>/.{pi,claude}/commands (*.md+frontmatter)" },
	{ name: "deferred-tools", category: "integrations", description: "Lazy MCP tool schemas (tool_search + tool_load). Feature-flagged: opus-pack.deferredTools.enabled" },

	// dev (git helpers)
	{ name: "auto-commit-on-exit", category: "dev", description: "Snapshot commit on pi exit" },
	{ name: "git-checkpoint", category: "dev", description: "Auto-snapshot before write/edit/bash" },
	{ name: "diff", category: "dev", description: "/diff — review agent changes interactively" },
	{ name: "rewind", category: "dev", description: "/rewind — undo commits, stash, reset" },
];

const CATEGORY_ORDER: Category[] = ["safety", "tasks", "ui", "integrations", "dev"];

const CATEGORY_LABEL: Record<Category, string> = {
	safety: "Safety",
	tasks: "Tasks & routing",
	ui: "UI & reporting",
	integrations: "Integrations",
	dev: "Dev loop",
};

interface ModalState {
	/** Short names currently marked disabled. */
	disabled: Set<string>;
	/** Whether anything has changed vs the on-disk state. */
	dirty: boolean;
}

const buildInitialState = (): ModalState => ({
	disabled: new Set(listDisabledExtensions()),
	dirty: false,
});

const buildOptions = (state: ModalState): { lines: string[]; entries: (ExtensionEntry | null)[] } => {
	const lines: string[] = [];
	const entries: (ExtensionEntry | null)[] = [];
	const totalEnabled = OPUS_EXTENSIONS.length - state.disabled.size;
	lines.push(`— Save ${state.dirty ? "(pending changes)" : ""}`);
	entries.push(null); // sentinel for save
	lines.push(`— Save & Reload${state.dirty ? " ↻" : ""}`);
	entries.push(null); // sentinel for save+reload
	lines.push(`— Cancel (discard pending changes)`);
	entries.push(null); // sentinel for cancel
	lines.push(`═══════════════  ${totalEnabled}/${OPUS_EXTENSIONS.length} enabled  ═══════════════`);
	entries.push(null); // visual separator

	for (const cat of CATEGORY_ORDER) {
		const bucket = OPUS_EXTENSIONS.filter((e) => e.category === cat);
		if (bucket.length === 0) continue;
		lines.push(`── ${CATEGORY_LABEL[cat]} ──`);
		entries.push(null); // category header, unselectable-by-intent (still picks but no-ops)
		for (const ext of bucket) {
			const isDisabled = state.disabled.has(ext.name);
			const mark = isDisabled ? "[ ]" : "[x]";
			const critical = ext.critical ? " ⚠" : "";
			lines.push(`  ${mark} ${ext.name.padEnd(22)} ${ext.description}${critical}`);
			entries.push(ext);
		}
	}
	return { lines, entries };
};

const promptConfirmCritical = async (ctx: ExtensionContext, name: string): Promise<boolean> => {
	return await ctx.ui.confirm(
		`Disable ${name}?`,
		`${name} is security-critical. Disabling it weakens the pack's safety net. Continue?`,
		{ timeout: 30_000 },
	);
};

const promptReloadAfterSave = async (ctx: ExtensionContext): Promise<boolean> => {
	return await ctx.ui.confirm(
		"Reload extensions now?",
		"Changes take effect after /reload. Reload now?",
		{ timeout: 30_000 },
	);
};

const applyChanges = (state: ModalState): { okCount: number; errors: string[] } => {
	const onDisk = new Set(listDisabledExtensions());
	const errors: string[] = [];
	let ok = 0;
	// Disable everything in state.disabled that's not on disk, enable everything on disk that's not in state.disabled.
	for (const name of state.disabled) {
		if (!onDisk.has(name)) {
			const r = setExtensionDisabled(name, true);
			if (r.saved) ok++;
			else errors.push(`${name}: ${r.error ?? "unknown error"}`);
		}
	}
	for (const name of onDisk) {
		if (!state.disabled.has(name)) {
			const r = setExtensionDisabled(name, false);
			if (r.saved) ok++;
			else errors.push(`${name}: ${r.error ?? "unknown error"}`);
		}
	}
	return { okCount: ok, errors };
};

/**
 * Shared modal loop. `reloadFn` is non-null when the caller can trigger
 * a live reload (command context); null for shortcut context which only
 * saves and tells the user to /reload manually.
 */
const runModal = async (
	ctx: ExtensionContext & { hasUI: boolean },
	reloadFn: (() => Promise<void>) | null,
): Promise<void> => {
	if (!ctx.hasUI) {
		const disabled = listDisabledExtensions();
		ctx.ui.notify(
			`opus-pack extensions: ${OPUS_EXTENSIONS.length - disabled.length}/${OPUS_EXTENSIONS.length} enabled.` +
			(disabled.length > 0 ? `\nDisabled: ${disabled.join(", ")}` : ""),
			"info",
		);
		return;
	}

	const state = buildInitialState();

	while (true) {
		const { lines, entries } = buildOptions(state);
		const picked = await ctx.ui.select("opus-pack extensions:", lines);
		if (!picked) {
			if (state.dirty) ctx.ui.notify("opus-pack: changes discarded", "info");
			return;
		}
		const idx = lines.indexOf(picked);
		const entry = entries[idx] ?? null;

		if (idx === 0) {
			// Save.
			if (!state.dirty) {
				ctx.ui.notify("opus-pack: nothing to save", "info");
				return;
			}
			const r = applyChanges(state);
			if (r.errors.length > 0) {
				ctx.ui.notify(`opus-pack: saved ${r.okCount} change(s); errors:\n  ${r.errors.join("\n  ")}`, "warning");
			} else {
				ctx.ui.notify("opus-pack: saved. Run /reload to apply.", "info");
			}
			return;
		}
		if (idx === 1) {
			// Save & Reload.
			if (state.dirty) {
				const r = applyChanges(state);
				if (r.errors.length > 0) {
					ctx.ui.notify(`opus-pack: save partial (${r.errors.length} error(s))`, "warning");
				}
			}
			if (reloadFn) {
				try {
					await reloadFn();
					ctx.ui.notify("opus-pack: reloaded", "info");
				} catch (e) {
					ctx.ui.notify(`opus-pack: reload failed — ${(e as Error).message}`, "warning");
				}
			} else {
				ctx.ui.notify("opus-pack: saved. Run /reload to apply (shortcut cannot auto-reload).", "info");
			}
			return;
		}
		if (idx === 2) {
			if (state.dirty) ctx.ui.notify("opus-pack: changes discarded", "info");
			return;
		}
		if (!entry) continue;

		// Toggle entry.
		const wasDisabled = state.disabled.has(entry.name);
		const willDisable = !wasDisabled;
		if (willDisable && entry.critical) {
			const ok = await promptConfirmCritical(ctx, entry.name);
			if (!ok) continue;
		}
		if (willDisable) state.disabled.add(entry.name);
		else state.disabled.delete(entry.name);
		const onDisk = new Set(listDisabledExtensions());
		state.dirty = onDisk.size !== state.disabled.size
			|| [...onDisk].some((n) => !state.disabled.has(n))
			|| [...state.disabled].some((n) => !onDisk.has(n));
	}
};

const updateBadge = (ctx: ExtensionContext) => {
	const disabled = listDisabledExtensions();
	if (disabled.length === 0) {
		ctx.ui.setStatus("91-disabled", undefined);
	} else {
		ctx.ui.setStatus("91-disabled", ctx.ui.theme.fg("warning", `off:${disabled.length}`));
	}
};

// ── CLI subcommands ────────────────────────────────────────────────────────

const VALID_CATEGORIES: Category[] = ["safety", "tasks", "ui", "integrations", "dev"];

const findExtension = (needle: string): { hit?: ExtensionEntry; suggestions: string[] } => {
	const lower = needle.toLowerCase();
	const hit = OPUS_EXTENSIONS.find((e) => e.name.toLowerCase() === lower);
	if (hit) return { hit, suggestions: [] };
	// Rank substring hits by how close their length is to the query so
	// `off p` doesn't dump every extension containing "p" in input-file
	// order — closest-length matches come first.
	const suggestions = OPUS_EXTENSIONS
		.map((e) => e.name)
		.filter((n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase()))
		.sort((a, b) => Math.abs(a.length - needle.length) - Math.abs(b.length - needle.length))
		.slice(0, 3);
	return { suggestions };
};

const formatStatusLine = (): string => {
	const disabled = listDisabledExtensions();
	const enabled = OPUS_EXTENSIONS.length - disabled.length;
	const tail = disabled.length > 0 ? `; disabled: ${disabled.join(", ")}` : "";
	return `opus-pack: ${enabled}/${OPUS_EXTENSIONS.length} enabled${tail}`;
};

const formatList = (categoryFilter?: Category): string => {
	const disabled = new Set(listDisabledExtensions());
	const lines: string[] = [`═ opus-pack extensions (${OPUS_EXTENSIONS.length - disabled.size}/${OPUS_EXTENSIONS.length} enabled) ═`];
	for (const cat of CATEGORY_ORDER) {
		if (categoryFilter && cat !== categoryFilter) continue;
		const bucket = OPUS_EXTENSIONS.filter((e) => e.category === cat);
		if (bucket.length === 0) continue;
		lines.push("", `── ${CATEGORY_LABEL[cat]} ──`);
		const nameWidth = Math.min(24, bucket.reduce((m, e) => Math.max(m, e.name.length), 0));
		for (const e of bucket) {
			const off = disabled.has(e.name);
			const mark = off ? "[ ]" : "[x]";
			const crit = e.critical ? " (critical)" : "";
			lines.push(`  ${mark} ${e.name.padEnd(nameWidth)}  ${e.description.slice(0, 70)}${crit}`);
		}
	}
	return lines.join("\n");
};

const HELP_TEXT = [
	"opus-pack — toggle pack extensions",
	"",
	"  /opus-pack                  open interactive picker",
	"  /opus-pack status           one-line enabled/disabled summary",
	"  /opus-pack list [category]  full table; optional filter (safety|tasks|ui|integrations|dev)",
	"  /opus-pack on <name>        enable an extension, save + reload",
	"  /opus-pack off <name>       disable an extension, save + reload",
	"  /opus-pack off <name> --force  skip interactive confirm for critical extensions",
	"  /opus-pack reset            re-enable everything (clear disabled list)",
	"  /opus-pack help             show this text",
].join("\n");

const runCli = async (
	ctx: ExtensionContext & { hasUI: boolean },
	tokens: string[],
): Promise<void> => {
	const verb = (tokens[0] ?? "").toLowerCase();

	if (verb === "help" || verb === "-h" || verb === "--help") {
		ctx.ui.notify(HELP_TEXT, "info");
		return;
	}

	if (verb === "status") {
		ctx.ui.notify(formatStatusLine(), "info");
		return;
	}

	if (verb === "list") {
		const raw = tokens[1]?.toLowerCase();
		if (raw && !VALID_CATEGORIES.includes(raw as Category)) {
			ctx.ui.notify(
				`unknown category "${raw}". Valid: ${VALID_CATEGORIES.join(", ")}.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(formatList(raw as Category | undefined), "info");
		return;
	}

	if (verb === "reset") {
		const disabled = listDisabledExtensions();
		if (disabled.length === 0) {
			ctx.ui.notify("opus-pack: nothing to reset, all extensions already enabled", "info");
			return;
		}
		if (ctx.hasUI && disabled.length > 3) {
			const ok = await ctx.ui.confirm(
				`Re-enable ${disabled.length} extensions?`,
				`Currently disabled: ${disabled.join(", ")}`,
				{ timeout: 30_000 },
			);
			if (!ok) { ctx.ui.notify("opus-pack: reset cancelled", "info"); return; }
		}
		const errors: string[] = [];
		for (const name of disabled) {
			const r = setExtensionDisabled(name, false);
			if (!r.saved) errors.push(`${name}: ${r.error ?? "unknown"}`);
		}
		try { await ctx.reload(); } catch (e) { errors.push(`reload: ${(e as Error).message}`); }
		if (errors.length > 0) {
			ctx.ui.notify(`opus-pack: reset partial (${errors.length} error(s))\n  ${errors.join("\n  ")}`, "warning");
		} else {
			ctx.ui.notify(`opus-pack: reset — re-enabled ${disabled.length} extension(s)`, "info");
		}
		return;
	}

	if (verb === "on" || verb === "off") {
		// Treat any leading-dashed token as a flag so `off --force plan-mode`
		// and `off plan-mode --force` both work.
		const flags = tokens.slice(1).filter((t) => t.startsWith("--"));
		const positional = tokens.slice(1).filter((t) => !t.startsWith("--"));
		const name = positional[0];
		const force = flags.includes("--force");
		if (!name) {
			ctx.ui.notify(`${verb} requires an extension name. Run /opus-pack list for choices.`, "warning");
			return;
		}
		const { hit, suggestions } = findExtension(name);
		if (!hit) {
			const suffix = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
			ctx.ui.notify(`no such extension: "${name}".${suffix}`, "warning");
			return;
		}
		const currentlyDisabled = listDisabledExtensions().includes(hit.name);
		if (verb === "on" && !currentlyDisabled) {
			ctx.ui.notify(`${hit.name} is already enabled`, "info");
			return;
		}
		if (verb === "off" && currentlyDisabled) {
			ctx.ui.notify(`${hit.name} is already disabled`, "info");
			return;
		}
		if (verb === "off" && hit.critical) {
			if (!force) {
				if (ctx.hasUI) {
					const ok = await promptConfirmCritical(ctx, hit.name);
					if (!ok) { ctx.ui.notify("opus-pack: cancelled", "info"); return; }
				} else {
					ctx.ui.notify(
						`${hit.name} is security-critical; add --force to disable non-interactively.`,
						"warning",
					);
					return;
				}
			}
		}
		const r = setExtensionDisabled(hit.name, verb === "off");
		if (!r.saved) {
			ctx.ui.notify(`opus-pack: save failed for ${hit.name} — ${r.error ?? "unknown"}`, "error");
			return;
		}
		try { await ctx.reload(); } catch (e) {
			ctx.ui.notify(`opus-pack: ${hit.name} ${verb === "off" ? "disabled" : "enabled"}, reload failed — ${(e as Error).message}. Run /reload manually.`, "warning");
			return;
		}
		ctx.ui.notify(`opus-pack: ${hit.name} ${verb === "off" ? "disabled" : "enabled"} + reloaded`, "info");
		return;
	}

	// Unknown verb — warn + help.
	ctx.ui.notify(`unknown subcommand: "${verb}"\n\n${HELP_TEXT}`, "warning");
};

export default function (pi: ExtensionAPI) {
	void pi; // reserved for future use

	pi.registerCommand("opus-pack", {
		description:
			"Toggle pack extensions. No args → modal. " +
			"Subcommands: status | list [cat] | on <name> | off <name> [--force] | reset | help",
		handler: async (args, ctx) => {
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				await runModal(ctx, () => ctx.reload());
			} else {
				await runCli(ctx, tokens);
			}
			updateBadge(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("o"), {
		description: "Open /opus-pack config modal",
		handler: async (ctx) => {
			await runModal(ctx, null);
			updateBadge(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateBadge(ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		updateBadge(ctx);
	});
}
