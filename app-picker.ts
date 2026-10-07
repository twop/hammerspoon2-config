// Native app launcher/focuser, driven by hs.chooser and themed to match
// the leader menu. Port of app-picker.lua. v2's launchOrFocus() takes a
// bundle ID, not a `.app` path, and there's no public path->bundleID
// lookup (v1's infoForBundlePath is SKIP_DOCS'd out of v2's JS API), so
// bundleIDForPath() reads the bundle's Info.plist directly via hs.plist
// instead.
//
// focusWindow()/windowChooserSpec()/activateApp() are exported for
// app-switcher.ts too -- same windows-drill-down and focus-handoff
// behavior fits both a full installed-apps list and a running-apps-only
// switcher equally well.

import { eraseChooser, type ChooserSpec } from "./chooser-runtime";

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

interface WindowChoice {
	text: string;
	winIndex: number;
}

let allChoices: AppChoice[] = []; // built once from APP_DIRS, cached for the session

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
// a row focuses that window. A plain new spec each time (window lists are
// per-invocation, unlike the app list).
export function windowChooserSpec(windows: HSWindow[]): ChooserSpec<WindowChoice> {
	return {
		visibleRows: Math.min(windows.length, 9),
		placeholder: "Choose window…",
		choices: windows.map((win, winIndex) => ({
			text: win.title || "Untitled",
			winIndex,
		})),
		onSelect: (choice) => {
			const win = windows[choice.winIndex];
			if (win) hs.timer.doAfter(0, () => focusWindow(win));
		},
	};
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

// Deferred for the parts that are real side effects (focusing a window,
// activating the app): onSelect fires while the chooser is still in the
// middle of hiding (which itself restores focus to the previously active
// window), so doing that synchronously right here races that handoff. One
// tick later it's settled. Drilling into the window chooser instead
// doesn't need its own defer -- chooser-runtime.ts's mountChooser() already
// defers mounting whatever spec onSelect returns, for the same reason.
function onSelect(choice: AppChoice): void | ChooserSpec {
	const bundleID = bundleIDForPath(choice.path);
	if (!bundleID) return;

	const app = hs.application.matchingBundleID(bundleID);
	const windows = app?.allWindows.filter((w) => w.isStandard) ?? [];

	if (windows.length === 1) {
		const win = windows[0]!;
		hs.timer.doAfter(0, () => focusWindow(win));
		return;
	}
	if (windows.length > 1) {
		return eraseChooser(windowChooserSpec(windows));
	}
	hs.timer.doAfter(0, () => void activateApp(bundleID));
	return;
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

export function spec(): ChooserSpec<AppChoice> {
	if (allChoices.length === 0) allChoices = scanApps();
	return {
		choices: allChoices,
		visibleRows: 9,
		searchSubText: true,
		placeholder: "Open or focus app…",
		onSelect,
	};
}
