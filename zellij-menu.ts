// Zellij (terminal multiplexer) session/tab switcher for the leader menu.
// Backed by the headless zj_hs_jump zellij plugin (loaded via
// ~/.config/zellij/config.kdl's load_plugins): one `zellij pipe --name
// state` call to any live session returns every session's tabs, attached
// clients and resurrectable sessions as JSON, and `focus`/`session` pipes do
// the switching. v2 has no synchronous hs.execute -- every shell call here is
// a Promise via hs.task.shell(), which is why the menu below is a
// PrefetchSubmenu over one async state fetch.

import * as KeyLabels from "./key-labels";
// Every zellij call goes through a login shell, since zellij lives in
// ~/.cargo/bin -- see shell.ts.
import { loginShell, shellQuote } from "./shell";
import {
	focusApp,
	Callback,
	Chooser,
	PrefetchSubmenu,
	Submenu,
	type MenuItem,
} from "./leader-menu";
import { textInput, type ChooserSpec } from "./chooser-runtime";
import { menuTree } from "./leader-menu-config";

interface ZjTab {
	position: number;
	name: string;
	active: boolean;
}

interface ZjSession {
	name: string;
	clients: number;
	active_tab: number | null;
	tabs: ZjTab[];
	tab_history: number[];
}

interface ZjState {
	ready: boolean;
	served_by: string;
	attached: string[];
	sessions: ZjSession[];
	resurrectable: string[];
}

interface ZjReply {
	ok: boolean;
	error?: string;
}

// Always sends a payload and redirects stdin from /dev/null: `zellij pipe`
// otherwise reads the message from stdin and keeps waiting on it even after
// the plugin replies -- hs.task leaves stdin open, so the CLI (and this
// promise) would never finish. Parsing starts at the first "{" so anything
// the interactive shell prints first can't break JSON.parse.
async function pipe<T>(
	session: string,
	name: string,
	payload: object = {},
): Promise<T | null> {
	const { exitCode, stdout } = await loginShell(
		`zellij --session ${shellQuote(session)} pipe --plugin zj_hs_jump --name ${name} -- ${shellQuote(JSON.stringify(payload))} </dev/null`,
	);
	const start = stdout.indexOf("{");
	if (exitCode !== 0 || start < 0) return null;
	try {
		return JSON.parse(stdout.slice(start)) as T;
	} catch {
		return null;
	}
}

// The last session that answered a `state` pipe -- any live session can
// answer for all of them, so it's reused until a pipe to it fails, and only
// then is `zellij ls` re-run to find another.
let serverSession: string | null = null;

async function liveSessionNames(): Promise<string[]> {
	const { stdout } = await loginShell("zellij list-sessions --no-formatting");
	return stdout
		.split(/\r?\n/)
		.filter((line) => line.length > 0 && !line.includes("EXITED"))
		.map((line) => line.match(/^(\S+)/)?.[1])
		.filter((name): name is string => !!name);
}

async function stateFrom(session: string): Promise<ZjState | null> {
	const state = await pipe<ZjState>(session, "state");
	if (!state?.ready) return null;
	serverSession = session;
	return state;
}

async function fetchState(): Promise<ZjState | null> {
	const cached = serverSession;
	if (cached) {
		const state = await stateFrom(cached);
		if (state) return state;
	}
	serverSession = null;
	for (const session of await liveSessionNames()) {
		if (session === cached) continue;
		const state = await stateFrom(session);
		if (state) return state;
	}
	return null;
}

// Bundle ID, not a path -- v2's launchOrFocus() takes bundle IDs only (see
// leader-menu-config.ts's APP_BUNDLE_IDS for the same adjustment applied
// to the rest of the menu's app launchers).
const ALACRITTY_BUNDLE_ID = "org.alacritty";

function focusAlacritty(): void {
	void focusApp(ALACRITTY_BUNDLE_ID);
}

function reportFailure(reply: ZjReply | null): boolean {
	if (reply?.ok) return false;
	hs.ui.alert(`Zellij: ${reply?.error ?? "no reply from zj_hs_jump"}`).show();
	return true;
}

