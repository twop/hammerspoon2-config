// Zellij (terminal multiplexer) session/tab switcher for the leader menu.
// Port of zellij-menu.lua. v2 has no synchronous hs.execute -- every shell
// call here is a Promise via hs.task.shell()/.runAsync(), which is why
// every exported submenu builder below is async and leader-menu.ts's
// MenuAction["submenu"] had to grow a Promise-returning case to host them.

import * as KeyLabels from "./key-labels";
import { shellQuote } from "./termview";
import type { MenuItem } from "./leader-menu";

// hs.task.shell runs commands through a bare, non-login /bin/sh -- PATH is
// just the launchd default (/usr/bin:/bin:/usr/sbin:/sbin), so a plain
// "zellij" (living in ~/.cargo/bin) is unresolvable; worse, hs.task doesn't
// fail fast on a missing command the way a real shell would -- the
// returned promise never settles at all. termview.ts's runLoginShell() hit
// the same PATH gap and works around it by running through a login +
// interactive invocation of the user's own shell, which sources
// .zprofile/.zshrc first -- same fix applied here.
const SHELL = hs.appinfo.environment.SHELL ?? "/bin/zsh";

function loginShell(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return hs.task.shell(`${SHELL} -l -i -c ${shellQuote(cmd)}`, {});
}

