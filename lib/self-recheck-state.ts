/**
 * Shared mutable state + pure predicate for the self-recheck extension.
 *
 * Lives outside extensions/self-recheck.ts so other extensions (notably
 * plan-mode) can peek at whether a self-recheck is about to fire or is
 * currently in progress, without reaching into a closure.
 */

import { minimatch } from "minimatch";

export type RecheckStage = "none" | "defects" | "corrected";

export interface SelfRecheckConfig {
	enabled: boolean;
	models: string[];
	prompt: string;           // legacy single-stage prompt; empty => use two-stage
	defectsPrompt: string;    // stage 1
	correctedPrompt: string;  // stage 2
	minAssistantChars: number;
	maxPerSession: number;
	twoStage: boolean;
}

export const recheckState = {
	pausedByUser: false,
	inRecheckTurn: false,
	stage: "none" as RecheckStage,
	forceNext: false,
	skipNext: false,
	countThisSession: 0,
	lastDecision: "",
};

export function resetRecheckState(): void {
	recheckState.pausedByUser = false;
	recheckState.inRecheckTurn = false;
	recheckState.stage = "none";
	recheckState.forceNext = false;
	recheckState.skipNext = false;
	recheckState.countThisSession = 0;
	recheckState.lastDecision = "";
}

export function matchesAny(modelId: string, globs: string[]): boolean {
	return globs.some((g) => {
		try { return minimatch(modelId, g, { nocase: true }); } catch { return false; }
	});
}

export function lastAssistantTextLength(messages: any[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content.length;
		if (Array.isArray(content)) {
			let n = 0;
			for (const part of content) {
				if (part && part.type === "text" && typeof part.text === "string") n += part.text.length;
			}
			return n;
		}
		return 0;
	}
	return 0;
}

export function lastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			let out = "";
			for (const part of content) {
				if (part && part.type === "text" && typeof part.text === "string") out += part.text;
			}
			return out;
		}
		return "";
	}
	return "";
}

/**
 * Pure prediction: would self-recheck fire on this agent_end if asked?
 * Safe to call from any extension; does NOT mutate state.
 *
 * Returns true only when the recheck extension would inject a new follow-up
 * on the current turn — i.e. not while a recheck is already in progress.
 */
export function willRecheckFire(
	event: { messages?: any[] },
	ctx: { model?: { id?: string } },
	cfg: SelfRecheckConfig,
): boolean {
	if (recheckState.inRecheckTurn) return false;
	if (recheckState.stage !== "none") return false;
	if (recheckState.pausedByUser) return false;
	if (recheckState.skipNext) return false;
	if (!recheckState.forceNext && !cfg.enabled) return false;
	if (!recheckState.forceNext && cfg.maxPerSession > 0 && recheckState.countThisSession >= cfg.maxPerSession) {
		return false;
	}
	const modelId = ctx.model?.id ?? "";
	const matched = recheckState.forceNext || (modelId !== "" && matchesAny(modelId, cfg.models));
	if (!matched) return false;
	const textLen = lastAssistantTextLength(event.messages ?? []);
	if (!recheckState.forceNext && textLen < cfg.minAssistantChars) return false;
	return true;
}

/** True if a recheck is mid-flight (either stage awaiting model reply). */
export function isRecheckInProgress(): boolean {
	return recheckState.inRecheckTurn || recheckState.stage !== "none";
}