// Sends `focus`/`session` to the attached session (the one with a client to
// switch), then brings the terminal forward. `current` comes from the
// menu's prefetched state snapshot (state.attached[0]) rather than a fresh
// fetch here -- that would cost a whole extra login-shell + pipe round trip
// on every pick.
async function sendToAttached(
	current: string | undefined,
	name: "focus" | "session",
	payload: object,
): Promise<void> {
	if (!current) {
		hs.ui.alert("Zellij: no session currently attached").show();
		return;
	}
	if (reportFailure(await pipe<ZjReply>(current, name, payload))) return;
	focusAlacritty();
}

function switchToSession(
	current: string | undefined,
	name: string,
): Promise<void> {
	return sendToAttached(current, "session", { name });
}

function focusTab(
	current: string | undefined,
	session: string,
	tab: number,
): Promise<void> {
	return sendToAttached(current, "focus", { session, tab });
}

// Brings `name` up as a live background session -- resurrecting it if it's
// EXITED, creating it if it doesn't exist at all (no client attached yet,
// so nothing currently attached is disturbed) -- then switches to it. An
// already-live name is a no-op attach followed by a plain switch.
async function startSession(
	current: string | undefined,
	name: string,
): Promise<void> {
	await loginShell(`zellij attach --create-background ${shellQuote(name)}`);
	await switchToSession(current, name);
}

// Stops a live session; zellij keeps it resurrectable, so it shows up
// under "Revive session" afterwards. </dev/null for the same reason as
// pipe(): the CLI must not sit waiting on hs.task's open stdin.
async function killSession(name: string): Promise<void> {
	const { exitCode, stderr } = await loginShell(
		`zellij kill-session ${shellQuote(name)} </dev/null`,
	);
	const message =
		exitCode === 0
			? `Zellij: killed ${name}`
			: `Zellij: kill failed: ${stderr.trim() || `exit ${exitCode}`}`;
	hs.ui.alert(message).show();
}

function newSessionSpec(current: string | undefined): ChooserSpec<{ text: string }> {
	return textInput({
		placeholder: "New session name…",
		preview: (query) =>
			query.trim()
				? `Create session: ${query.trim()}`
				: "Type a name, then press ⏎",
		submitLabel: "Create session",
		// Deferred past the chooser's own hide, same as jumpSpec's onSelect.
		onSubmit: (name) =>
			hs.timer.doAfter(0, () => void startSession(current, name)),
	});
}

// Caps a list at KeyLabels' single-char capacity so every item actually
// gets a key -- rather than generating multi-char labels for the
// overflow, extra sessions/tabs just aren't listed.
function capped<T>(
	list: T[],
	pool: readonly string[] = KeyLabels.SINGLE_CHARS,
): T[] {
	return list.slice(0, KeyLabels.capacity(pool));
}

// The menu's one data fetch (see node below). Unreachable is an error, not
// an empty state, so it shows as the submenu's error row.
async function requireState(): Promise<ZjState> {
	const state = await fetchState();
	if (!state) throw new Error("zj_hs_jump not reachable");
	return state;
}

function sessionItems(state: ZjState): MenuItem[] {
	const current = state.attached[0];
	const labels = KeyLabels.generate(
		state.sessions.length,
		KeyLabels.NUMBER_CHARS,
	);
	return state.sessions.map((session, i) => ({
		key: labels[i]!,
		label: session.name,
		action: Callback(() => void switchToSession(current, session.name)),
	}));
}

// Same numbering as sessionItems, so a session has one key under both "s"
// and "k". The attached one is listed too, marked, since killing it closes
// the current client.
function killItems(state: ZjState): MenuItem[] {
	const current = state.attached[0];
	const labels = KeyLabels.generate(
		state.sessions.length,
		KeyLabels.NUMBER_CHARS,
	);
	return state.sessions.map((session, i) => ({
		key: labels[i]!,
		label:
			session.name === current ? `${session.name} (attached)` : session.name,
		action: Callback(() => void killSession(session.name)),
	}));
}

