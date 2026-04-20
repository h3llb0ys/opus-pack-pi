/**
 * Shared observation state for cc-bridge sub-modules.
 *
 * Each sub-module writes into its slot when it loads or reloads so
 * /cc-bridge status can dump a consolidated view without re-scanning.
 */

export interface SkillsState {
	enabled: boolean;
	/** Absolute paths of discovered skill roots. */
	roots: string[];
}

export interface CommandsState {
	enabled: boolean;
	/** Registered command summaries. */
	entries: Array<{
		name: string;
		description: string;
		sourceFile: string;
	}>;
	collisions: string[];
	warnings: string[];
}

export interface ClaudeMdState {
	enabled: boolean;
	/** Absolute paths of files that were loaded (in injection order). */
	files: Array<{ path: string; bytes: number }>;
	totalChars: number;
	maxTotalChars: number;
}

export interface HooksState {
	enabled: boolean;
	/** Hooks discovered in settings.json (CC schema). */
	legacy: Array<{ event: string; matcher?: string; command: string; timeout: number; source: string }>;
	/** Hooks discovered as files under <vendor>/hooks/*.md. */
	fileBased: Array<{ event: string; matcher?: string; file: string; timeout: number; scope: "project" | "user" }>;
}

export interface CcBridgeState {
	skills: SkillsState;
	commands: CommandsState;
	claudeMd: ClaudeMdState;
	hooks: HooksState;
}

export const emptyState = (): CcBridgeState => ({
	skills: { enabled: false, roots: [] },
	commands: { enabled: false, entries: [], collisions: [], warnings: [] },
	claudeMd: { enabled: false, files: [], totalChars: 0, maxTotalChars: 0 },
	hooks: { enabled: false, legacy: [], fileBased: [] },
});
