/**
 * Safe-Deny — non-interactive guardrail.
 *
 * Blocks obviously dangerous bash commands and writes/edits to protected paths.
 * No askForUnknown — user is autonomous and confirm dialogs are noise.
 *
 * To bypass: set env PI_OPUS_PACK_UNSAFE=1 (e.g. for one-shot scripts).
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HOME = homedir();

const BASH_DENY: { pattern: RegExp; reason: string }[] = [
	{ pattern: /\brm\s+-rf?\s+\/(?!\S)/i, reason: "rm -rf / blocked" },
	{ pattern: /\brm\s+-rf?\s+~(?:\/|$)/i, reason: "rm -rf ~ blocked" },
	{ pattern: /\bgit\s+push\s+(?:-f|--force)\b.*\b(?:main|master|origin\/(?:main|master))\b/i, reason: "force push to main/master blocked" },
	{ pattern: /\bgit\s+commit\b.*\B--no-verify\b/i, reason: "git commit --no-verify blocked (Opus Pack policy)" },
	{ pattern: /\bchmod\b.*\b-R\b.*\b777\b/i, reason: "chmod -R 777 blocked" },
	{ pattern: /\bsudo\s+rm\b/i, reason: "sudo rm blocked" },
	{ pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: "fork bomb blocked" },
];

const PATH_DENY: { matcher: (abs: string) => boolean; reason: string }[] = [
	{ matcher: (p) => /(^|\/)\.env(\.|$)/.test(p), reason: ".env files protected" },
	{ matcher: (p) => /(^|\/)credentials(\.|$)/i.test(p), reason: "credentials files protected" },
	{ matcher: (p) => /\.pem$/i.test(p), reason: "*.pem files protected" },
	{ matcher: (p) => p.includes(`${HOME}/.ssh/`), reason: "~/.ssh protected" },
	{ matcher: (p) => p.startsWith(`${HOME}/.claude/`) || p === `${HOME}/.claude`, reason: "~/.claude protected (Opus Pack policy)" },
	{ matcher: (p) => p === `${HOME}/.pi/agent/SYSTEM.md`, reason: "~/.pi/agent/SYSTEM.md protected (would clobber pi base prompt)" },
];

const isBypassed = () => process.env.PI_OPUS_PACK_UNSAFE === "1";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (isBypassed()) return undefined;

		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			for (const rule of BASH_DENY) {
				if (rule.pattern.test(cmd)) {
					return { block: true, reason: `safe-deny: ${rule.reason}. Set PI_OPUS_PACK_UNSAFE=1 if intentional.` };
				}
			}
			return undefined;
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const rawPath = String((event.input as { path?: string; file_path?: string }).path
				?? (event.input as { file_path?: string }).file_path ?? "");
			if (!rawPath) return undefined;
			const abs = resolve(ctx.cwd, rawPath);
			for (const rule of PATH_DENY) {
				if (rule.matcher(abs)) {
					return { block: true, reason: `safe-deny: ${rule.reason}. Path: ${abs}` };
				}
			}
		}

		return undefined;
	});
}
