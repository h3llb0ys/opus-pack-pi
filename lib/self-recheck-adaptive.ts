/**
 * Adaptive trigger for self-recheck.
 *
 * Complements the base model/length gates with cheap heuristics so a
 * recheck fires only on turns where it's actually likely to help:
 *   - cooldown: min N user-turns between auto-fires
 *   - skipIfAckOnly / skipIfFactualAsk: user's last message is a trivial
 *     acknowledgement or short factual question
 *   - requireToolUseOrCode: assistant produced tool calls or fenced code
 *   - requireStructureScore: assistant output has enough structural
 *     complexity (code blocks, long lists, tables, file paths)
 *
 * Pure heuristics — zero extra network calls. The optional classifier
 * layer lives separately in self-recheck-classifier.ts.
 */

import type { AdaptiveTriggerConfig } from "./self-recheck-state.js";
import { lastAssistantText, lastUserText, recheckState } from "./self-recheck-state.js";

// Safe regex compile. Bad patterns fall back to "match nothing" so a typo
// in settings can't accidentally block every turn.
const compileSafe = (pattern: string): RegExp | null => {
	if (!pattern) return null;
	try { return new RegExp(pattern, "iu"); } catch { return null; }
};

/**
 * Structural complexity score for an assistant message.
 *
 * Signals (each worth 1 point, max capped implicitly by the input):
 *   +1  fenced code block  ```...```
 *   +1  numbered or bulleted list with at least 3 items
 *   +1  markdown table (has header separator `|---|`)
 *   +1  file path reference (looks like `foo/bar.ts` or `./x/y`)
 *   +1  inline code span run (3+ backticked spans — signals heavy technical content)
 */
export function scoreStructure(text: string): number {
	if (!text) return 0;
	let score = 0;

	// Fenced code blocks — count opening fences.
	const fences = text.match(/^```/gm);
	if (fences && fences.length >= 2) score += 1;

	// Markdown table separator row.
	if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text)) score += 1;

	// Numbered list: at least 3 lines matching `N. ...`.
	const numbered = text.match(/^\s*\d+\.\s+\S/gm);
	if (numbered && numbered.length >= 3) score += 1;

	// Bulleted list: at least 3 lines matching `- ` or `* `.
	const bulleted = text.match(/^\s*[-*]\s+\S/gm);
	if (bulleted && bulleted.length >= 3) score += 1;

	// File path references — e.g. foo/bar.ts, src/a.rs, ./x.py.
	const paths = text.match(/(?:^|[\s`(])\.{0,2}\/?[\w.-]+\/[\w./-]+\.[a-z]{1,5}(?=\s|`|$|[),.])/gim);
	if (paths && paths.length >= 1) score += 1;

	// Many inline code spans.
	const inlineCode = text.match(/`[^`\n]{1,80}`/g);
	if (inlineCode && inlineCode.length >= 3) score += 1;

	return score;
}

/**
 * Does the current turn contain a real tool call or fenced code block?
 *
 * "Current turn" = every assistant / toolResult entry since the most
 * recent `user` message. A fixed look-back window (e.g. last 6 msgs) was
 * not enough: a tool-heavy turn followed by a long summary can easily
 * push the original tool calls beyond 6, and we'd miss the signal.
 */
export function hasToolUseOrCode(messages: any[]): boolean {
	// Walk back to the last user message; everything after it belongs to
	// the current turn.
	let turnStart = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === "user") { turnStart = i + 1; break; }
	}

	for (let i = turnStart; i < messages.length; i++) {
		const m = messages[i];
		if (!m) continue;
		if (m.role === "assistant") {
			const c = m.content;
			if (typeof c === "string" && /^```/m.test(c)) return true;
			if (Array.isArray(c)) {
				for (const part of c) {
					if (!part) continue;
					if (part.type === "toolCall" || part.type === "tool_use") return true;
					if (part.type === "text" && typeof part.text === "string" && /^```/m.test(part.text)) return true;
				}
			}
		}
		// toolResult entries also count as tool use for this purpose.
		if (m.role === "tool" || m.type === "toolResult") return true;
	}
	return false;
}

export interface AdaptiveDecision {
	fire: boolean;
	reason: string;
}

/**
 * Evaluate all adaptive gates against the current turn. Returns `{fire:
 * true}` only if every enabled gate allows firing. The decision reason is
 * returned so the calling code can write it to `lastDecision`.
 *
 * Does not mutate shared state (except via the caller's choice to update
 * `turnsSinceLastFire` after a fire).
 */
export function shouldFireAdaptive(
	event: { messages?: any[] },
	cfg: AdaptiveTriggerConfig,
	opts: { forced: boolean },
): AdaptiveDecision {
	if (!cfg.enabled) return { fire: true, reason: "adaptive disabled" };
	// /recheck now bypasses adaptive gates — user intent overrides heuristics.
	if (opts.forced) return { fire: true, reason: "forced (bypass adaptive)" };

	const messages = event.messages ?? [];
	const userText = lastUserText(messages);
	const assistantText = lastAssistantText(messages);

	const ack = compileSafe(cfg.skipIfAckOnly);
	if (ack && ack.test(userText)) return { fire: false, reason: "skip: user ack-only" };

	const factual = compileSafe(cfg.skipIfFactualAsk);
	if (factual && factual.test(userText)) return { fire: false, reason: "skip: user factual ask" };

	if (cfg.cooldownUserTurns > 0 && recheckState.turnsSinceLastFire < cfg.cooldownUserTurns) {
		return { fire: false, reason: `cooldown (${recheckState.turnsSinceLastFire}/${cfg.cooldownUserTurns})` };
	}

	if (cfg.requireToolUseOrCode && !hasToolUseOrCode(messages)) {
		return { fire: false, reason: "skip: no tool use or code" };
	}

	if (cfg.requireStructureScore > 0) {
		const score = scoreStructure(assistantText);
		if (score < cfg.requireStructureScore) {
			return { fire: false, reason: `skip: structure ${score}<${cfg.requireStructureScore}` };
		}
	}

	return { fire: true, reason: "adaptive pass" };
}
