/**
 * /rewind — undo/rollback agent changes.
 *
 * Two modes:
 * 1. Last action: git checkout + clean to undo last turn's file changes
 * 2. Checkpoint picker: list git stash checkpoints from git-checkpoint.ts,
 *    or git log for recent commits, pick a point to restore to.
 *
 * Uses git stash list + git log to find rollback points.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("rewind")) return;
	pi.registerCommand("rewind", {
		description: "Undo/rollback agent changes: last action, checkpoint, or commit",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/rewind requires interactive mode.", "warning");
				return;
			}

			const gitCheck = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ctx.cwd });
			if (gitCheck.code !== 0) {
				ctx.ui.notify("Not a git repository.", "warning");
				return;
			}

			// Check current state
			const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
			const hasChanges = status.stdout.trim().length > 0;

			// Check if last commit was made by the agent (auto-commit-on-exit or manual)
			const lastCommitMsg = await pi.exec("git", ["log", "-1", "--format=%s"], { cwd: ctx.cwd });
			const lastCommitAuthor = await pi.exec("git", ["log", "-1", "--format=%an"], { cwd: ctx.cwd });

			const options: string[] = [];

			if (hasChanges) {
				options.push("Discard ALL uncommitted changes (git checkout + clean)");
				options.push("Stash uncommitted changes (git stash)");
			}

			// Last commit revert
			options.push(`Undo last commit: "${lastCommitMsg.stdout.trim().slice(0, 60)}" (soft reset)`);

			// Recent commits picker
			options.push("Pick from recent commits to reset to");

			// Stash list
			const stashList = await pi.exec("git", ["stash", "list"], { cwd: ctx.cwd });
			if (stashList.stdout.trim()) {
				options.push("Pick from stash entries");
			}

			options.push("Cancel");

			const choice = await ctx.ui.select("/rewind — choose action:", options);
			if (!choice || choice === "Cancel") return;

			if (choice.startsWith("Discard")) {
				const confirmed = await ctx.ui.confirm(
					"⚠ This will DESTROY all uncommitted changes!",
					"Files will be reverted to HEAD. This cannot be undone.",
				);
				if (!confirmed) { ctx.ui.notify("Cancelled.", "info"); return; }

				await pi.exec("git", ["checkout", "--", "."], { cwd: ctx.cwd });
				await pi.exec("git", ["clean", "-fd"], { cwd: ctx.cwd });
				ctx.ui.notify("✓ All uncommitted changes discarded.", "info");
				return;
			}

			if (choice.startsWith("Stash")) {
				await pi.exec("git", ["stash", "push", "-m", `rewind-stash-${Date.now()}`], { cwd: ctx.cwd });
				ctx.ui.notify("✓ Changes stashed. Use /diff to see stash or `git stash pop` to restore.", "info");
				return;
			}

			if (choice.startsWith("Undo last commit")) {
				const confirmed = await ctx.ui.confirm(
					"Soft reset last commit?",
					"Commit will be undone but files keep their changes (staged).",
				);
				if (!confirmed) { ctx.ui.notify("Cancelled.", "info"); return; }

				await pi.exec("git", ["reset", "--soft", "HEAD~1"], { cwd: ctx.cwd });
				ctx.ui.notify("✓ Last commit undone (soft reset). Changes are staged.", "info");
				return;
			}

			if (choice.startsWith("Pick from recent commits")) {
				const log = await pi.exec("git", [
					"log", "--oneline", "-20", "--format=%h %s",
				], { cwd: ctx.cwd });
				const commits = log.stdout.trim().split("\n").filter(Boolean);
				if (commits.length === 0) {
					ctx.ui.notify("No commits found.", "info");
					return;
				}

				const commitChoice = await ctx.ui.select("Reset to commit:", [...commits, "Cancel"]);
				if (!commitChoice || commitChoice === "Cancel") return;

				const hash = commitChoice.split(" ")[0];
				const mode = await ctx.ui.select("Reset mode:", [
					"Soft (keep changes staged)",
					"Mixed (keep changes unstaged)",
					"Hard (DISCARD all changes after this commit)",
					"Cancel",
				]);
				if (!mode || mode === "Cancel") return;

				const modeFlag = mode.startsWith("Soft") ? "--soft"
					: mode.startsWith("Mixed") ? "--mixed"
					: "--hard";

				if (modeFlag === "--hard") {
					const confirmed = await ctx.ui.confirm(
						"⚠ HARD RESET — all changes after this commit will be DESTROYED!",
						`Reset to ${commitChoice}`,
					);
					if (!confirmed) { ctx.ui.notify("Cancelled.", "info"); return; }
				}

				await pi.exec("git", ["reset", modeFlag, hash], { cwd: ctx.cwd });
				ctx.ui.notify(`✓ Reset to ${commitChoice}`, "info");
				return;
			}

			if (choice.startsWith("Pick from stash")) {
				const entries = stashList.stdout.trim().split("\n").filter(Boolean);
				const stashChoice = await ctx.ui.select("Apply stash:", [...entries, "Cancel"]);
				if (!stashChoice || stashChoice === "Cancel") return;

				const stashRef = stashChoice.split(":")[0];
				await pi.exec("git", ["stash", "apply", stashRef], { cwd: ctx.cwd });
				ctx.ui.notify(`✓ Applied ${stashRef}`, "info");
				return;
			}
		},
	});
}
