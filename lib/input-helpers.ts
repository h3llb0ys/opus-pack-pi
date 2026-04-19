/**
 * Shared helpers for parsing tool-call inputs and tool-result content.
 *
 * Multiple extensions need the same shapes:
 *   - Pull `path` / `file_path` out of an edit/write/read tool input.
 *   - Extract text from the Array<{type,text}> content shape that pi
 *     streams back on tool_result / tool_execution_update events.
 * Centralizing here avoids N near-copies each with their own unknown guards.
 */

interface TextPart {
	type?: string;
	text?: string;
}

/**
 * Pull a file path out of a tool input object. Accepts both `path` and the
 * Claude-Code-style `file_path`. Returns "" when neither is present or the
 * input isn't an object (caller decides whether empty is an error).
 */
export const extractPath = (input: unknown): string => {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	return String(obj.path ?? obj.file_path ?? "");
};

/**
 * Join all text parts from a content array (typical tool_result shape).
 * Non-text parts and malformed entries are skipped.
 */
export const joinTextParts = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is TextPart => !!c && typeof c === "object" && (c as TextPart).type === "text" && typeof (c as TextPart).text === "string")
		.map((c) => c.text as string)
		.join("");
};

/**
 * Extract text from a streaming partial (e.g. ToolExecutionUpdateEvent.partialResult).
 * The partial wraps `content` the same way a final tool_result does.
 */
export const extractStreamText = (partial: unknown): string => {
	if (!partial || typeof partial !== "object") return "";
	const result = partial as { content?: unknown };
	return joinTextParts(result.content);
};

/**
 * First non-empty line from a free-text blob, trimmed to `maxChars`.
 * Common pattern for building snippets for logs/previews.
 */
export const firstNonEmptyLine = (text: string, maxChars: number): string => {
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
	return line.trim().slice(0, maxChars);
};

/**
 * First non-empty text line pulled from a content array. Useful for "show me
 * the first meaningful line from a failed bash result" style snippets.
 */
export const firstLineFromContent = (content: unknown, maxChars: number): string => {
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as TextPart;
		if (p.type !== "text" || typeof p.text !== "string" || !p.text) continue;
		const snippet = firstNonEmptyLine(p.text, maxChars);
		if (snippet) return snippet;
	}
	return "";
};

/** Parse JSON safely. Returns null on any failure. */
export const safeJsonParse = <T = unknown>(raw: string): T | null => {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
};