async function runLines(cmd: string): Promise<string[]> {
	const { stdout } = await loginShell(cmd);
	return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

async function runJson<T>(cmd: string): Promise<T | null> {
	const { stdout } = await loginShell(cmd);
	try {
		return JSON.parse(stdout) as T;
	} catch {
		return null;
	}
}

interface SessionInfo {
	name: string;
	exited: boolean;
}

// Every session, live or EXITED (detached-with-no-server, resurrectable)
// -- `--short` lists both by name with no way to tell them apart, so the
// plain, unfiltered format is parsed instead (EXITED sessions are
// annotated "(EXITED - attach to resurrect)"). `--session <exited-name>
// action ...` just errors ("Session not found") against one, so switching
// to or listing tabs in an EXITED session requires reviving it first (see
// reviveSubmenu).
async function listSessions(): Promise<SessionInfo[]> {
	const lines = await runLines(`zellij list-sessions --no-formatting`);
	const sessions: SessionInfo[] = [];
	for (const line of lines) {
		const name = line.match(/^(\S+)/)?.[1];
		if (name) sessions.push({ name, exited: line.includes("EXITED") });
	}
	return sessions;
}

async function liveSessionNames(): Promise<string[]> {
	return (await listSessions()).filter((s) => !s.exited).map((s) => s.name);
}

// Tracked directly (updated by switchToSession below on every switch we
// perform) rather than re-detected live each time. zellij has a known bug
// (zellij-org/zellij#1301) where a session can keep reporting a client as
// still attached right after that client has switched away, which makes a
// live re-scan after every switch unreliable. Since we're always the one
// initiating the switch, we already know where the client ends up.
let currentSession: string | null = null;

// The session we were attached to right before the most recent switch --
// lets the "switch session" menu item behave like cmd+tab: toggling
// between the same two sessions re-switches directly to this one instead
// of opening a chooser. Cleared implicitly by going stale (checked against
// the live session list on every use) rather than on session exit, since
// there's no exit notification to hook.
let lastSession: string | null = null;

// Only used to bootstrap `currentSession` the first time (no switch
// performed by this menu yet since Hammerspoon last (re)started) -- no
// zellij command reports "the currently attached session" directly, so
// this scans every live session's `action list-clients` for one with an
// attached client. A data row starts with a numeric CLIENT_ID; the header
// row doesn't.
async function detectAttachedSession(): Promise<string | null> {
	for (const name of await liveSessionNames()) {
		const { exitCode, stdout } = await loginShell(
			`zellij --session ${shellQuote(name)} action list-clients`,
		);
		if (exitCode !== 0) continue;
		for (const line of stdout.split(/\r?\n/)) {
			if (/^\d/.test(line)) return name;
		}
	}
	return null;
}

export async function resolveCurrentSession(): Promise<string | null> {
	if (!currentSession) currentSession = await detectAttachedSession();
	if (!currentSession)
		hs.ui.alert("Zellij: no session currently attached").show();
	return currentSession;
}

// Bundle ID, not a path -- v2's launchOrFocus() takes bundle IDs only (see
// leader-menu-config.ts's APP_BUNDLE_IDS for the same adjustment applied
// to the rest of the menu's app launchers).
const ALACRITTY_BUNDLE_ID = "io.alacritty";

function focusAlacritty(): void {
	void hs.application.launchOrFocus(ALACRITTY_BUNDLE_ID);
}

// Shared by sessionsSubmenu and reviveSubmenu: redirects whatever's
// currently attached (if anything) to `name`, then brings the terminal
// forward. Needs an existing attached client to target -- `action
// switch-session` tells that client to switch, it isn't itself a new
// client attaching -- so there's nothing to run when none is attached.
async function switchToSession(name: string): Promise<void> {
	const current = await resolveCurrentSession();
	if (current) {
		await loginShell(
			`zellij --session ${shellQuote(current)} action switch-session ${shellQuote(name)}`,
		);
		lastSession = current;
	}
	currentSession = name;
	focusAlacritty();
}

// Caps a list at KeyLabels' single-char capacity so every item actually
// gets a key -- rather than generating multi-char labels for the
// overflow, extra sessions/tabs just aren't listed.
function capped<T>(list: T[]): T[] {
	return list.slice(0, KeyLabels.capacity());
}

// Chooser used when there's no usable lastSession to jump to directly --
// excludes the currently attached session since switching to it would be a
// no-op.
async function sessionsSubmenu(): Promise<MenuItem[]> {
	const current = await resolveCurrentSession();
	const names = capped(
		(await liveSessionNames()).filter((name) => name !== current),
	);
	const labels = KeyLabels.generate(names.length);
	return names.map((name, i) => ({
		key: labels[i]!,
		label: name,
		action: { kind: "callback", run: () => void switchToSession(name) },
	}));
}

// The "switch session" menu item itself, built fresh every time its parent
// submenu is opened: if lastSession is still live and isn't where we
// already are, jump straight there (cmd+tab-style toggle between two
// sessions, no picking required) -- otherwise fall back to the chooser.
// Deliberately reads the cached `currentSession` instead of going through
// resolveCurrentSession(): that function's "no session attached" alert is
// fine as a reaction to a deliberate pick (sessionsSubmenu, tabsSubmenu),
// but firing it just to decide how to label this item -- on every open of
// the Zellij category -- risks stealing focus and tripping the leader
// menu's own focus-steal watcher, closing the menu before it even renders.
async function switchSessionItem(): Promise<MenuItem> {
	const liveNames = await liveSessionNames();
	const direct =
		lastSession &&
		lastSession !== currentSession &&
		liveNames.includes(lastSession)
			? lastSession
			: null;

	if (direct) {
		return {
			key: "z",
			label: `Switch session → ${direct}`,
			action: { kind: "callback", run: () => void switchToSession(direct) },
		};
	}
	return {
		key: "z",
		label: "Switch session",
		action: { kind: "submenu", submenu: sessionsSubmenu },
	};
}

interface ZellijTab {
	name: string;
}

export async function tabsSubmenu(): Promise<MenuItem[]> {
	const current = await resolveCurrentSession();
	if (!current) return [];

	const tabs = capped(
		(await runJson<ZellijTab[]>(
			`zellij --session ${shellQuote(current)} action list-tabs --json`,
		)) ?? [],
	);
	const labels = KeyLabels.generate(tabs.length);
	return tabs.map((tab, i) => ({
		key: labels[i]!,
		label: tab.name,
		action: {
			kind: "callback",
			run: () => {
				void loginShell(
					`zellij --session ${shellQuote(current)} action go-to-tab-name ${shellQuote(tab.name)}`,
				).then(() => focusAlacritty());
			},
		},
	}));
}

export async function reviveSubmenu(): Promise<MenuItem[]> {
	const exited = capped(
		(await listSessions()).filter((s) => s.exited).map((s) => s.name),
	);
	const labels = KeyLabels.generate(exited.length);
	return exited.map((name, i) => ({
		key: labels[i]!,
		label: name,
		action: {
			kind: "callback",
			// Resurrects it as a live background session (no client attached
			// yet) -- succeeds without disturbing whatever's currently attached
			// elsewhere.
			run: () => {
				void loginShell(
					`zellij attach --create-background ${shellQuote(name)}`,
				).then(() => switchToSession(name));
			},
		},
	}));
}

export const node: MenuItem = {
	key: "z",
	label: "Zellij",
	action: {
		kind: "submenu",
		submenu: async () => [
			await switchSessionItem(),
			{
				key: "t",
				label: "Switch tab",
				action: { kind: "submenu", submenu: tabsSubmenu },
			},
			{
				key: "r",
				label: "Revive session",
				action: { kind: "submenu", submenu: reviveSubmenu },
			},
		],
	},
};
