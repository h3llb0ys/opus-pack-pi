/**
 * claude-md-loader — auto-load CLAUDE.md / AGENTS.md convention files.
 *
 * CC-compat pattern: walk upward from cwd collecting CLAUDE.md and AGENTS.md,
 * merge them into the system prompt in priority order (global → walk → project
 * local). Files are mtime-cached so reading cost per turn stays zero for
 * stable trees.
 *
 * Order appended to systemPrompt (each wrapped in XML for traceability):
 *   pi-default → APPEND_SYSTEM.md (pi-native) → this loader's merge → skills
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface LoaderConfig {
	enabled: boolean;
	includeGlobal: boolean;
	includeWalk: boolean;
	maxTotalChars: number;
}

const DEFAULT_CONFIG: LoaderConfig = {
	enabled: true,
	includeGlobal: true,
	includeWalk: true,
	maxTotalChars: 20_000,
};

const FILENAMES = ["CLAUDE.md", "AGENTS.md"] as const;

interface CachedFile {
	mtimeMs: number;
	body: string;
}

const cache = new Map<string, CachedFile>();

const loadSettingsConfig = (): LoaderConfig => {
	try {
		const raw = readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8");
		const parsed = JSON.parse(raw);
		const user = parsed?.["opus-pack"]?.["claudeMdLoader"];
		if (user && typeof user === "object") {
			return { ...DEFAULT_CONFIG, ...user };
		}
	} catch {
		// settings missing or invalid — use defaults
	}
	return DEFAULT_CONFIG;
};

const readCached = (path: string): string | null => {
	try {
		const stat = statSync(path);
		const cached = cache.get(path);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.body;
		const body = readFileSync(path, "utf8");
		cache.set(path, { mtimeMs: stat.mtimeMs, body });
		return body;
	} catch {
		cache.delete(path);
		return null;
	}
};

const findGlobalFiles = (): string[] => {
	const found: string[] = [];
	const global = join(homedir(), ".claude", "CLAUDE.md");
	if (existsSync(global)) found.push(global);
	const xdg = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "AGENTS.md");
	if (existsSync(xdg)) found.push(xdg);
	return found;
};

const findWalkFiles = (cwd: string): string[] => {
	// Walk from cwd up to HOME (or /) collecting CLAUDE.md / AGENTS.md.
	// Order: farthest ancestor first, cwd last → project-local wins on merge.
	const stopAt = resolve(homedir());
	let dir = resolve(cwd);
	const chain: string[] = [];
	const seen = new Set<string>();
	while (dir && !seen.has(dir)) {
		seen.add(dir);
		chain.unshift(dir); // unshift so root comes first
		if (dir === stopAt || dir === "/") break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const out: string[] = [];
	for (const d of chain) {
		for (const name of FILENAMES) {
			const p = join(d, name);
			if (existsSync(p)) out.push(p);
		}
	}
	return out;
};

const buildMerged = (cwd: string, cfg: LoaderConfig): string => {
	const paths: string[] = [];
	if (cfg.includeGlobal) paths.push(...findGlobalFiles());
	if (cfg.includeWalk) paths.push(...findWalkFiles(cwd));

	const seen = new Set<string>();
	const sections: string[] = [];
	let totalChars = 0;
	for (const raw of paths) {
		const p = isAbsolute(raw) ? raw : resolve(cwd, raw);
		if (seen.has(p)) continue;
		seen.add(p);
		const body = readCached(p);
		if (!body) continue;
		const trimmed = body.trim();
		if (!trimmed) continue;
		const tag = p.endsWith("AGENTS.md") ? "agents-md" : "claude-md";
		const section = `<${tag} path="${p}">\n${trimmed}\n</${tag}>`;
		if (totalChars + section.length > cfg.maxTotalChars) {
			sections.push(`<${tag} path="${p}" truncated="true">[skipped: would exceed maxTotalChars ${cfg.maxTotalChars}]</${tag}>`);
			continue;
		}
		sections.push(section);
		totalChars += section.length;
	}
	return sections.join("\n\n");
};

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const cfg = loadSettingsConfig();
		if (!cfg.enabled) return;
		const merged = buildMerged(ctx.cwd, cfg);
		if (!merged) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${merged}\n` };
	});

	pi.registerCommand("claude-md", {
		description: "List loaded CLAUDE.md / AGENTS.md files and their sizes",
		handler: async (_args, ctx: ExtensionContext) => {
			const cfg = loadSettingsConfig();
			const paths: string[] = [];
			if (cfg.includeGlobal) paths.push(...findGlobalFiles());
			if (cfg.includeWalk) paths.push(...findWalkFiles(ctx.cwd));
			const seen = new Set<string>();
			const lines = [`═ claude-md loader (enabled=${cfg.enabled}) ═`];
			if (paths.length === 0) {
				lines.push("(no CLAUDE.md or AGENTS.md files found)");
			} else {
				for (const p of paths) {
					if (seen.has(p)) continue;
					seen.add(p);
					try {
						const stat = statSync(p);
						lines.push(`  ${p}  (${stat.size}B)`);
					} catch {
						lines.push(`  ${p}  [unreadable]`);
					}
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
