/**
 * Shared md + frontmatter helpers for the cc-bridge extension.
 *
 * Pi ships its own `parseFrontmatter` (we re-export it below). What pi does
 * NOT ship is a size-capped, depth-limited directory walk, which all three
 * file-tree sub-modules need: they scan arbitrary user directories and
 * can't blow up on a 500MB mis-placed binary or a symlink loop.
 */

import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";

export { parseFrontmatter } from "@mariozechner/pi-coding-agent";

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_DEPTH = 8;

export interface WalkOptions {
	/** Extensions to match, each with leading dot. Default: [".md"]. */
	extensions?: string[];
	/** Max file size to include. Default: 64KiB. */
	maxBytes?: number;
	/** Max recursion depth. Default: 8. */
	maxDepth?: number;
}

/**
 * Walk a directory collecting regular files that match the extension filter,
 * respecting a size cap and depth limit. Symlinks are inspected with
 * lstatSync so a rogue `commands/loop -> ..` can't trick us into the parent.
 */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
	const extensions = options.extensions ?? [".md"];
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const out: string[] = [];
	const visit = (dir: string, depth: number): void => {
		if (depth > maxDepth) return;
		if (!existsSync(dir)) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(dir, name);
			let st;
			try {
				st = lstatSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				visit(full, depth + 1);
				continue;
			}
			if (!st.isFile()) continue;
			if (!extensions.some((ext) => name.endsWith(ext))) continue;
			if (st.size > maxBytes) continue;
			out.push(full);
		}
	};
	visit(root, 0);
	return out;
}

/** Read a file as utf8, returning null on any error. Size-capped by walkFiles. */
export function safeReadUtf8(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
