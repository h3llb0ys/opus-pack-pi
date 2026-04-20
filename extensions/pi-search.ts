/**
 * pi-search — discover and install community pi extensions.
 *
 * `/pi-search [query]` queries two catalogues in parallel:
 *   - GitHub repository search for `topic:pi-package`
 *   - npm registry search for `keywords:pi-package` (same backend
 *     pi.dev/packages renders from)
 *
 * Results are merged by GitHub slug (owner/repo). Items that live in both
 * catalogues are shown once with a `[npm+gh]` badge; npm-only or gh-only
 * items get `[npm]` / `[gh]` badges. On install, an npm-available package
 * uses `pi install npm:<name>` (matches the pi.dev flow); otherwise
 * `pi install git:github.com/<slug>` is used as a fallback.
 *
 * Works independently of which LLM provider is active.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

type Source = "github" | "npm";

interface SearchConfig {
	enabled: boolean;
	denyList: string[];
	minStars: number;
	cacheTtlMs: number;
	sources: Source[];
	/**
	 * Applied to both catalogues: GitHub `topic:<keyword>` and npm
	 * `keywords:<keyword>`. The pi-package ecosystem uses the same name on
	 * both sides by convention, so a single knob keeps them in sync.
	 */
	keyword: string;
	/** Abort fetches that take longer than this (per request, ms). */
	fetchTimeoutMs: number;
}

const DEFAULT_CONFIG: SearchConfig = {
	enabled: true,
	denyList: [],
	minStars: 0,
	cacheTtlMs: 60 * 60 * 1000,
	sources: ["github", "npm"],
	keyword: "pi-package",
	fetchTimeoutMs: 10_000,
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

interface NpmPackageObject {
	name: string;
	description?: string;
	date?: string;
	links?: {
		npm?: string;
		homepage?: string;
		repository?: string;
		bugs?: string;
	};
	publisher?: { username?: string };
}

interface NpmSearchResponse {
	total: number;
	objects: Array<{ package: NpmPackageObject }>;
}

interface CachedBundle {
	fetchedAt: number;
	github?: GhSearchResponse;
	npm?: NpmSearchResponse;
}

/**
 * Unified row shown in the picker. `slug` is the dedupe key — derived
 * from GitHub full_name or the npm package's repository URL. When the
 * repository link is missing on an npm-only result, we fall back to
 * `npm:<name>` so it stays unique and distinguishable from a gh match.
 */
interface UnifiedResult {
	slug: string;
	displayName: string;
	description: string;
	sources: Set<Source>;
	stars?: number;
	updatedAt?: string;
	archived?: boolean;
	githubUrl?: string;
	githubSlug?: string;
	npmName?: string;
}

const loadConfig = (): SearchConfig => loadOpusPackSection("piSearch", DEFAULT_CONFIG);

const cacheKey = (query: string, keyword: string): string =>
	createHash("sha1").update(`${keyword}::${query}`).digest("hex").slice(0, 16);

const readCache = (query: string, keyword: string, ttl: number): CachedBundle | null => {
	if (!existsSync(CACHE_DIR)) return null;
	const path = join(CACHE_DIR, `${cacheKey(query, keyword)}.json`);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as CachedBundle;
		if (!parsed.fetchedAt || Date.now() - parsed.fetchedAt > ttl) return null;
		// Reject entries that pre-date the bundle schema (old single-source
		// cache stored `{fetchedAt, data}`) or otherwise contain nothing
		// usable — forcing a refetch instead of serving empty results.
		if (!parsed.github && !parsed.npm) return null;
		return parsed;
	} catch {
		return null;
	}
};

const writeCache = (query: string, keyword: string, bundle: CachedBundle) => {
	try {
		if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(join(CACHE_DIR, `${cacheKey(query, keyword)}.json`), JSON.stringify(bundle));
	} catch { /* cache is best-effort */ }
};

const ghHeaders = (): Record<string, string> => {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "opus-pack-pi/pi-search",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	return headers;
};

const timedFetch = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: ac.signal });
	} finally {
		clearTimeout(t);
	}
};

const searchGithub = async (query: string, topic: string, timeoutMs: number): Promise<GhSearchResponse> => {
	const qs = `topic:${encodeURIComponent(topic)}${query ? `+${encodeURIComponent(query)}` : ""}+fork:false&sort=stars&order=desc&per_page=30`;
	const url = `https://api.github.com/search/repositories?q=${qs}`;
	const res = await timedFetch(url, { headers: ghHeaders() }, timeoutMs);
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
	}
	return (await res.json()) as GhSearchResponse;
};

