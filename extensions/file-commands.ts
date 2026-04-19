/**
 * file-commands — slash commands from `*.md` files with YAML frontmatter.
 *
 * Scans four roots (priority ascending — later wins on name collision):
 *   1. ~/.claude/commands/**\/*.md   — global Claude Code commands (direct import)
 *   2. ~/.pi/commands/**\/*.md       — global pi commands
 *   3. <cwd>/.claude/commands/**\/*.md — project-local Claude Code commands
 *   4. <cwd>/.pi/commands/**\/*.md   — project-local pi commands
 *
 * Each file becomes a slash. Subdirectories convert to namespace:
 *   ~/.claude/commands/git/sync.md  →  /git:sync
 *
 * Body is submitted to the agent via `pi.sendUserMessage` with `$ARGS`
 * substitution. We deliberately do NOT execute `!command` prefixes the way
 * Claude Code does — that would sidestep `permissions.ts`.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

interface CommandFrontmatter {
	description?: string;
	"argument-hint"?: string;
	"allowed-tools"?: string[] | string;
}

interface LoadedCommand {
	name: string;
	body: string;
	description: string;
	argumentHint?: string;
	allowedTools?: string;
	sourceFile: string;
	sourceRoot: string;
	hasBangPrefix: boolean;
}

const MAX_FILE_BYTES = 64 * 1024;

const walkMd = (root: string, out: string[]) => {
	if (!existsSync(root)) return;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = join(root, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walkMd(full, out);
		} else if (st.isFile() && name.endsWith(".md") && st.size <= MAX_FILE_BYTES) {
			out.push(full);
		}
	}
};

// cmd name from relative path: "git/sync.md" → "git:sync"
const nameFromRel = (rel: string): string =>
	rel.replace(/\.md$/, "").split(/[\\/]/).filter(Boolean).join(":");

const toArray = (v: unknown): string[] | undefined => {
	if (Array.isArray(v)) return v.map((x) => String(x));
	if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
	return undefined;
};

const loadCommandsFromRoot = (root: string): LoadedCommand[] => {
	const files: string[] = [];
	walkMd(root, files);
	const out: LoadedCommand[] = [];
	for (const full of files) {
		let raw: string;
		try {
			raw = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<CommandFrontmatter>(raw);
		const rel = relative(root, full);
		const name = nameFromRel(rel);
		if (!name) continue;
		const trimmed = body.trim();
		out.push({
			name,
			body: trimmed,
			description: String(frontmatter?.description ?? `(file-command from ${rel})`),
			argumentHint: frontmatter?.["argument-hint"]
				? String(frontmatter["argument-hint"])
				: undefined,
			allowedTools: toArray(frontmatter?.["allowed-tools"])?.join(","),
			sourceFile: full,
			sourceRoot: root,
			hasBangPrefix: /^![ \t]*\w/m.test(trimmed),
		});
	}
	return out;
};

const collectRoots = (cwd: string): string[] => [
	join(homedir(), ".claude", "commands"),
	join(homedir(), ".pi", "commands"),
	join(cwd, ".claude", "commands"),
	join(cwd, ".pi", "commands"),
];

const collectAll = (cwd: string): { commands: Map<string, LoadedCommand>; collisions: string[]; bangWarns: string[] } => {
	const commands = new Map<string, LoadedCommand>();
	const collisions: string[] = [];
	const bangWarns: string[] = [];
	for (const root of collectRoots(cwd)) {
		const fromRoot = loadCommandsFromRoot(root);
		for (const cmd of fromRoot) {
			if (commands.has(cmd.name)) {
				const prev = commands.get(cmd.name)!;
				collisions.push(`/${cmd.name}: ${prev.sourceFile} overridden by ${cmd.sourceFile}`);
			}
			commands.set(cmd.name, cmd);
			if (cmd.hasBangPrefix) bangWarns.push(`/${cmd.name} contains \`!command\` lines — they are NOT executed (permissions-safe); model sees them as text.`);
		}
	}
	return { commands, collisions, bangWarns };
};

const substituteArgs = (body: string, args: string): string => {
	// Support $ARGS (whole string) and $1..$9 (positional).
	const parts = args.trim().length ? args.trim().split(/\s+/) : [];
	let out = body.replace(/\$ARGS\b/g, args.trim());
	out = out.replace(/\$([1-9])/g, (_m, d: string) => parts[Number.parseInt(d, 10) - 1] ?? "");
	return out;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("file-commands")) return;

	// Register once; reload rewrites the Map content in place so handlers pick up
	// edits without re-registering (pi has no unregister API).
	const commands = new Map<string, LoadedCommand>();
	let warnedOnce = false;

	const reload = (ctx?: ExtensionContext): { added: number; total: number; collisions: string[]; bangs: string[] } => {
		const cwd = ctx?.cwd ?? process.cwd();
		const { commands: fresh, collisions, bangWarns } = collectAll(cwd);
		// Keep existing registrations; replace content. Track newcomers for
		// registering exactly once.
		const newcomers: LoadedCommand[] = [];
		for (const [name, cmd] of fresh) {
			if (!commands.has(name)) newcomers.push(cmd);
			commands.set(name, cmd);
		}
		// Drop entries no longer present.
		for (const name of [...commands.keys()]) {
			if (!fresh.has(name)) commands.delete(name);
		}
		for (const cmd of newcomers) {
			pi.registerCommand(cmd.name, {
				description: cmd.description + (cmd.argumentHint ? ` — ${cmd.argumentHint}` : ""),
				handler: async (args, handlerCtx) => {
					const current = commands.get(cmd.name);
					if (!current) {
						handlerCtx.ui.notify(`/${cmd.name} no longer available (file removed). Try /file-commands-reload.`, "warning");
						return;
					}
					const prompt = substituteArgs(current.body, args ?? "");
					if (!prompt.trim()) {
						handlerCtx.ui.notify(`/${cmd.name}: empty body, nothing to submit`, "warning");
						return;
					}
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				},
			});
		}
		return { added: newcomers.length, total: commands.size, collisions, bangs: bangWarns };
	};

	pi.on("session_start", async (_event, ctx) => {
		const res = reload(ctx);
		if (!warnedOnce) {
			warnedOnce = true;
			for (const msg of res.collisions) ctx.ui.notify(`file-commands: ${msg}`, "warning");
			for (const msg of res.bangs) ctx.ui.notify(`file-commands: ${msg}`, "warning");
		}
	});

	pi.registerCommand("file-commands-reload", {
		description: "Rescan ~/.{pi,claude}/commands + <cwd>/.{pi,claude}/commands",
		handler: async (_args, ctx) => {
			const res = reload(ctx);
			const lines = [
				`═ file-commands reloaded ═`,
				`total:       ${res.total}`,
				`new this call: ${res.added}`,
			];
			if (res.collisions.length) lines.push("", "collisions:", ...res.collisions.map((c) => `  ${c}`));
			if (res.bangs.length) lines.push("", "warnings:", ...res.bangs.map((b) => `  ${b}`));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("file-commands-list", {
		description: "Show loaded file-based slash commands and their sources",
		handler: async (_args, ctx) => {
			if (commands.size === 0) {
				ctx.ui.notify("(no file-based commands loaded)", "info");
				return;
			}
			const rows = [...commands.values()]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((c) => `/${c.name.padEnd(24)} ${c.description.slice(0, 60)}\n    ${c.sourceFile}`);
			ctx.ui.notify([`═ file-commands (${commands.size}) ═`, "", ...rows].join("\n"), "info");
		},
	});
}
