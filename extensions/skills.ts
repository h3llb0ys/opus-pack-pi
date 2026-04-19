/**
 * Skills: CC-compat discovery.
 *
 * pi already injects an <available_skills> catalog into the system prompt and
 * instructs the model to load bodies via the read tool. The only gap is that
 * third-party CLI-agents (Claude Code, Codex, Gemini) keep their skill trees
 * under per-vendor directories that pi doesn't scan by default. This
 * extension plugs them in via the resources_discover hook so cross-vendor
 * skills become visible without any other changes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isExtensionDisabled } from "../lib/settings.js";

const candidateRoots = (): string[] => {
	const home = homedir();
	return [
		join(home, ".claude", "skills"),
		join(home, ".codex", "skills"),
		join(home, ".gemini", "skills"),
		join(home, ".pi", "skills"),
	];
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("skills")) return;
	pi.on("resources_discover", (_event) => {
		const skillPaths = candidateRoots().filter((p) => existsSync(p));
		if (skillPaths.length === 0) return {};
		return { skillPaths };
	});
}
