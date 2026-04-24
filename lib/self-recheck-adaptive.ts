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
 * Each distinct signal contributes 1 point; counts accumulate across the
 * full set below. Broadened to cover Cyrillic / GLM-style markdown that
 * the original set (built for CC-style replies) missed.
 *
 * Signals:
 *   +1  fenced code block  ```…```  (≥1 complete block = ≥2 opening fences)
 *   +1  markdown heading   `^#{1,6} …`  (≥1, strong signal of structured prose)
 *   +1  markdown table     (has `|---|` separator row)
 *   +1  numbered list      `N. …` or `N) …`, at least 3 items
 *   +1  bulleted list      `- … | * … | • … | ● … | ▪ …`, at least 3 items
 *   +1  em-dash definition-list  `**word** — …`, at least 2 items
 *   +1  file path reference  (e.g. `foo/bar.ts`, `./x.py`), at least 1
 *   +1  inline code run    (≥3 backticked spans)
 */
export function scoreStructure(text: string): number {
	if (!text) return 0;
	let score = 0;

	// Fenced code blocks — count opening fences.
	const fences = text.match(/^```/gm);
	if (fences && fences.length >= 2) score += 1;

	// Markdown headings — any level, 1+ instance.
	if (/^#{1,6}\s+\S/m.test(text)) score += 1;

	// Markdown table separator row.
	if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(text)) score += 1;

	// Numbered list: `N.` or `N)`.
	const numbered = text.match(/^\s*\d+[.)]\s+\S/gm);
	if (numbered && numbered.length >= 3) score += 1;

	// Bulleted list: ASCII dash / asterisk or unicode bullet characters.
	const bulleted = text.match(/^\s*[-*•●▪–—]\s+\S/gm);
	if (bulleted && bulleted.length >= 3) score += 1;

	// Em-dash definition list: `**label** — …` / `**label** - …` (≥2 items).
	const defList = text.match(/^\s*\*\*[^*\n]{1,80}\*\*\s+[—–-]\s+\S/gm);
	if (defList && defList.length >= 2) score += 1;

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

	// Ack / factual-ask regexes and cooldown apply even to long answers —
	// a short follow-up like "ок, теперь то же для Y" is still user intent
	// to move on, not to second-guess the previous reply.
	const ack = compileSafe(cfg.skipIfAckOnly);
	if (ack && ack.test(userText)) return { fire: false, reason: "skip: user ack-only" };

	const factual = compileSafe(cfg.skipIfFactualAsk);
	if (factual && factual.test(userText)) return { fire: false, reason: "skip: user factual ask" };

	if (cfg.cooldownUserTurns > 0 && recheckState.turnsSinceLastFire < cfg.cooldownUserTurns) {
		return { fire: false, reason: `cooldown (${recheckState.turnsSinceLastFire}/${cfg.cooldownUserTurns})` };
	}

	// A very long prose answer is worth rechecking on its own merit, even
	// if it has no tool calls and few structural markers. This bypasses
	// both `requireToolUseOrCode` and `requireStructureScore` when the
	// assistant text exceeds `longAnswerBypass`. Set to 0 in settings to
	// disable the bypass and keep the strict gates active on any length.
	const longAnswer = cfg.longAnswerBypass > 0 && assistantText.length >= cfg.longAnswerBypass;

	if (!longAnswer && cfg.requireToolUseOrCode && !hasToolUseOrCode(messages)) {
		return { fire: false, reason: "skip: no tool use or code" };
	}

	if (!longAnswer && cfg.requireStructureScore > 0) {
		const score = scoreStructure(assistantText);
		if (score < cfg.requireStructureScore) {
			return { fire: false, reason: `skip: structure ${score}<${cfg.requireStructureScore}` };
		}
	}

	return {
		fire: true,
		reason: longAnswer
			? `adaptive pass (long-answer bypass, ${assistantText.length}c)`
			: "adaptive pass",
	};
}
