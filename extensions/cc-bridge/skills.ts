/**
 * cc-bridge/skills — expose per-vendor skill trees to pi's resource loader.
 *
 * pi ships a built-in skill catalogue injected into the system prompt via
 * <available_skills>; it just doesn't scan cross-vendor locations by
 * default. This submodule plugs every ~/<vendor>/skills and <cwd>/<vendor>/skills
 * into pi's `resources_discover` hook so a skill dropped under any of the
 * supported agents shows up without further config.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { findVendorResources } from "./lib/paths.js";
import { isExtensionDisabled } from "../../lib/settings.js";
import type { CcBridgeState } from "./state.js";

const TOGGLE_KEY = "cc-bridge.skills";
// Back-compat: the pre-refactor extension lived at extensions/skills.ts and
// was toggled under "skills". Respect either key so existing disabled lists
// keep working without forcing users to re-edit settings.local.json.
const LEGACY_TOGGLE_KEY = "skills";

export default function register(pi: ExtensionAPI, state: CcBridgeState): void {
	if (isExtensionDisabled(TOGGLE_KEY) || isExtensionDisabled(LEGACY_TOGGLE_KEY)) {
		state.skills = { enabled: false, roots: [] };
		return;
	}

	pi.on("resources_discover", (event) => {
		const resources = findVendorResources(event.cwd, "skills");
		const roots = resources.map((r) => r.path);
		// Keep the observed state up to date for /cc-bridge status.
		state.skills = { enabled: true, roots };
		if (roots.length === 0) return {};
		return { skillPaths: roots };
	});
}
