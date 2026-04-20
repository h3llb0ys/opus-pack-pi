/**
 * safe-deny — structured, non-interactive bash/fs guardrail.
 *
 * v2: argv-based tokenizer instead of whole-string regex. Splits the
 * command on pipes/chains (|, ||, &&, ;), tokenizes each segment with
 * respect for single/double quotes and backslash escapes, then checks
 * the *head* of each segment against a denylist keyed by command name.
 * This eliminates false-positives like `npm run rm-tmp` and `grep 'rm -rf' log`.
 *
 * Path protection (write/edit → .env, ~/.ssh, ~/.claude, *.pem, …) is unchanged.
 *
 * Bypass: env PI_OPUS_PACK_UNSAFE=1. Paranoid fallback when the tokenizer
 * fails to parse the command cleanly (subshells, heredocs, etc).
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled } from "../lib/settings.js";
import { extractPath } from "../lib/input-helpers.js";

const HOME = homedir();

// ── Tokenizer ───────────────────────────────────────────────────────────────

interface Segment {
	argv: string[];
	raw: string;
}

type TokenizeResult = { segments: Segment[]; dirty: false } | { segments: null; dirty: true; reason: string };

const CHAIN_OPS = ["||", "&&", ";", "|"];

const tokenizeCommand = (cmd: string): TokenizeResult => {
	// Refuse to parse confusing shell constructs — mark dirty → paranoid path.
	if (/\$\(|\`|<<-?\s*\w/.test(cmd)) {
		return { segments: null, dirty: true, reason: "subshell or heredoc" };
	}
	const segments: Segment[] = [];
	let buf = "";
	let i = 0;
	const len = cmd.length;
	const pushSegment = () => {
		const trimmed = buf.trim();
		if (trimmed) {
			const argv = splitArgv(trimmed);
			if (argv === null) {
				// Quote never closed.
				return false;
			}
			segments.push({ argv, raw: trimmed });
		}
		buf = "";
		return true;
	};
	outer: while (i < len) {
		const rest = cmd.slice(i);
		for (const op of CHAIN_OPS) {
			if (rest.startsWith(op)) {
				if (!pushSegment()) {
					return { segments: null, dirty: true, reason: "unclosed quote" };
				}
				i += op.length;
				continue outer;
			}
		}
		// Background & (not part of &&): also a chain separator.
		if (cmd[i] === "&" && cmd[i + 1] !== "&") {
			if (!pushSegment()) return { segments: null, dirty: true, reason: "unclosed quote" };
			i++;
			continue;
		}
		// Quotes — skip over without breaking on chain ops inside.
		if (cmd[i] === "'" || cmd[i] === '"') {
			const quote = cmd[i];
			buf += cmd[i++];
			while (i < len && cmd[i] !== quote) {
				if (cmd[i] === "\\" && i + 1 < len) buf += cmd[i++];
				buf += cmd[i++];
			}
			if (i >= len) return { segments: null, dirty: true, reason: "unclosed quote" };
			buf += cmd[i++]; // closing quote
			continue;
		}
		if (cmd[i] === "\\" && i + 1 < len) {
			buf += cmd[i++];
			buf += cmd[i++];
			continue;
		}
		buf += cmd[i++];
	}
	if (!pushSegment()) return { segments: null, dirty: true, reason: "unclosed quote" };
	return { segments, dirty: false };
};

const splitArgv = (seg: string): string[] | null => {
	const argv: string[] = [];
	let cur = "";
	let i = 0;
	let started = false;
	while (i < seg.length) {
		const c = seg[i];
		if (c === " " || c === "\t") {
			if (started) { argv.push(cur); cur = ""; started = false; }
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			started = true;
			const quote = c;
			i++;
			while (i < seg.length && seg[i] !== quote) {
				if (quote === '"' && seg[i] === "\\" && i + 1 < seg.length) { cur += seg[++i]; i++; continue; }
				cur += seg[i++];
			}
			if (i >= seg.length) return null; // unclosed
			i++; // closing
			continue;
		}
		if (c === "\\" && i + 1 < seg.length) {
			started = true;
			cur += seg[++i];
			i++;
			continue;
		}
		started = true;
		cur += c;
		i++;
	}
	if (started) argv.push(cur);
	return argv;
};

// ── Deny rules (structured) ─────────────────────────────────────────────────

interface DenyRule {
	/** Human reason. */
	reason: string;
	/** Checks a segment's argv. Returns true on match. */
	match: (argv: string[], raw: string) => boolean;
}

