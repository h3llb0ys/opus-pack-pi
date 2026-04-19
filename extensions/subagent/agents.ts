/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "bundled";
	filePath: string;
}

/**
 * Roots shipped inside the opus-pack-pi repo:
 *   <repo>/agents/                          — top-level profiles
 *   <repo>/extensions/subagent/agents/      — subagent-pack profiles
 *
 * We locate them relative to this file (agents.ts lives in
 * extensions/subagent/) so they work regardless of whether the pack was
 * installed via `pi install <local>` or `pi install git:...`.
 */
const getBundledAgentDirs = (): string[] => {
	try {
		const hereFile = fileURLToPath(import.meta.url);
		const subagentDir = path.dirname(hereFile);
		const repoRoot = path.resolve(subagentDir, "..", "..");
		return [
			path.join(subagentDir, "agents"),
			path.join(repoRoot, "agents"),
		];
	} catch {
		return [];
	}
};

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "bundled"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Bundled agents ship inside the pack repo. They are always available
	// regardless of `scope` so the model has something to delegate to right
	// after install — no manual copy to ~/.pi/agent/agents required.
	const bundledAgents: AgentConfig[] = [];
	for (const dir of getBundledAgentDirs()) {
		bundledAgents.push(...loadAgentsFromDir(dir, "bundled"));
	}

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	// Priority (later wins): bundled -> user -> project. That way a user's
	// ~/.pi/agent/agents/explore.md overrides the bundled explore.md, and a
	// project-local file overrides both when scope allows.
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	if (scope === "user" || scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	}
	if (scope === "project" || scope === "both") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
