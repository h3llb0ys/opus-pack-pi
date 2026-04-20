/**
 * Cross-vendor path discovery for the cc-bridge extension.
 *
 * Four CLI agents (Claude Code, Codex, Gemini, pi) keep their config
 * resources under per-vendor directories: ~/.claude, ~/.codex, ~/.gemini,
 * ~/.pi. This module walks the same subpath under each vendor dir at each
 * scope (project cwd vs user $HOME) and returns the found directories or
 * files with their scope annotated so callers can merge in priority order.
 *
 * Callers: skills.ts (scans "skills"), commands.ts (scans "commands"),
 * claude-md.ts (scans CLAUDE.md / AGENTS.md), hooks.ts (scans "hooks").
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VENDOR_DIRS = [".claude", ".codex", ".gemini", ".pi"] as const;
export type VendorDir = (typeof VENDOR_DIRS)[number];
export type Scope = "project" | "user";

export interface ResourcePath {
	scope: Scope;
	vendor: VendorDir;
	path: string;
}

const HOME = homedir();

/**
 * Collect existing paths for `subpath` (e.g. "skills", "commands",
 * "CLAUDE.md") across every vendor dir at each requested scope.
 *
 * Order of results: project first (higher priority for overrides),
 * then user. Within a scope, vendor order follows VENDOR_DIRS.
 * Callers are free to reverse or dedup depending on their semantics.
 */
export function findVendorResources(
	cwd: string,
	subpath: string,
	scopes: Scope[] = ["project", "user"],
): ResourcePath[] {
	const out: ResourcePath[] = [];
	for (const scope of scopes) {
		const root = scope === "project" ? cwd : HOME;
		for (const vendor of VENDOR_DIRS) {
			const full = join(root, vendor, subpath);
			if (existsSync(full)) {
				out.push({ scope, vendor, path: full });
			}
		}
	}
	return out;
}

/**
 * Bare path builder — does not check existence. Useful for error messages
 * that want to tell the user "no X found in any of these paths".
 */
export function candidateVendorPaths(cwd: string, subpath: string, scopes: Scope[] = ["project", "user"]): string[] {
	const out: string[] = [];
	for (const scope of scopes) {
		const root = scope === "project" ? cwd : HOME;
		for (const vendor of VENDOR_DIRS) {
			out.push(join(root, vendor, subpath));
		}
	}
	return out;
}