/**
 * Look up repository metadata (stars, updated_at, archived, description)
 * for an explicit list of slugs in a single call via the `repo:` qualifier.
 * Used to fill in the star/freshness columns for npm results whose GitHub
 * repo is not tagged with the configured `topic:` and therefore didn't
 * land in the primary search. Silent on failure — cosmetic enrichment.
 *
 * Slugs come from parseGithubSlug and only contain owner/name characters
 * GitHub accepts verbatim; URL-encoding the slash would trip the `repo:`
 * qualifier parser. 50 `repo:owner/name` terms (~25 chars avg) stay well
 * under GitHub's query-length and overall-URL caps.
 */
const enrichGithubBySlugs = async (slugs: string[], timeoutMs: number): Promise<GhSearchResponse | null> => {
	if (slugs.length === 0) return null;
	const batch = slugs.slice(0, 50);
	const q = batch.map((s) => `repo:${s}`).join("+");
	const url = `https://api.github.com/search/repositories?q=${q}&per_page=${batch.length}`;
	try {
		const res = await timedFetch(url, { headers: ghHeaders() }, timeoutMs);
		if (!res.ok) return null;
		return (await res.json()) as GhSearchResponse;
	} catch {
		return null;
	}
};

const searchNpm = async (query: string, keyword: string, timeoutMs: number): Promise<NpmSearchResponse> => {
	// `-/v1/search` accepts the `text` param with the same syntax the npm
	// website uses (qualifiers like `keywords:<name>` are honoured). This
	// matches what pi.dev/packages shows.
	const text = `keywords:${keyword}${query ? ` ${query}` : ""}`;
	const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=50`;
	const headers = { Accept: "application/json", "User-Agent": "opus-pack-pi/pi-search" };
	const res = await timedFetch(url, { headers }, timeoutMs);
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`npm registry ${res.status}: ${body.slice(0, 200)}`);
	}
	return (await res.json()) as NpmSearchResponse;
};

/** Extract `owner/repo` out of a repository URL the way npm stores it. */
const parseGithubSlug = (url?: string): string | undefined => {
	if (!url) return undefined;
	const m = url.match(/github\.com[/:]([^/]+)\/([^/.#?]+)(?:\.git)?/i);
	if (!m) return undefined;
	return `${m[1]}/${m[2]}`;
};

const fmtAge = (iso?: string): string => {
	if (!iso) return "?";
	const diff = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(diff)) return "?";
	const days = Math.floor(diff / 86_400_000);
	if (days < 1) return "today";
	if (days < 30) return `${days}d ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
};

const unify = (gh: GhSearchResponse | undefined, npm: NpmSearchResponse | undefined): UnifiedResult[] => {
	// Dedupe key is the lowercased slug — GitHub is case-insensitive but
	// returns canonical casing, while authors sometimes embed mixed-case
	// repo URLs in package.json. Without this, `Foo/Bar` from npm and
	// `foo/bar` from GitHub end up as two rows.
	const bySlug = new Map<string, UnifiedResult>();

	for (const repo of gh?.items ?? []) {
		const slug = repo.full_name;
		bySlug.set(slug.toLowerCase(), {
			slug,
			displayName: repo.full_name,
			description: repo.description ?? "",
			sources: new Set<Source>(["github"]),
			stars: repo.stargazers_count,
			updatedAt: repo.updated_at,
			archived: repo.archived,
			githubUrl: repo.html_url,
			githubSlug: slug,
		});
	}

	for (const entry of npm?.objects ?? []) {
		const pkg = entry.package;
		const ghSlug = parseGithubSlug(pkg.links?.repository);
		const key = (ghSlug ?? `npm:${pkg.name}`).toLowerCase();
		const existing = bySlug.get(key);
		if (existing) {
			existing.sources.add("npm");
			existing.npmName = pkg.name;
			// Prefer richer description when github had none.
			if (!existing.description && pkg.description) existing.description = pkg.description;
			// npm's `date` is publish time — leave github's updated_at as the
			// primary freshness signal since it also covers non-release work.
			continue;
		}
		bySlug.set(key, {
			slug: ghSlug ?? `npm:${pkg.name}`,
			displayName: pkg.name,
			description: pkg.description ?? "",
			sources: new Set<Source>(["npm"]),
			updatedAt: pkg.date,
			githubSlug: ghSlug,
			githubUrl: ghSlug ? `https://github.com/${ghSlug}` : undefined,
			npmName: pkg.name,
		});
	}

	const safeTime = (iso?: string): number => {
		if (!iso) return 0;
		const t = Date.parse(iso);
		return Number.isFinite(t) ? t : 0;
	};
	return [...bySlug.values()].sort((a, b) => {
		// 1. Stars desc (npm-only without enrichment gets 0).
		const sa = a.stars ?? 0;
		const sb = b.stars ?? 0;
		if (sa !== sb) return sb - sa;
		// 2. Most recent update wins (NaN-safe).
		return safeTime(b.updatedAt) - safeTime(a.updatedAt);
	});
};

