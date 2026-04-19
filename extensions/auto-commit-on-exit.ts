/**
 * Auto-Commit on Exit Extension
 *
 * Automatically commits changes when the agent exits.
 * Commit message is built from actual tool activity (edited/written files)
 * rather than the LLM's prose — produces meaningful history without
 * polluting git log with conversational noise.
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

interface Activity {
	editFiles: Set<string>;
	writeFiles: Set<string>;
	bashCommands: string[];
}

const collectActivity = (entries: Array<any>): Activity => {
	const act: Activity = { editFiles: new Set(), writeFiles: new Set(), bashCommands: [] };
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "toolCall") {
					const tc = part as { name?: string; arguments?: Record<string, unknown> };
					if (tc.name === "edit" && tc.arguments?.path) {
						act.editFiles.add(String(tc.arguments.path));
					} else if (tc.name === "write" && tc.arguments?.path) {
						act.writeFiles.add(String(tc.arguments.path));
					} else if (tc.name === "bash" && tc.arguments?.command) {
						act.bashCommands.push(String(tc.arguments.command));
					}
				}
			}
		}
	}
	return act;
};

const short = (p: string): string => basename(p);

const buildCommitMessage = (act: Activity): string => {
	const allChanged = [...new Set([...act.editFiles, ...act.writeFiles])];
	const parts: string[] = [];

	if (allChanged.length === 0 && act.bashCommands.length === 0) {
		return "chore: pi session changes";
	}

	if (allChanged.length > 0) {
		const names = allChanged.slice(0, 5).map(short).join(", ");
		const suffix = allChanged.length > 5 ? ` +${allChanged.length - 5} more` : "";
		parts.push(`update ${names}${suffix}`);
	}

	// Detect common bash patterns for a better summary.
	for (const cmd of act.bashCommands.slice(0, 3)) {
		const tokens = cmd.trim().split(/\s+/);
		const base = tokens[0] ?? "";
		if (base === "go" && tokens[1] === "test") parts.push("run tests");
		else if (base === "npm" && tokens[1] === "test") parts.push("run tests");
		else if (base === "cargo" && tokens[1] === "test") parts.push("run tests");
		else if (base === "make") parts.push(`make ${tokens[1] ?? ""}`);
		else if (base === "go" && tokens[1] === "build") parts.push("go build");
		else if (base === "npm" && tokens[1] === "run") parts.push(`npm run ${tokens[2] ?? ""}`);
	}

	// Deduplicate and cap.
	const unique = [...new Set(parts)].slice(0, 3);
	const subject = unique.join(", ") || "chore: pi session changes";

	return subject.length > 72 ? subject.slice(0, 69) + "..." : subject;
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("auto-commit-on-exit")) return;
	pi.on("session_shutdown", async (_event, ctx) => {
		// Check for uncommitted changes
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);

		if (code !== 0 || status.trim().length === 0) return;

		const entries = ctx.sessionManager.getEntries();
		const act = collectActivity(entries);
		const commitMessage = buildCommitMessage(act);

		// Stage and commit
		await pi.exec("git", ["add", "-A"]);
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);

		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
		}
	});
}
