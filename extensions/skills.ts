/**
 * Skills: CC-compat discovery.
 *
 * pi already injects an <available_skills> catalog into the system prompt and
 * instructs the model to load bodies via the read tool. The only gap is that
 * Claude Code's skill tree at ~/.claude/skills isn't one of pi's default
 * scan roots. This extension plugs that directory in via the
 * resources_discover hook so CC skills (and per-plugin subtrees) become
 * visible to pi without any other changes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", (_event) => {
		const root = join(homedir(), ".claude", "skills");
		if (!existsSync(root)) return {};
		return { skillPaths: [root] };
	});
}
