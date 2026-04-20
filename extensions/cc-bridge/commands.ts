/**
 * cc-bridge/commands — file-based slash commands from cross-vendor dirs.
 *
 * Scans ~/.claude/commands, ~/.codex/commands, ~/.gemini/commands,
 * ~/.pi/commands and the same four subpaths under the project root, in
 * priority ascending order: user roots first, then project roots. Later
 * roots override earlier ones on name collision.
 *
 * Each *.md file becomes a slash command. Subdirectories become ":"
 * namespaces (git/sync.md → /git:sync). Body is sent back to the model
 * via pi.sendUserMessage with $ARGS and $1..$9 substitution. !command
 * prefixes are intentionally NOT executed — that would sidestep the
 * permissions extension.
 */

import { relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../../lib/settings.js";
import { findVendorResources } from "./lib/paths.js";
import { parseFrontmatter, safeReadUtf8, walkFiles } from "./lib/md-frontmatter.js";
import type { CcBridgeState } from "./state.js";

const TOGGLE_KEY = "cc-bridge.commands";
const LEGACY_TOGGLE_KEY = "file-commands";

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

const nameFromRel = (rel: string): string =>
	rel.replace(/\.md$/, "").split(/[\\/]/).filter(Boolean).join(":");

const toArray = (v: unknown): string[] | undefined => {
	if (Array.isArray(v)) return v.map((x) => String(x));
	if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
	return undefined;
};

const loadCommandsFromRoot = (root: string): LoadedCommand[] => {
	const files = walkFiles(root, { extensions: [".md"] });
	const out: LoadedCommand[] = [];
	for (const full of files) {
		const raw = safeReadUtf8(full);
		if (raw === null) continue;
		const { frontmatter, body } = parseFrontmatter<CommandFrontmatter & Record<string, unknown>>(raw);
		const rel = relative(root, full);
		const name = nameFromRel(rel);
		if (!name) continue;
		const trimmed = body.trim();
		out.push({
			name,
			body: trimmed,
			description: String(frontmatter?.description ?? `(file-command from ${rel})`),
			argumentHint: frontmatter?.["argument-hint"] ? String(frontmatter["argument-hint"]) : undefined,
			allowedTools: toArray(frontmatter?.["allowed-tools"])?.join(","),
			sourceFile: full,
			sourceRoot: root,
			// model sees !command lines as plain text; warn so the user is aware
			hasBangPrefix: /^![ \t]*\w/m.test(trimmed),
		});
	}
	return out;
};

const collectAll = (cwd: string): { commands: Map<string, LoadedCommand>; collisions: string[]; bangWarns: string[] } => {
	const commands = new Map<string, LoadedCommand>();
	const collisions: string[] = [];
	const bangWarns: string[] = [];
	// Priority ascending: user first, project last (project wins on collision).
	const resources = [
		...findVendorResources(cwd, "commands", ["user"]),
		...findVendorResources(cwd, "commands", ["project"]),
	];
	for (const res of resources) {
		for (const cmd of loadCommandsFromRoot(res.path)) {
			if (commands.has(cmd.name)) {
				const prev = commands.get(cmd.name)!;
				collisions.push(`/${cmd.name}: ${prev.sourceFile} overridden by ${cmd.sourceFile}`);
			}
			commands.set(cmd.name, cmd);
			if (cmd.hasBangPrefix) {
				bangWarns.push(`/${cmd.name} contains \`!command\` lines — they are NOT executed (permissions-safe); model sees them as text.`);
			}
		}
	}
	return { commands, collisions, bangWarns };
};

const substituteArgs = (body: string, args: string): string => {
	const parts = args.trim().length ? args.trim().split(/\s+/) : [];
	let out = body.replace(/\$ARGS\b/g, args.trim());
	out = out.replace(/\$([1-9])/g, (_m, d: string) => parts[Number.parseInt(d, 10) - 1] ?? "");
	return out;
};

export interface CommandsReloadApi {
	reload: (ctx?: ExtensionContext) => { added: number; total: number; collisions: string[]; bangs: string[] };
}

export default function register(pi: ExtensionAPI, state: CcBridgeState): CommandsReloadApi {
	if (isExtensionDisabled(TOGGLE_KEY) || isExtensionDisabled(LEGACY_TOGGLE_KEY)) {
		state.commands = { enabled: false, entries: [], collisions: [], warnings: [] };
		return { reload: () => ({ added: 0, total: 0, collisions: [], bangs: [] }) };
	}

	const commands = new Map<string, LoadedCommand>();
	let warnedOnce = false;

	const publishState = (collisions: string[], warnings: string[]): void => {
		state.commands = {
			enabled: true,
			entries: [...commands.values()]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((c) => ({ name: c.name, description: c.description, sourceFile: c.sourceFile })),
			collisions,
			warnings,
		};
	};

	const reload = (ctx?: ExtensionContext): { added: number; total: number; collisions: string[]; bangs: string[] } => {
		const cwd = ctx?.cwd ?? process.cwd();
		const { commands: fresh, collisions, bangWarns } = collectAll(cwd);
		const newcomers: LoadedCommand[] = [];
		for (const [name, cmd] of fresh) {
			if (!commands.has(name)) newcomers.push(cmd);
			commands.set(name, cmd);
		}
		for (const name of [...commands.keys()]) {
			if (!fresh.has(name)) commands.delete(name);
		}
		for (const cmd of newcomers) {
			pi.registerCommand(cmd.name, {
				description: cmd.description + (cmd.argumentHint ? ` — ${cmd.argumentHint}` : ""),
				handler: async (args, handlerCtx) => {
					const current = commands.get(cmd.name);
					if (!current) {
						handlerCtx.ui.notify(`/${cmd.name} no longer available (file removed). Try /cc-bridge reload.`, "warning");
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
		publishState(collisions, bangWarns);
		return { added: newcomers.length, total: commands.size, collisions, bangs: bangWarns };
	};

	pi.on("session_start", async (_event, ctx) => {
		const res = reload(ctx);
		if (!warnedOnce) {
			warnedOnce = true;
			for (const msg of res.collisions) ctx.ui.notify(`cc-bridge/commands: ${msg}`, "warning");
			for (const msg of res.bangs) ctx.ui.notify(`cc-bridge/commands: ${msg}`, "warning");
		}
	});

	return { reload };
}
