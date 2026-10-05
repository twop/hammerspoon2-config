// Cmd+Tab-style app switcher, driven by hs.chooser and themed to match the
// leader menu -- distinct from app-picker.ts's "/" chooser, which lists
// every *installed* app. This one lists only currently *running* apps, and
// unlike app-picker.ts's cached allChoices, is rebuilt fresh on every
// show() since the running-app set changes constantly.

import {
	styleChooser,
	focusWindow,
	showWindowChooser,
	activateApp,
} from "./app-picker";

interface AppChoice {
	text: string;
	subText: string;
	bundleID: string;
	image: HSImage | null;
}

let chooser: HSChooser | null = null;

// Only Dock-visible ("standard") apps, matching leader-menu-config.ts's own
// hideOtherApps() filter -- and excludes whichever app was frontmost when
// the switcher was opened, since this is a switch-*to* list.
function listRunningApps(): AppChoice[] {
	const frontmost = hs.application.frontmost();
	const choices: AppChoice[] = [];
	for (const app of hs.application.runningApplications()) {
		if (app.kind !== "standard") continue;
		if (app.pid === frontmost?.pid) continue;
		if (app.bundleID === hs.appinfo.bundleIdentifier) continue;
		if (!app.bundleID || !app.title) continue;
		choices.push({
			text: app.title,
			subText: app.bundleID,
			bundleID: app.bundleID,
			image: HSImage.fromAppBundle(app.bundleID),
		});
	}
	choices.sort((a, b) => a.text.localeCompare(b.text));
	return choices;
}

function onSelect(choice: Record<string, unknown> | null): void {
	if (!choice) return;
	const bundleID = choice["bundleID"] as string;

	// Deferred for the same reason as app-picker.ts's onSelect(): this fires
	// while the chooser is still mid-hide (which restores focus to whatever
	// was active before), so acting synchronously races that handoff.
	hs.timer.doAfter(0, async () => {
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

function ensureLoaded(): void {
	if (chooser) return;
	chooser = hs.chooser.create();
	styleChooser(chooser);
	chooser.visibleRows = 9;
	chooser.searchSubText = true;
	chooser.placeholder = "Switch to app…";
	chooser.onSelect = onSelect;
}

export function show(): void {
	ensureLoaded();
	const c = chooser!;
	c.setChoices(listRunningApps());
	c.query = ""; // hs.chooser keeps the previous query across show() calls
	c.show();
}
