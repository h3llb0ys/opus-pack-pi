/**
 * /diff — review agent changes.
 *
 * Shows `git diff HEAD --stat` overview, then interactive file picker
 * with full diff per file. Works with staged and unstaged changes.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("diff")) return;
	pi.registerCommand("diff", {
		description: "Review agent changes: file overview + interactive diff picker",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				// Non-interactive: just show stat
				const stat = await pi.exec("git", ["diff", "HEAD", "--stat"], { cwd: ctx.cwd });
				ctx.ui.notify(stat.stdout || "(no changes)", "info");
				return;
			}

			// Check if we're in a git repo
			const gitCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
			if (gitCheck.code !== 0) {
				ctx.ui.notify("Not a git repository.", "warning");
				return;
			}

			// Get stat overview
			const stat = await pi.exec("git", ["diff", "HEAD", "--stat"], { cwd: ctx.cwd });
			if (!stat.stdout.trim()) {
				// Maybe staged but not committed?
				const stagedStat = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd });
				if (!stagedStat.stdout.trim()) {
					ctx.ui.notify("No uncommitted changes.", "info");
					return;
				}
				ctx.ui.notify("Staged (not committed):\n" + stagedStat.stdout.trim(), "info");
				const viewStaged = await ctx.ui.confirm("View staged diffs?", "Select files to inspect");
				if (!viewStaged) return;

				const nameOnly = await pi.exec("git", ["diff", "--cached", "--name-only"], { cwd: ctx.cwd });
				const files = nameOnly.stdout.trim().split("\n").filter(Boolean);
				await pickAndShow(pi, ctx, files, "--cached");
				return;
			}

			ctx.ui.notify("Uncommitted changes:\n" + stat.stdout.trim(), "info");

			// Get file list
			const nameOnly = await pi.exec("git", ["diff", "HEAD", "--name-only"], { cwd: ctx.cwd });
			const files = nameOnly.stdout.trim().split("\n").filter(Boolean);
			if (files.length === 0) return;

			await pickAndShow(pi, ctx, files, "HEAD");
		},
	});
}

async function pickAndShow(pi: ExtensionAPI, ctx: ExtensionContext, files: string[], diffTarget: string) {
	// Add "all" and "done" options
	const options = [
		"📊 All files (combined)",
		...files,
		"❌ Done",
	];

	while (true) {
		const choice = await ctx.ui.select("Pick file to diff (or All):", options);
		if (!choice || choice === "❌ Done") return;

		if (choice === "📊 All files (combined)") {
			const diff = await pi.exec("git", ["diff", diffTarget], { cwd: ctx.cwd });
			const truncated = truncateHead(diff.stdout || "(empty diff)", {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			ctx.ui.notify(truncated.content, "info");
			continue;
		}

		// Single file diff
		const diff = await pi.exec("git", ["diff", diffTarget, "--", choice], { cwd: ctx.cwd });
		const truncated = truncateHead(diff.stdout || "(empty)", {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		ctx.ui.notify(`── ${choice} ──\n${truncated.content}`, "info");
	}
}
