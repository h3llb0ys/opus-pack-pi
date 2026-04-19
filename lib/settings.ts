/**
 * Shared, mtime-cached readers for settings.json and settings.local.json.
 *
 * Every extension in this pack that wants a slice of opus-pack config used
 * to reimplement the same readFileSync + JSON.parse + key lookup. In long
 * sessions that adds up to one filesystem round-trip per extension per
 * before_agent_start. This helper caches the parsed contents and reuses
 * them until the file's mtime changes.
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi/agent/settings.json");
const LOCAL_SETTINGS_PATH = join(homedir(), ".pi/agent/settings.local.json");

interface Cache {
	mtimeMs: number;
	parsed: any;
}

const caches = new Map<string, Cache>();

const loadRawFrom = (path: string): any => {
	try {
		const stat = statSync(path);
		const cached = caches.get(path);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		caches.set(path, { mtimeMs: stat.mtimeMs, parsed });
		return parsed;
	} catch {
		return null;
	}
};

const invalidateCache = (path: string) => {
	caches.delete(path);
};

/**
 * Read the `opus-pack.<section>` block, merged over the supplied defaults.
 * Returns a fresh object each call so callers can mutate safely.
 */
export function loadOpusPackSection<T extends object>(section: string, defaults: T): T {
	const parsed = loadRawFrom(SETTINGS_PATH);
	const user = parsed?.["opus-pack"]?.[section];
	if (user && typeof user === "object") {
		return { ...defaults, ...user } as T;
	}
	return { ...defaults };
}

/** Escape hatch for consumers that want the full parsed settings.json. */
export function loadSettingsRoot(): any {
	return loadRawFrom(SETTINGS_PATH);
}

/** Escape hatch for the local overrides file. */
export function loadLocalSettingsRoot(): any {
	return loadRawFrom(LOCAL_SETTINGS_PATH);
}

/**
 * Read `<cwd>/.pi/settings.json` (project-level config, lower precedence than
 * project-local but higher than user-level). Mtime-cached via the same map.
 */
export function loadProjectSettingsRoot(cwd: string): any {
	return loadRawFrom(join(cwd, ".pi", "settings.json"));
}

/** Project-local override: `<cwd>/.pi/settings.local.json`. Highest precedence. */
export function loadProjectLocalSettingsRoot(cwd: string): any {
	return loadRawFrom(join(cwd, ".pi", "settings.local.json"));
}

/**
 * Is the opus-pack extension with the given short name currently disabled?
 * Read from settings.local.json → opus-pack.extensions.disabled[].
 */
export function isExtensionDisabled(name: string): boolean {
	const parsed = loadLocalSettingsRoot();
	const disabled = parsed?.["opus-pack"]?.["extensions"]?.["disabled"];
	return Array.isArray(disabled) && disabled.includes(name);
}

/**
 * Return the sorted list of disabled extension short names, or an empty array.
 */
export function listDisabledExtensions(): string[] {
	const parsed = loadLocalSettingsRoot();
	const disabled = parsed?.["opus-pack"]?.["extensions"]?.["disabled"];
	return Array.isArray(disabled) ? [...disabled].map(String).sort() : [];
}

/**
 * Persist an extension's disabled flag into settings.local.json via an
 * atomic write. Invalidates the local-settings cache so the next read
 * picks up the change in the same session.
 */
export function setExtensionDisabled(name: string, disabled: boolean): { saved: boolean; error?: string } {
	try {
		let data: any = existsSync(LOCAL_SETTINGS_PATH)
			? (() => { try { return JSON.parse(readFileSync(LOCAL_SETTINGS_PATH, "utf8")); } catch { return {}; } })()
			: {};
		if (!data["opus-pack"]) data["opus-pack"] = {};
		if (!data["opus-pack"]["extensions"]) data["opus-pack"]["extensions"] = {};
		const current: string[] = Array.isArray(data["opus-pack"]["extensions"]["disabled"])
			? data["opus-pack"]["extensions"]["disabled"]
			: [];
		const set = new Set(current);
		if (disabled) set.add(name);
		else set.delete(name);
		data["opus-pack"]["extensions"]["disabled"] = [...set].sort();
		const tmp = `${LOCAL_SETTINGS_PATH}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2));
		renameSync(tmp, LOCAL_SETTINGS_PATH);
		invalidateCache(LOCAL_SETTINGS_PATH);
		return { saved: true };
	} catch (e) {
		return { saved: false, error: (e as Error).message };
	}
}
