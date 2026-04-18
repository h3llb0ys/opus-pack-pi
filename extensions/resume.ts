/**
 * resume — session navigation: /resume, /fork, /tree.
 *
 * pi exposes session APIs via ExtensionCommandContext: switchSession,
 * fork, navigateTree. SessionManager.list gives the sessions under cwd.
 * This extension wraps those behind slash commands with interactive
 * pickers; provider-agnostic.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";

const fmtDate = (d: Date): string => {
	const now = Date.now();
	const diff = now - d.getTime();
	if (diff < 60_000) return "just now";
	if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h ago`;
	return d.toISOString().slice(0, 10);
};

const snippet = (text: string, max = 80): string => {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("resume", {
		description: "Switch to another session in the same cwd",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/resume requires interactive mode", "warning");
				return;
			}
			let sessions;
			try {
				sessions = await SessionManager.list(ctx.cwd);
			} catch (e) {
				ctx.ui.notify(`/resume failed: ${(e as Error).message}`, "error");
				return;
			}
			const currentFile = ctx.sessionManager.getSessionFile?.();
			const others = sessions.filter((s) => s.path !== currentFile);
			if (others.length === 0) {
				ctx.ui.notify("(no other sessions for this cwd)", "info");
				return;
			}
			others.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			const options = others.slice(0, 30).map((s) => {
				const name = s.name ?? s.id.slice(0, 8);
				const mod = fmtDate(s.modified);
				const first = snippet(s.firstMessage, 60);
				return `${name}  [${mod}, ${s.messageCount} msgs]  ${first}`;
			});
			options.push("❌ Cancel");
			const picked = await ctx.ui.select("Switch to session:", options);
			if (!picked || picked === "❌ Cancel") return;
			const idx = options.indexOf(picked);
			const target = others[idx];
			await ctx.switchSession(target.path);
		},
	});

	pi.registerCommand("fork", {
		description: "Fork the current session from a user message",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/fork requires interactive mode", "warning");
				return;
			}
			const entries = ctx.sessionManager.getEntries();
			// Pick user messages in reverse chronological order.
			const userMsgs = entries
				.filter((e): e is (typeof entries)[number] & { id: string; type: "message"; role?: string; content?: unknown; message?: { role?: string; content?: unknown } } => {
					if (e.type !== "message") return false;
					const m = e as unknown as { message?: { role?: string }; role?: string };
					return (m.message?.role ?? m.role) === "user";
				})
				.slice(-20)
				.reverse();
			if (userMsgs.length === 0) {
				ctx.ui.notify("(no user messages to fork from)", "info");
				return;
			}
			const options = userMsgs.map((e, i) => {
				const m = e as unknown as { message?: { content?: unknown }; content?: unknown; timestamp?: number };
				const content = m.message?.content ?? m.content ?? "";
				let text = "";
				if (typeof content === "string") text = content;
				else if (Array.isArray(content)) {
					text = content.filter((c) => c?.type === "text").map((c) => c.text ?? "").join(" ");
				}
				const ts = m.timestamp ? fmtDate(new Date(m.timestamp)) : `#${i + 1}`;
				return `[${ts}]  ${snippet(text, 100)}`;
			});
			options.push("❌ Cancel");
			const picked = await ctx.ui.select("Fork from which user message?", options);
			if (!picked || picked === "❌ Cancel") return;
			const idx = options.indexOf(picked);
			const target = userMsgs[idx];
			await ctx.fork((target as { id: string }).id);
		},
	});

	pi.registerCommand("tree", {
		description: "Show the current session's branch tree (ASCII)",
		handler: async (_args, ctx) => {
			const getTree = (ctx.sessionManager as { getTree?: () => unknown }).getTree;
			if (typeof getTree !== "function") {
				ctx.ui.notify("session tree API not available in this pi build", "warning");
				return;
			}
			try {
				const tree = getTree.call(ctx.sessionManager);
				renderAsciiTree(ctx, tree);
			} catch (e) {
				ctx.ui.notify(`/tree failed: ${(e as Error).message}`, "error");
			}
		},
	});
}

const renderAsciiTree = (ctx: ExtensionContext, tree: unknown) => {
	// Defensive: pi's tree shape may evolve. Try common shapes.
	const lines: string[] = ["═ session tree ═"];
	const leafId = (ctx.sessionManager as { getLeafId?: () => string }).getLeafId?.();
	const visit = (node: unknown, depth: number) => {
		if (!node || typeof node !== "object") return;
		const n = node as { id?: string; label?: string; children?: unknown[]; entry?: { id?: string } };
		const id = n.id ?? n.entry?.id ?? "?";
		const label = n.label ?? "";
		const marker = id === leafId ? "●" : "○";
		lines.push(`${"  ".repeat(depth)}${marker} ${id.slice(0, 8)} ${label}`);
		if (Array.isArray(n.children)) {
			for (const child of n.children) visit(child, depth + 1);
		}
	};
	if (Array.isArray(tree)) for (const n of tree) visit(n, 0);
	else visit(tree, 0);
	ctx.ui.notify(lines.join("\n"), "info");
};