const has = (argv: string[], flag: string) => argv.some((a) => a === flag);

// Normalise a segment: strip a leading `sudo [flags]` so follow-up rules can
// match the real command. Bash argv rules still catch `sudo` as head if nothing
// else does, but this lets us block e.g. `sudo dd if=…` by the same dd rule
// that catches the unsudoed version.
const stripSudo = (argv: string[]): string[] => {
	if (argv[0] !== "sudo") return argv;
	let i = 1;
	while (i < argv.length && argv[i].startsWith("-")) i++;
	return argv.slice(i);
};

const DENY_RULES: DenyRule[] = [
	{
		reason: "rm -rf on / or ~",
		match: (argv) => {
			const a = stripSudo(argv);
			if (a[0] !== "rm") return false;
			const rf = a.some((x) => /^-[a-z]*r[a-z]*f|^-[a-z]*f[a-z]*r/i.test(x) || x === "--recursive" || x === "--force");
			if (!rf) return false;
			return a.some((x, i) => i > 0 && (x === "/" || x === "~" || x === "~/" || x === HOME || x === `${HOME}/`));
		},
	},
	{
		reason: "git push --force to main/master",
		match: (argv) => {
			if (argv[0] !== "git" || argv[1] !== "push") return false;
			if (!(has(argv, "--force") || has(argv, "-f"))) return false;
			return argv.some((a) => a === "main" || a === "master" || a === "origin/main" || a === "origin/master");
		},
	},
	{
		reason: "git commit --no-verify",
		match: (argv) => argv[0] === "git" && argv[1] === "commit" && has(argv, "--no-verify"),
	},
	{
		reason: "chmod -R 777 (world-writable recursively)",
		match: (argv) => {
			const a = stripSudo(argv);
			return a[0] === "chmod" && has(a, "-R") && has(a, "777");
		},
	},
	{
		reason: "chown -R (recursive ownership change is a common foot-gun)",
		match: (argv) => {
			const a = stripSudo(argv);
			return a[0] === "chown" && has(a, "-R");
		},
	},
	{
		// Block `dd if=…` regardless of `of=` — even reading from /dev/sd* into
		// a file is dangerous enough to pause for confirmation.
		reason: "dd (raw disk I/O — trivially nukes a drive)",
		match: (argv) => {
			const a = stripSudo(argv);
			return a[0] === "dd" && a.some((x) => x.startsWith("if=") || x.startsWith("of="));
		},
	},
	{
		reason: "mkfs (filesystem format)",
		match: (argv) => {
			const a = stripSudo(argv);
			return /^mkfs(\.|$)/.test(a[0] ?? "");
		},
	},
	{
		reason: "fork bomb",
		match: (_argv, raw) => /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/.test(raw),
	},
	{
		reason: "curl | sh (remote exec)",
		match: (_argv, raw) => /\bcurl\b[^|]*\|\s*(?:ba)?sh\b/.test(raw) || /\bwget\b[^|]*\|\s*(?:ba)?sh\b/.test(raw),
	},
];

// `reads` = block read/grep as well. For config dirs (~/.claude etc) reads
// are fine; only writes are dangerous. For raw credential material (.env,
// *.pem, ssh/aws/gcp secrets) treat reads as exfiltration risk — an agent
// grepping AWS_SECRET_ACCESS_KEY from .env pulls the secret straight into
// the prompt context.
interface PathDenyRule {
	matcher: (abs: string) => boolean;
	reason: string;
	/** Also block read-side tools (read, grep). Default: false (write-only). */
	reads?: boolean;
}

