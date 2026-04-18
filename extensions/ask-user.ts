/**
 * ask-user — LLM-callable tool that asks the user a question.
 *
 * CC-style AskUserQuestion analogue. Use sparingly — only when
 * requirements are genuinely ambiguous. In non-interactive modes
 * (print, RPC) the tool returns an error so the model can fall back
 * to its own judgement.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("ask-user")) return;
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user a clarifying question. Use sparingly — only when requirements " +
			"are genuinely ambiguous and you cannot proceed without the answer. " +
			"Do NOT use for confirmation of decided plans or minor style preferences.",
		promptSnippet: "ask_user(question, choices?) — clarify genuinely ambiguous requirements",
		promptGuidelines: [
			"Only call ask_user when you cannot make a reasonable assumption.",
			"Prefer choices[] with 2-4 concrete options over free-form questions.",
			"If the tool returns an error, proceed with your best judgement and note the assumption.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to show the user. Keep it short and concrete." }),
			choices: Type.Optional(Type.Array(Type.Object({
				label: Type.String({ description: "Short label shown in the picker." }),
				description: Type.Optional(Type.String({ description: "One-line elaboration shown next to the label." })),
			}), { description: "Optional multiple-choice options. Omit to request a free-form text answer." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000, description: "Max wait in ms (default 5 minutes)." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<{ answer: string; source: "choice" | "text" | "none" }>> {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "ask_user unavailable: pi is running non-interactively. Proceed with your best judgement." }],
					isError: true,
					details: { answer: "", source: "none" },
				};
			}
			const timeout = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			try {
				if (params.choices && params.choices.length > 0) {
					const labels = params.choices.map((c) => c.description ? `${c.label} — ${c.description}` : c.label);
					const picked = await ctx.ui.select(params.question, labels, { signal, timeout });
					if (picked === undefined) {
						return {
							content: [{ type: "text", text: "ask_user: user dismissed or timed out. Proceed with your best judgement." }],
							isError: true,
							details: { answer: "", source: "none" },
						};
					}
					const idx = labels.indexOf(picked);
					const answer = idx >= 0 ? params.choices[idx].label : picked;
					return {
						content: [{ type: "text", text: `user picked: ${answer}` }],
						isError: false,
						details: { answer, source: "choice" },
					};
				}
				const typed = await ctx.ui.input(params.question, "", { signal, timeout });
				if (!typed) {
					return {
						content: [{ type: "text", text: "ask_user: user dismissed or empty reply. Proceed with your best judgement." }],
						isError: true,
						details: { answer: "", source: "none" },
					};
				}
				return {
					content: [{ type: "text", text: `user replied: ${typed}` }],
					isError: false,
					details: { answer: typed, source: "text" },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `ask_user failed: ${(e as Error).message}` }],
					isError: true,
					details: { answer: "", source: "none" },
				};
			}
		},
	});
}
