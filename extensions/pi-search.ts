/**
 * pi-search — discover and install community pi extensions.
 *
 * `/pi-search [query]` calls the GitHub repository search API with
 * topic:pi-package, caches results for 1h, shows an interactive picker,
 * and installs via `pi install git:github.com/<owner>/<repo>` + session reload.
 *
 * Works independently of which LLM provider is active.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

interface SearchConfig {
	enabled: boolean;
	denyList: string[];
	minStars: number;
	cacheTtlMs: number;
}

const DEFAULT_CONFIG: SearchConfig = {
	enabled: true,
	denyList: [],
	minStars: 0,
	cacheTtlMs: 60 * 60 * 1000,
};

const CACHE_DIR = join(tmpdir(), "pi-search-cache");

interface GhRepo {
	full_name: string;
	stargazers_count: number;
	description: string | null;
	html_url: string;
	updated_at: string;
	archived: boolean;
}

interface GhSearchResponse {
	total_count: number;
	items: GhRepo[];
}

const loadConfig = (): SearchConfig => loadOpusPackSection("piSearch", DEFAULT_CONFIG);

const cacheKey = (query: string): string => {
	return createHash("sha1").update(query).digest("hex").slice(0, 16);
};

const readCache = (query: string, ttl: number): GhSearchResponse | null => {
	if (!existsSync(CACHE_DIR)) return null;
	const path = join(CACHE_DIR, `${cacheKey(query)}.json`);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as { fetchedAt: number; data: GhSearchResponse };
		if (Date.now() - parsed.fetchedAt > ttl) return null;
		return parsed.data;
	} catch {
		return null;
	}
};

const writeCache = (query: string, data: GhSearchResponse) => {
	try {
		if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(join(CACHE_DIR, `${cacheKey(query)}.json`), JSON.stringify({ fetchedAt: Date.now(), data }));
	} catch { /* cache is best-effort */ }
};

const searchGithub = async (query: string): Promise<GhSearchResponse> => {
	const qs = `topic:pi-package${query ? `+${encodeURIComponent(query)}` : ""}+fork:false&sort=stars&order=desc&per_page=30`;
	const url = `https://api.github.com/search/repositories?q=${qs}`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "opus-pack-pi/pi-search",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(url, { headers });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
	}
	return (await res.json()) as GhSearchResponse;
};

const fmtAge = (iso: string): string => {
	const diff = Date.now() - new Date(iso).getTime();
	const days = Math.floor(diff / 86_400_000);
	if (days < 1) return "today";
	if (days < 30) return `${days}d ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
};

const confirmSuspicious = async (ctx: ExtensionCommandContext, repo: GhRepo): Promise<boolean> => {
	const warnings: string[] = [];
	const ageDays = (Date.now() - new Date(repo.updated_at).getTime()) / 86_400_000;
	if (repo.stargazers_count < 3) warnings.push(`low stars (${repo.stargazers_count})`);
	if (ageDays > 730) warnings.push(`last update ${fmtAge(repo.updated_at)}`);
	if (repo.archived) warnings.push("repository archived");
	if (warnings.length === 0) return true;
	const ok = await ctx.ui.confirm(
		`Install ${repo.full_name}?`,
		`Warnings: ${warnings.join(", ")}.`,
		{ timeout: 30_000 },
	);
	return ok;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("pi-search")) return;
	pi.registerCommand("pi-search", {
		description: "Search and install community pi extensions (topic:pi-package)",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			if (!cfg.enabled) {
				ctx.ui.notify("/pi-search disabled in settings (opus-pack.piSearch.enabled)", "info");
				return;
			}
			const query = (args ?? "").trim();
			const cached = readCache(query, cfg.cacheTtlMs);
			let data: GhSearchResponse;
			if (cached) {
				data = cached;
			} else {
				try {
					data = await searchGithub(query);
				} catch (e) {
					ctx.ui.notify(`GitHub search failed: ${(e as Error).message}`, "error");
					return;
				}
				writeCache(query, data);
			}

			const filtered = data.items.filter((r) => !cfg.denyList.includes(r.full_name) && r.stargazers_count >= cfg.minStars);
			if (filtered.length === 0) {
				ctx.ui.notify(`No results for topic:pi-package ${query ? `+ "${query}"` : ""}`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(filtered.slice(0, 10).map((r) => `${r.full_name} · ★${r.stargazers_count} · ${fmtAge(r.updated_at)}\n  ${r.description ?? ""}`).join("\n\n"), "info");
				return;
			}

			while (true) {
				const options = filtered.slice(0, 20).map((r) => `${r.full_name}  ★${r.stargazers_count}  [${fmtAge(r.updated_at)}]  ${r.description ?? ""}`.slice(0, 160));
				options.push("Done");
				const picked = await ctx.ui.select("Community pi extensions:", options);
				if (!picked || picked === "Done") return;
				const idx = options.indexOf(picked);
				const repo = filtered[idx];

				const actions = [
					"Install",
					"Open on GitHub",
					"Back",
				];
				const action = await ctx.ui.select(`${repo.full_name} — action:`, actions);
				if (!action || action === "Back") continue;
				if (action === "Open on GitHub") {
					const opener = process.platform === "darwin" ? "open" : "xdg-open";
					await pi.exec(opener, [repo.html_url], {});
					continue;
				}
				if (action === "Install") {
					if (!(await confirmSuspicious(ctx, repo))) {
						ctx.ui.notify("install cancelled", "info");
						continue;
					}
					// Surface a friendlier error if `pi` is not on PATH (rare but possible
					// in Docker images, nix shells, or after npm-global tweaks).
					const whichPi = await pi.exec("which", ["pi"], { timeout: 2000 });
					if (whichPi.code !== 0) {
						ctx.ui.notify("install skipped: `pi` is not on PATH. Run the install manually:\n" +
							`  pi install git:github.com/${repo.full_name}`, "error");
						continue;
					}
					ctx.ui.notify(`installing ${repo.full_name}...`, "info");
					const src = `git:github.com/${repo.full_name}`;
					const res = await pi.exec("pi", ["install", src], { timeout: 180_000 });
					if (res.code !== 0) {
						ctx.ui.notify(`pi install failed (${res.code}): ${res.stderr.trim().slice(0, 300)}`, "error");
						continue;
					}
					ctx.ui.notify(`installed ${repo.full_name}. reloading extensions...`, "info");
					try {
						await ctx.reload();
					} catch (e) {
						ctx.ui.notify(`reload failed: ${(e as Error).message}. Run /reload manually.`, "warning");
					}
					return;
				}
			}
		},
	});
}
