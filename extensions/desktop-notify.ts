/**
 * Desktop Notify — OS notification when agent finishes.
 *
 * macOS: osascript -e 'display notification ...'
 * Linux: notify-send (if available)
 *
 * Config in settings.json: opus-pack.desktopNotify
 *   { "enabled": true, "minDuration": 30, "sound": true }
 *
 * minDuration: only notify if agent ran for at least N seconds (default: 10).
 * sound: play system sound on macOS (default: true).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isExtensionDisabled, loadOpusPackSection } from "../lib/settings.js";

const execFileAsync = promisify(execFile);

interface NotifyConfig {
	enabled: boolean;
	minDuration: number;
	sound: boolean;
}

const DEFAULT_CONFIG: NotifyConfig = { enabled: true, minDuration: 10, sound: true };

const loadConfig = (): NotifyConfig => loadOpusPackSection("desktopNotify", DEFAULT_CONFIG);

const isMac = process.platform === "darwin";

const notifyMac = async (title: string, body: string, sound: boolean): Promise<void> => {
	const soundClause = sound ? ' sound name "Submarine"' : "";
	const escapedBody = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const script = `display notification "${escapedBody}" with title "${escapedTitle}"${soundClause}`;
	try {
		await execFileAsync("osascript", ["-e", script], { timeout: 5000 });
	} catch { /* osascript may fail in non-GUI contexts */ }
};

const notifyLinux = async (title: string, body: string): Promise<void> => {
	try {
		await execFileAsync("notify-send", [title, body], { timeout: 5000 });
	} catch { /* notify-send may not be installed */ }
};

export default function (pi: ExtensionAPI) {
	if (isExtensionDisabled("desktop-notify")) return;
	let agentStartTime = 0;
	const config = loadConfig();

	if (!config.enabled) return;

	pi.on("agent_start", async () => {
		agentStartTime = Date.now();
	});

	pi.on("agent_end", async (_event, ctx) => {
		const elapsed = (Date.now() - agentStartTime) / 1000;
		if (elapsed < config.minDuration) return;

		const cwd = ctx.cwd.split("/").pop() ?? "project";
		const title = "pi — task complete";
		const body = `${cwd} (${Math.round(elapsed)}s)`;

		if (isMac) {
			await notifyMac(title, body, config.sound);
		} else {
			await notifyLinux(title, body);
		}
	});

	pi.registerCommand("notify-test", {
		description: "Test desktop notification",
		handler: async (_args, ctx) => {
			if (isMac) {
				await notifyMac("pi test", "Notification works!", config.sound);
			} else {
				await notifyLinux("pi test", "Notification works!");
			}
			ctx.ui.notify("Notification sent.", "info");
		},
	});
}