const sourceBadge = (r: UnifiedResult): string => {
	const hasGh = r.sources.has("github");
	const hasNpm = r.sources.has("npm");
	if (hasGh && hasNpm) return "[npm+gh]";
	if (hasNpm) return "[npm]";
	return "[gh]";
};

const confirmSuspicious = async (ctx: ExtensionCommandContext, r: UnifiedResult): Promise<boolean> => {
	const warnings: string[] = [];
	if (r.stars !== undefined && r.stars < 3) warnings.push(`low stars (${r.stars})`);
	if (r.updatedAt) {
		const ageDays = (Date.now() - new Date(r.updatedAt).getTime()) / 86_400_000;
		if (ageDays > 730) warnings.push(`last update ${fmtAge(r.updatedAt)}`);
	}
	if (r.archived) warnings.push("repository archived");
	if (warnings.length === 0) return true;
	return ctx.ui.confirm(
		`Install ${r.displayName}?`,
		`Warnings: ${warnings.join(", ")}.`,
		{ timeout: 30_000 },
	);
};

/** Pick the install command — npm wins when available (matches pi.dev flow). */
const installCommandFor = (r: UnifiedResult): { src: string; label: string } => {
	if (r.npmName) return { src: `npm:${r.npmName}`, label: `pi install npm:${r.npmName}` };
	if (r.githubSlug) return { src: `git:github.com/${r.githubSlug}`, label: `pi install git:github.com/${r.githubSlug}` };
	// Shouldn't happen — every result has at least one of these.
	throw new Error(`no install source for ${r.displayName}`);
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("pi-search")) return;
	pi.registerCommand("pi-search", {
		description: "Search and install community pi extensions (GitHub topic:pi-package + npm keywords:pi-package)",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			if (!cfg.enabled) {
				ctx.ui.notify("/pi-search disabled in settings (opus-pack.piSearch.enabled)", "info");
				return;
			}
			const query = (args ?? "").trim();

			const wantGh = cfg.sources.includes("github");
			const wantNpm = cfg.sources.includes("npm");
			if (!wantGh && !wantNpm) {
				ctx.ui.notify("piSearch.sources is empty — enable at least one of: github, npm", "warning");
				return;
			}

			const cached = readCache(query, cfg.keyword, cfg.cacheTtlMs);
			let ghData = cached?.github;
			let npmData = cached?.npm;

			// Only fetch sources the user actually wants that are missing
			// from (or absent in) the cache. Handles config flips
			// (sources: ["github"] → ["github","npm"]) without waiting for
			// the TTL: the existing source stays cached while the newly
			// enabled source is filled in.
			const needGh = wantGh && !ghData;
			const needNpm = wantNpm && !npmData;

			if (needGh || needNpm) {
				const [ghRes, npmRes] = await Promise.allSettled([
					needGh ? searchGithub(query, cfg.keyword, cfg.fetchTimeoutMs) : Promise.resolve(ghData),
					needNpm ? searchNpm(query, cfg.keyword, cfg.fetchTimeoutMs) : Promise.resolve(npmData),
				]);
				if (needGh) {
					if (ghRes.status === "fulfilled") ghData = ghRes.value;
					else ctx.ui.notify(`GitHub search failed: ${(ghRes.reason as Error).message}`, "warning");
				}
				if (needNpm) {
					if (npmRes.status === "fulfilled") npmData = npmRes.value;
					else ctx.ui.notify(`npm search failed: ${(npmRes.reason as Error).message}`, "warning");
				}

				if (!ghData && !npmData) return;

				// Enrichment pass: npm packages whose GitHub repo is not
				// tagged with the configured topic still have a repository
				// URL in their npm metadata, but the primary GitHub search
				// didn't surface them. Fetch stars/freshness for those
				// slugs in a single batched `repo:` query so the picker
				// isn't littered with `—` placeholders.
				if (wantGh && ghData && npmData) {
					const known = new Set(ghData.items.map((r) => r.full_name.toLowerCase()));
					const missing: string[] = [];
					for (const { package: pkg } of npmData.objects) {
						const slug = parseGithubSlug(pkg.links?.repository);
						if (slug && !known.has(slug.toLowerCase())) missing.push(slug);
					}
					if (missing.length > 0) {
						const extra = await enrichGithubBySlugs(missing, cfg.fetchTimeoutMs);
						if (extra?.items?.length) {
							const mergedByName = new Map(ghData.items.map((r) => [r.full_name.toLowerCase(), r]));
							for (const item of extra.items) mergedByName.set(item.full_name.toLowerCase(), item);
							ghData = { total_count: mergedByName.size, items: [...mergedByName.values()] };
						}
					}
				}

				writeCache(query, cfg.keyword, { fetchedAt: Date.now(), github: ghData, npm: npmData });
			}

			const unified = unify(ghData, npmData);
			const filtered = unified.filter((r) => {
				if (cfg.denyList.includes(r.slug)) return false;
				if (cfg.denyList.includes(r.githubSlug ?? "")) return false;
				if (cfg.denyList.includes(r.npmName ?? "")) return false;
				// minStars only applies when we have a stars signal (gh side).
				if (r.stars !== undefined && r.stars < cfg.minStars) return false;
				return true;
			});
			if (filtered.length === 0) {
				ctx.ui.notify(`No results for "${cfg.keyword}" ${query ? `+ "${query}"` : ""}`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(
					filtered.slice(0, 10).map((r) => {
						const stars = r.stars !== undefined ? ` ★${r.stars}` : "";
						return `${sourceBadge(r)} ${r.displayName}${stars} · ${fmtAge(r.updatedAt)}\n  ${r.description}`;
					}).join("\n\n"),
					"info",
				);
				return;
			}

			while (true) {
				const options = filtered.slice(0, 20).map((r) => {
					const stars = r.stars !== undefined ? `★${r.stars}` : "—";
					return `${sourceBadge(r)} ${r.displayName}  ${stars}  [${fmtAge(r.updatedAt)}]  ${r.description}`.slice(0, 180);
				});
				options.push("Done");
				const picked = await ctx.ui.select("Community pi extensions:", options);
				if (!picked || picked === "Done") return;
				const idx = options.indexOf(picked);
				const row = filtered[idx];

				const actions = ["Install"];
				if (row.githubUrl) actions.push("Open on GitHub");
				if (row.npmName) actions.push("Open on npm");
				actions.push("Back");
				const action = await ctx.ui.select(`${row.displayName} — action:`, actions);
				if (!action || action === "Back") continue;
				if (action === "Open on GitHub" && row.githubUrl) {
					const opener = process.platform === "darwin" ? "open" : "xdg-open";
					await pi.exec(opener, [row.githubUrl], {});
					continue;
				}
				if (action === "Open on npm" && row.npmName) {
					const opener = process.platform === "darwin" ? "open" : "xdg-open";
					await pi.exec(opener, [`https://www.npmjs.com/package/${row.npmName}`], {});
					continue;
				}
				if (action === "Install") {
					if (!(await confirmSuspicious(ctx, row))) {
						ctx.ui.notify("install cancelled", "info");
						continue;
					}
					// Surface a friendlier error if `pi` is not on PATH.
					const whichPi = await pi.exec("which", ["pi"], { timeout: 2000 });
					const { src, label } = installCommandFor(row);
					if (whichPi.code !== 0) {
						ctx.ui.notify(`install skipped: \`pi\` is not on PATH. Run manually:\n  ${label}`, "error");
						continue;
					}
					ctx.ui.notify(`installing ${row.displayName} via ${src}...`, "info");
					const res = await pi.exec("pi", ["install", src], { timeout: 180_000 });
					if (res.code !== 0) {
						ctx.ui.notify(`pi install failed (${res.code}): ${res.stderr.trim().slice(0, 300)}`, "error");
						continue;
					}
					ctx.ui.notify(`installed ${row.displayName}. reloading extensions...`, "info");
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
