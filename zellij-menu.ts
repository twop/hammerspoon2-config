// Zellij (terminal multiplexer) session/tab switcher for the leader menu.
// Backed by the headless zj_hs_jump zellij plugin (loaded via
// ~/.config/zellij/config.kdl's load_plugins): one `zellij pipe --name
// state` call to any live session returns every session's tabs, attached
// clients and resurrectable sessions as JSON, and `focus`/`session` pipes do
// the switching. v2 has no synchronous hs.execute -- every shell call here is
// a Promise via hs.task.shell(), which is why every exported submenu builder
// below is async.

import * as KeyLabels from "./key-labels";
import { shellQuote } from "./termview";
import { focusApp, type MenuItem } from "./leader-menu";
import { eraseChooser, type ChooserSpec } from "./chooser-runtime";
import { menuTree } from "./leader-menu-config";

// hs.task.shell runs commands through a bare, non-login /bin/sh -- PATH is
// just the launchd default (/usr/bin:/bin:/usr/sbin:/sbin), so a plain
// "zellij" (living in ~/.cargo/bin) is unresolvable; worse, hs.task doesn't
// fail fast on a missing command the way a real shell would -- the
// returned promise never settles at all. termview.ts's runLoginShell() hit
// the same PATH gap and works around it by running through a login +
// interactive invocation of the user's own shell, which sources
// .zprofile/.zshrc first -- same fix applied here.
const SHELL = hs.appinfo.environment.SHELL ?? "/bin/zsh";

function loginShell(
	cmd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return hs.task.shell(`${SHELL} -l -i -c ${shellQuote(cmd)}`, {});
}

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

// Fetches state and resolves the attached session (the plugin's
// attached[0]), alerting when either is unavailable -- only for deliberate
// picks (see switchSessionItem for why).
async function resolveState(): Promise<{
	state: ZjState;
	current: string;
} | null> {
	const state = await fetchState();
	if (!state) {
		hs.ui.alert("Zellij: zj_hs_jump not reachable").show();
		return null;
	}
	const current = state.attached[0];
	if (!current) {
		hs.ui.alert("Zellij: no session currently attached").show();
		return null;
	}
	return { state, current };
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
// switch), then brings the terminal forward.
async function sendToAttached(
	name: "focus" | "session",
	payload: object,
): Promise<void> {
	const resolved = await resolveState();
	if (!resolved) return;
	if (reportFailure(await pipe<ZjReply>(resolved.current, name, payload)))
		return;
	focusAlacritty();
}

function switchToSession(name: string): Promise<void> {
	return sendToAttached("session", { name });
}

function focusTab(session: string, tab: number): Promise<void> {
	return sendToAttached("focus", { session, tab });
}

// Resurrects an EXITED session as a live background one (no client attached
// yet, so nothing currently attached is disturbed), then switches to it.
async function reviveSession(name: string): Promise<void> {
	await loginShell(`zellij attach --create-background ${shellQuote(name)}`);
	await switchToSession(name);
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

export async function tabsSubmenu(): Promise<MenuItem[]> {
	const resolved = await resolveState();
	if (!resolved) return [];
	const { state, current } = resolved;

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
		action: {
			kind: "callback",
			run: () => void focusTab(current, tab.position),
		},
	}));
}

export async function reviveSubmenu(): Promise<MenuItem[]> {
	const state = await fetchState();
	if (!state) {
		hs.ui.alert("Zellij: zj_hs_jump not reachable").show();
		return [];
	}
	const exited = capped(state.resurrectable);
	const labels = KeyLabels.generate(exited.length);
	return exited.map((name, i) => ({
		key: labels[i]!,
		label: name,
		action: { kind: "callback", run: () => void reviveSession(name) },
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
async function jumpSpec(): Promise<ChooserSpec<JumpChoice>> {
	const state = await fetchState();
	const current = state?.attached[0];
	const choices: JumpChoice[] = [];
	for (const session of state?.sessions ?? []) {
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
	for (const name of state?.resurrectable ?? [])
		choices.push({
			text: name,
			subText: "exited session · revive",
			session: name,
			tab: null,
			exited: true,
		});

	return {
		choices,
		placeholder: state ? "Jump to session or tab…" : "zj_hs_jump not reachable",
		searchSubText: true,
		onSelect: (choice) => {
			// Deferred past the chooser's own hide, same as the other modules'
			// terminal side effects (see chooser-runtime.ts's onSelect).
			hs.timer.doAfter(0, () => {
				if (choice.exited) void reviveSession(choice.session);
				else if (choice.tab === null) void switchToSession(choice.session);
				else void focusTab(choice.session, choice.tab);
			});
		},
	};
}

// The Zellij menu's own items -- shown under the leader menu's "j" (node
// below) and directly by init.ts's Hyper+G hotkey.
export async function items(): Promise<MenuItem[]> {
	return [
		{
			key: "s",
			label: "Switch session",
			action: {
				kind: "submenu",
				submenu: async () => {
					const state = await fetchState();
					if (!state) return [];

					const labels = KeyLabels.generate(
						state.sessions.length,
						KeyLabels.NUMBER_CHARS,
					);

					return state.sessions.map(
						(session, i) =>
							({
								key: labels[i],
								label: session.name,
								action: {
									kind: "callback",
									run: () => switchToSession(session.name),
								},
							}) satisfies MenuItem,
					);
				},
			},
		},
		{
			key: "f",
			label: "Find session/tab",
			action: {
				kind: "chooser",
				spec: async () => eraseChooser(await jumpSpec()),
			},
		},
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
	];
}

export const node: MenuItem = {
	key: "j",
	label: "Zellij",
	action: { kind: "submenu", submenu: items },
};