const PATH_DENY: PathDenyRule[] = [
	{ matcher: (p) => /(^|\/)\.env(\.|$)/.test(p), reason: ".env files protected", reads: true },
	{ matcher: (p) => /(^|\/)credentials(\.|$)/i.test(p), reason: "credentials files protected", reads: true },
	{ matcher: (p) => /\.pem$/i.test(p), reason: "*.pem files protected", reads: true },
	{ matcher: (p) => /\.key$/i.test(p), reason: "*.key files protected", reads: true },
	{ matcher: (p) => /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/.test(p), reason: "SSH private key protected", reads: true },
	{ matcher: (p) => /(^|\/)\.netrc$/.test(p), reason: "~/.netrc protected (plaintext credentials)", reads: true },
	{ matcher: (p) => p.includes(`${HOME}/.ssh/`), reason: "~/.ssh protected", reads: true },
	{ matcher: (p) => p.includes(`${HOME}/.aws/`), reason: "~/.aws protected (credentials)", reads: true },
	{ matcher: (p) => p.includes(`${HOME}/.config/gcloud/`), reason: "gcloud config protected (credentials)", reads: true },
	{ matcher: (p) => p.includes(`${HOME}/.kube/`), reason: "~/.kube protected (cluster creds)", reads: true },
	{ matcher: (p) => p.startsWith(`${HOME}/.openai/`) || p === `${HOME}/.openai`, reason: "~/.openai protected (credentials)", reads: true },
	{ matcher: (p) => p.startsWith(`${HOME}/.anthropic/`) || p === `${HOME}/.anthropic`, reason: "~/.anthropic protected (credentials)", reads: true },
	// Config dirs — write-only protection; read is fine and often needed.
	{ matcher: (p) => p.startsWith(`${HOME}/.claude/`) || p === `${HOME}/.claude`, reason: "~/.claude protected (CLI agent config)" },
	{ matcher: (p) => p.startsWith(`${HOME}/.codex/`) || p === `${HOME}/.codex`, reason: "~/.codex protected (CLI agent config)" },
	{ matcher: (p) => p.startsWith(`${HOME}/.gemini/`) || p === `${HOME}/.gemini`, reason: "~/.gemini protected (CLI agent config)" },
	{ matcher: (p) => p === `${HOME}/.pi/agent/SYSTEM.md`, reason: "~/.pi/agent/SYSTEM.md protected (would clobber pi base prompt)" },
];

const isBypassed = () => process.env.PI_OPUS_PACK_UNSAFE === "1";

// ── Entry point ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("safe-deny")) return;
	pi.on("tool_call", (event, ctx) => {
		if (isBypassed()) return undefined;

		if (event.toolName === "bash") {
			const cmd = String((event.input as { command?: string }).command ?? "");
			const result = tokenizeCommand(cmd);
			if (result.dirty) {
				// Paranoid path: we couldn't parse cleanly. Fall back to the
				// two most dangerous whole-string regexes to avoid blocking
				// innocent but exotic commands like `$(< file)`.
				const paranoid = [
					{ re: /\brm\s+-[rf]*[rf][rf]*\s+\/(\s|$)/i, reason: "rm -rf / (paranoid match)" },
					{ re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: "fork bomb" },
					{ re: /\bcurl\b[^|]*\|\s*(?:ba)?sh\b/, reason: "curl | sh" },
				];
				for (const p of paranoid) {
					if (p.re.test(cmd)) {
						return { block: true, reason: `safe-deny: ${p.reason}. Tokenizer couldn't parse cleanly (${result.reason}). Set PI_OPUS_PACK_UNSAFE=1 if intentional.` };
					}
				}
				return undefined;
			}
			for (const seg of result.segments) {
				for (const rule of DENY_RULES) {
					if (rule.match(seg.argv, seg.raw)) {
						return { block: true, reason: `safe-deny: ${rule.reason}. Segment: \`${seg.raw}\`. Set PI_OPUS_PACK_UNSAFE=1 if intentional.` };
					}
				}
			}
			return undefined;
		}

		const isWrite = event.toolName === "write" || event.toolName === "edit";
		const isRead = event.toolName === "read" || event.toolName === "grep";
		if (isWrite || isRead) {
			const rawPath = extractPath(event.input);
			if (!rawPath) return undefined;
			const abs = resolve(ctx.cwd, rawPath);
			for (const rule of PATH_DENY) {
				if (!rule.matcher(abs)) continue;
				if (isRead && !rule.reads) continue; // read on write-only-protected path is fine
				const op = isWrite ? "write" : "read";
				return { block: true, reason: `safe-deny: ${rule.reason} (blocked ${op}). Path: ${abs}` };
			}
		}

		return undefined;
	});
}
