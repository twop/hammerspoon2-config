// Native app launcher/focuser, driven by hs.chooser and themed to match
// the leader menu. Port of app-picker.lua. v2's launchOrFocus() takes a
// bundle ID, not a `.app` path, and there's no public path->bundleID
// lookup (v1's infoForBundlePath is SKIP_DOCS'd out of v2's JS API), so
// bundleIDForPath() reads the bundle's Info.plist directly via hs.plist
// instead.

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

function styleChooser(c: HSChooser): void {
	c.width = 0.3;
	c.backgroundColor = chooserColor(Theme.background);
	c.borderColor = chooserColor(Theme.border);
	c.cornerRadius = Theme.cornerRadius;
	c.textColor = chooserColor(Theme.text);
	c.subTextColor = chooserColor(Theme.textDim);
}

function bundleIDForPath(path: string): string | null {
	const info = hs.plist.fromFile(`${path}/Contents/Info.plist`) as Record<
		string,
		unknown
	> | null;
	const id = info?.["CFBundleIdentifier"];
	return typeof id === "string" ? id : null;
}

function focusWindow(win: HSWindow): void {
	if (win.isMinimized) win.unminimize();
	win.focus();
}

// Shown when the selected app has more than one standard window; picking
// a row focuses that window. A plain new chooser each time (window lists
// are per-invocation, unlike the app list).
function showWindowChooser(windows: HSWindow[]): void {
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
		if (win) focusWindow(win);
	};
	c.show();
}

async function onSelect(choice: Record<string, unknown> | null): Promise<void> {
	if (!choice) return;
	const path = choice["path"] as string;
	const bundleID = bundleIDForPath(path);

	const app = bundleID ? hs.application.matchingBundleID(bundleID) : null;
	if (!app) {
		if (bundleID) await hs.application.launchOrFocus(bundleID);
		return;
	}

	const windows = app.allWindows.filter((w) => w.isStandard);
	if (windows.length === 0) {
		app.activate();
	} else if (windows.length === 1) {
		focusWindow(windows[0]!);
	} else {
		showWindowChooser(windows);
	}
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
	console.log("here");
	if (chooser) return;
	console.log("here: after");
	allChoices = scanApps();

	chooser = hs.chooser.create();
	styleChooser(chooser);
	chooser.visibleRows = 9;
	chooser.searchSubText = true;
	chooser.placeholder = "Open or focus app…";
	chooser.onSelect = (choice) => void onSelect(choice);
}

export function show(): void {
	ensureLoaded();
	const c = chooser!;
	c.setChoices(allChoices);
	c.query = ""; // hs.chooser keeps the previous query across show() calls
	c.show();
}
