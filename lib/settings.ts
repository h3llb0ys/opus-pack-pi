/**
 * Shared, mtime-cached reader for ~/.pi/agent/settings.json.
 *
 * Every extension in this pack that wants a slice of opus-pack config used
 * to reimplement the same readFileSync + JSON.parse + key lookup. In long
 * sessions that adds up to one filesystem round-trip per extension per
 * before_agent_start. This helper caches the parsed contents and reuses
 * them until the file's mtime changes.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi/agent/settings.json");

let cachedMtimeMs = 0;
let cachedParsed: any = null;
let cachedRawPath = SETTINGS_PATH;

const loadRaw = (path: string = SETTINGS_PATH): any => {
	try {
		const stat = statSync(path);
		if (path === cachedRawPath && cachedParsed && stat.mtimeMs === cachedMtimeMs) {
			return cachedParsed;
		}
		const raw = readFileSync(path, "utf8");
		cachedParsed = JSON.parse(raw);
		cachedMtimeMs = stat.mtimeMs;
		cachedRawPath = path;
		return cachedParsed;
	} catch {
		return null;
	}
};

/**
 * Read the `opus-pack.<section>` block, merged over the supplied defaults.
 * Returns a fresh object each call so callers can mutate safely.
 */
export function loadOpusPackSection<T extends Record<string, unknown>>(section: string, defaults: T): T {
	const parsed = loadRaw();
	const user = parsed?.["opus-pack"]?.[section];
	if (user && typeof user === "object") {
		return { ...defaults, ...user } as T;
	}
	return { ...defaults };
}

/** Escape hatch for consumers that want the full parsed settings.json. */
export function loadSettingsRoot(): any {
	return loadRaw();
}
