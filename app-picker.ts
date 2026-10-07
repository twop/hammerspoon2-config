// Native app launcher/focuser, driven by hs.chooser and themed to match
// the leader menu. Port of app-picker.lua. v2's launchOrFocus() takes a
// bundle ID, not a `.app` path, and there's no public path->bundleID
// lookup (v1's infoForBundlePath is SKIP_DOCS'd out of v2's JS API), so
// bundleIDForPath() reads the bundle's Info.plist directly via hs.plist
// instead.
//
// styleChooser()/focusWindow()/showWindowChooser()/activateApp() are
// exported for app-switcher.ts too -- same windows-drill-down and
// focus-handoff behavior fits both a full installed-apps list and a
// running-apps-only switcher equally well.

import { Theme, chooserColor } from "./nord-theme";

const APP_DIRS = [
	"/Applications",
	"/System/Applications",
	"/System/Applications/Utilities",
	hs.fs.homeDirectory() + "/Applications",
];

interface AppChoice {
	text: string;
	subText: string;
	path: string;
	image: HSImage | null;
}

let chooser: HSChooser | null = null;
let allChoices: AppChoice[] = []; // built once from APP_DIRS, cached for the session

export function styleChooser(c: HSChooser): void {
	c.width = 0.3;
	c.backgroundColor = chooserColor(Theme.background);
	c.borderColor = chooserColor(Theme.border);
	c.cornerRadius = Theme.cornerRadius;
	c.textColor = chooserColor(Theme.text);
	c.subTextColor = chooserColor(Theme.textMuted);
	c.selectionColor = chooserColor(Theme.selectionBack);
}

function bundleIDForPath(path: string): string | null {
	const info = hs.plist.fromFile(`${path}/Contents/Info.plist`) as Record<
		string,
		unknown
	> | null;
	const id = info?.["CFBundleIdentifier"];
	return typeof id === "string" ? id : null;
}

export function focusWindow(win: HSWindow): void {
	if (win.isMinimized) win.unminimize();
	win.focus();
}

// Shown when the selected app has more than one standard window; picking
// a row focuses that window. A plain new chooser each time (window lists
// are per-invocation, unlike the app list).
export function showWindowChooser(windows: HSWindow[]): void {
	const c = hs.chooser.create();
	styleChooser(c);
	c.visibleRows = Math.min(windows.length, 9);
	c.placeholder = "Choose window…";
	c.setChoices(
		windows.map((win) => ({
			text: win.title || "Untitled",
			winIndex: windows.indexOf(win),
		})),
	);
	c.onSelect = (choice) => {
		if (!choice) return;
		const win = windows[choice["winIndex"] as number];
		if (win) hs.timer.doAfter(0, () => focusWindow(win));
	};
	c.show();
}

// Handles both "not running yet" and "running but with no standard window
// open" (e.g. a menu-bar-only helper like 1Password) -- app.activate() on
// an already-running, windowless app often doesn't surface anything, but
// launchOrFocus() is documented to handle exactly this ("give it focus if
// it's already running"). A cold launch can take a real amount of time,
// long enough that something else (e.g. this chooser's own hide-triggered
// "restore focus to the previously active window") reclaims focus before
// it resolves, so a follow-up activate() once it's confirmed running
// re-asserts focus for real.
export async function activateApp(bundleID: string): Promise<void> {
	await hs.application.launchOrFocus(bundleID);
	hs.application.matchingBundleID(bundleID)?.activate();
}

function onSelect(choice: Record<string, unknown> | null): void {
	if (!choice) return;
	const path = choice["path"] as string;

	// Deferred: onSelect fires while the chooser is still in the middle of
	// hiding (which itself restores focus to the previously active window),
	// so activating/focusing a window -- or opening the window-count
	// chooser below -- synchronously right here races that handoff. One
	// tick later it's settled. Same issue as leader-menu.ts's selectOption()
	// and emoji-picker.ts's onSelect().
	hs.timer.doAfter(0, async () => {
		const bundleID = bundleIDForPath(path);
		if (!bundleID) return;

		const app = hs.application.matchingBundleID(bundleID);
		const windows = app?.allWindows.filter((w) => w.isStandard) ?? [];

		if (windows.length === 1) {
			focusWindow(windows[0]!);
		} else if (windows.length > 1) {
			showWindowChooser(windows);
		} else {
			await activateApp(bundleID);
		}
	});
}

function scanApps(): AppChoice[] {
	const choices: AppChoice[] = [];
	for (const dir of APP_DIRS) {
		let names: string[] | null;
		try {
			names = hs.fs.list(dir);
		} catch {
			continue;
		}
		if (!names) continue;
		for (const name of names) {
			if (!name.endsWith(".app")) continue;
			const path = `${dir}/${name}`;
			choices.push({
				text: name.replace(/\.app$/, ""),
				subText: path,
				path,
				image: HSImage.iconForFile(path),
			});
		}
	}
	choices.sort((a, b) => a.text.localeCompare(b.text));
	return choices;
}

function ensureLoaded(): void {
	if (chooser) return;
	allChoices = scanApps();

	chooser = hs.chooser.create();
	styleChooser(chooser);
	chooser.visibleRows = 9;
	chooser.searchSubText = true;
	chooser.placeholder = "Open or focus app…";
	chooser.onSelect = onSelect;
}

export function show(): void {
	ensureLoaded();
	const c = chooser!;
	c.setChoices(allChoices);
	c.query = ""; // hs.chooser keeps the previous query across show() calls
	c.show();
}
