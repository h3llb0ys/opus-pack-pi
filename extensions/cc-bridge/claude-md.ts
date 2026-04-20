/**
 * cc-bridge/claude-md — auto-load CLAUDE.md / AGENTS.md convention files.
 *
 * Two passes merge into the system prompt in ascending priority:
 *   1. Global: ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/AGENTS.md,
 *      ~/.pi/AGENTS.md (+ XDG fallback). Uses findVendorResources for the
 *      four per-vendor files, but each vendor has its own filename so we
 *      keep the explicit list rather than stuffing it through a helper.
 *   2. Project walk: walk from cwd up to $HOME collecting CLAUDE.md /
 *      AGENTS.md at every level. Farthest ancestor first → project-local
 *      section wins on merge.
 *
 * Files are mtime-cached so stable trees cost zero reads per turn.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isExtensionDisabled, loadOpusPackSection } from "../../lib/settings.js";
import type { CcBridgeState } from "./state.js";

const TOGGLE_KEY = "cc-bridge.claude-md";
const LEGACY_TOGGLE_KEY = "claude-md-loader";

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

const loadSettingsConfig = (): LoaderConfig => loadOpusPackSection("claudeMdLoader", DEFAULT_CONFIG);

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
	const home = homedir();
	// Per-vendor conventions files — each vendor has its own filename so a
	// findVendorResources() call wouldn't fit cleanly. Inline list stays small.
	const candidates = [
		join(home, ".claude", "CLAUDE.md"),
		join(home, ".codex", "AGENTS.md"),
		join(home, ".gemini", "AGENTS.md"),
		join(home, ".pi", "AGENTS.md"),
		join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "AGENTS.md"),
	];
	return candidates.filter((p) => existsSync(p));
};

const findWalkFiles = (cwd: string): string[] => {
	const stopAt = resolve(homedir());
	let dir = resolve(cwd);
	const chain: string[] = [];
	const seen = new Set<string>();
	while (dir && !seen.has(dir)) {
		seen.add(dir);
		chain.unshift(dir); // root first, cwd last → project wins on merge
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

interface BuildResult {
	merged: string;
	files: Array<{ path: string; bytes: number }>;
	totalChars: number;
	maxTotalChars: number;
}

const buildMerged = (cwd: string, cfg: LoaderConfig): BuildResult => {
	const paths: string[] = [];
	if (cfg.includeGlobal) paths.push(...findGlobalFiles());
	if (cfg.includeWalk) paths.push(...findWalkFiles(cwd));

	const seen = new Set<string>();
	const sections: string[] = [];
	const files: Array<{ path: string; bytes: number }> = [];
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
			files.push({ path: p, bytes: 0 });
			continue;
		}
		sections.push(section);
		files.push({ path: p, bytes: section.length });
		totalChars += section.length;
	}
	return { merged: sections.join("\n\n"), files, totalChars, maxTotalChars: cfg.maxTotalChars };
};

export default function register(pi: ExtensionAPI, state: CcBridgeState): void {
	if (isExtensionDisabled(TOGGLE_KEY) || isExtensionDisabled(LEGACY_TOGGLE_KEY)) {
		state.claudeMd = { enabled: false, files: [], totalChars: 0, maxTotalChars: 0 };
		return;
	}

	pi.on("before_agent_start", (event, ctx) => {
		const cfg = loadSettingsConfig();
		if (!cfg.enabled) {
			state.claudeMd = { enabled: false, files: [], totalChars: 0, maxTotalChars: cfg.maxTotalChars };
			return;
		}
		const result = buildMerged(ctx.cwd, cfg);
		state.claudeMd = {
			enabled: true,
			files: result.files,
			totalChars: result.totalChars,
			maxTotalChars: result.maxTotalChars,
		};
		if (!result.merged) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${result.merged}\n` };
	});
}
