/**
 * /init — interactive project initialization wizard.
 *
 * Asks about build/test/lint commands, conventions, key paths.
 * Writes AGENTS.md (or .pi/AGENTS.md) with the collected info.
 */

import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Initialize AGENTS.md for this project (interactive wizard)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/init requires interactive mode.", "warning");
				return;
			}

			// Check if AGENTS.md already exists
			const agentsPath = join(ctx.cwd, "AGENTS.md");
			const piAgentsPath = join(ctx.cwd, ".pi", "AGENTS.md");
			const existingPath = existsSync(agentsPath) ? agentsPath
				: existsSync(piAgentsPath) ? piAgentsPath
				: null;

			if (existingPath) {
				const overwrite = await ctx.ui.confirm(
					"AGENTS.md already exists",
					`Found: ${existingPath}\nOverwrite?`,
				);
				if (!overwrite) {
					ctx.ui.notify("Cancelled.", "info");
					return;
				}
			}

			const projectName = ctx.cwd.split("/").pop() ?? "project";

			// Collect info
			const language = await ctx.ui.select("Primary language:", [
				"TypeScript", "Python", "Go", "Rust", "Java", "Ruby", "Other",
			]);

			const buildCmd = await ctx.ui.input("Build command:", "make build");
			const testCmd = await ctx.ui.input("Test command:", "make test");
			const lintCmd = await ctx.ui.input("Lint command:", "make lint");

			const conventions = await ctx.ui.input("Key conventions (comma-separated):",
				"granular commits, edit > write, no comments unless WHY",
			);

			const archNotes = await ctx.ui.input("Architecture notes (optional):", "");
			const keyPaths = await ctx.ui.input("Key paths (comma-separated, optional):", "");

			// Generate AGENTS.md
			const langSection = language === "Other" ? "" : language;
			const lines: string[] = [
				`# ${projectName}`,
				"",
				`## Stack`,
				`- Language: ${langSection}`,
				`- Build: \`${buildCmd}\``,
				`- Test: \`${testCmd}\``,
				`- Lint: \`${lintCmd}\``,
			];

			if (conventions) {
				lines.push("");
				lines.push("## Conventions");
				for (const conv of conventions.split(",").map((s) => s.trim()).filter(Boolean)) {
					lines.push(`- ${conv}`);
				}
			}

			if (keyPaths) {
				lines.push("");
				lines.push("## Key Paths");
				for (const p of keyPaths.split(",").map((s) => s.trim()).filter(Boolean)) {
					lines.push(`- \`${p}\``);
				}
			}

			if (archNotes) {
				lines.push("");
				lines.push("## Architecture");
				lines.push(archNotes);
			}

			const content = lines.join("\n") + "\n";

			// Write to AGENTS.md in project root
			writeFileSync(agentsPath, content, "utf8");
			ctx.ui.notify(`Created ${agentsPath}`, "info");
		},
	});
}