// Tabs of the attached session; none when no client is attached.
function tabItems(state: ZjState): MenuItem[] {
	const current = state.attached[0];
	if (!current) return [];
	const session = state.sessions.find((s) => s.name === current);
	// Numbered by position: tab N is always key N.
	const tabs = capped(
		[...(session?.tabs ?? [])].sort((a, b) => a.position - b.position),
		KeyLabels.NUMBER_CHARS,
	);
	const labels = KeyLabels.generate(tabs.length, KeyLabels.NUMBER_CHARS);
	return tabs.map((tab, i) => ({
		key: labels[i]!,
		label: tab.name,
		action: Callback(() => void focusTab(current, current, tab.position)),
	}));
}

function reviveItems(state: ZjState): MenuItem[] {
	const current = state.attached[0];
	const exited = capped(state.resurrectable);
	const labels = KeyLabels.generate(exited.length);
	return exited.map((name, i) => ({
		key: labels[i]!,
		label: name,
		action: Callback(() => void startSession(current, name)),
	}));
}

interface JumpChoice {
	text: string;
	subText: string;
	session: string;
	// null: a session row (switch to the session as a whole).
	tab: number | null;
	exited: boolean;
}

// Every session and its tabs in one fuzzy-searchable list, in the plugin's
// order: each live session's row followed by its tabs, then resurrectable
// sessions at the bottom. The attached session's row and its active tab are
// left out since picking them would be a no-op.
function jumpSpec(state: ZjState): ChooserSpec<JumpChoice> {
	const current = state.attached[0];
	const choices: JumpChoice[] = [];
	for (const session of state.sessions) {
		const isCurrent = session.name === current;
		if (!isCurrent)
			choices.push({
				text: session.name,
				subText: `session · ${session.tabs.length} tabs`,
				session: session.name,
				tab: null,
				exited: false,
			});
		for (const tab of [...session.tabs].sort(
			(a, b) => a.position - b.position,
		)) {
			if (isCurrent && tab.active) continue;
			choices.push({
				text: `${session.name} › ${tab.name}`,
				subText: isCurrent ? "tab · current session" : "tab",
				session: session.name,
				tab: tab.position,
				exited: false,
			});
		}
	}
	for (const name of state.resurrectable)
		choices.push({
			text: name,
			subText: "exited session · revive",
			session: name,
			tab: null,
			exited: true,
		});

	return {
		choices,
		placeholder: "Jump to session or tab…",
		searchSubText: true,
		onSelect: (choice) => {
			// Deferred past the chooser's own hide, same as the other modules'
			// terminal side effects (see chooser-runtime.ts's onSelect).
			hs.timer.doAfter(0, () => {
				if (choice.exited) void startSession(current, choice.session);
				else if (choice.tab === null)
					void switchToSession(current, choice.session);
				else void focusTab(current, choice.session, choice.tab);
			});
		},
	};
}

// The Zellij menu -- shown under the leader menu's "j" and directly by
// init.ts's Hyper+G hotkey. One state fetch, started as soon as the level
// containing it mounts, feeds every child: they're plain static submenus
// rendered from that snapshot, and picks send straight to the snapshot's
// attached session (see sendToAttached) without fetching again.
export const menu = PrefetchSubmenu(requireState, (state) => [
	{
		key: "s",
		label: "Switch session",
		action: Submenu(sessionItems(state)),
	},
	{
		key: "f",
		label: "Find session/tab",
		action: Chooser(() => jumpSpec(state)),
	},
	{ key: "t", label: "Switch tab", action: Submenu(tabItems(state)) },
	{ key: "r", label: "Revive session", action: Submenu(reviveItems(state)) },
	{ key: "k", label: "Kill session", action: Submenu(killItems(state)) },
	{
		key: "n",
		label: "New session",
		action: Chooser(() => newSessionSpec(state.attached[0])),
	},
]);

export const node: MenuItem = { key: "j", label: "Zellij", action: menu };

// Just the attached session's tabs (the "t" list above) as its own root,
// for init.ts's Hyper+T -- same one-fetch prefetch, no menu level first.
export const tabsMenu = PrefetchSubmenu(requireState, tabItems);
