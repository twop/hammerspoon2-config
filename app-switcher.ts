// Cmd+Tab-style app switcher, driven by hs.chooser and themed to match the
// leader menu -- distinct from app-picker.ts's "/" chooser, which lists
// every *installed* app. This one lists only currently *running* apps, and
// unlike app-picker.ts's cached allChoices, is rebuilt fresh on every
// spec() since the running-app set changes constantly.

import { focusWindow, windowChooserSpec, activateApp } from "./app-picker";
import type { ChoiceOption } from "./chooser-options-bar";
import { eraseChooser, type ChooserSpec } from "./chooser-runtime";

interface AppChoice {
	text: string;
	subText: string;
	bundleID: string;
	image: HSImage | null;
}

// ⌘Q/⌘H on the currently-highlighted row -- demonstrates chooser-options-bar.ts.
// Resolved fresh at fire time rather than closing over `app` directly, matching
// this file's and app-picker.ts's existing "resolved fresh" convention.
// Called only from listRunningApps(), which already filters out apps with
// no bundleID -- the assertion below just reflects that. `chooser` is hidden
// explicitly since neither Quit nor Hide is a "select this row" action.
function optionsFor(app: HSApplication, chooser: HSChooser): ChoiceOption[] {
	const bundleID = app.bundleID!;
	const name = app.title ?? bundleID;
	return [
		{
			mods: ["cmd"],
			key: "q",
			label: `Quit ${name}`,
			run: () => {
				hs.application.matchingBundleID(bundleID)?.kill();
				chooser.hide();
			},
		},
		{
			mods: ["cmd"],
			key: "h",
			label: `Hide ${name}`,
			run: () => {
				hs.application.matchingBundleID(bundleID)?.hide();
				chooser.hide();
			},
		},
	];
}

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

// Deferred for the parts that are real side effects, same reason as
// app-picker.ts's onSelect(): this fires while the chooser is still
// mid-hide (which restores focus to whatever was active before), so doing
// that synchronously right here races that handoff. Drilling into the
// window chooser doesn't need its own defer -- chooser-runtime.ts's
// mountChooser() already defers mounting whatever spec onSelect returns.
function onSelect(choice: AppChoice): void | ChooserSpec {
	const app = hs.application.matchingBundleID(choice.bundleID);
	const windows = app?.allWindows.filter((w) => w.isStandard) ?? [];

	if (windows.length === 1) {
		const win = windows[0]!;
		hs.timer.doAfter(0, () => focusWindow(win));
		return;
	}
	if (windows.length > 1) {
		return eraseChooser(windowChooserSpec(windows));
	}
	hs.timer.doAfter(0, () => void activateApp(choice.bundleID));
	return;
}

export function spec(): ChooserSpec<AppChoice> {
	return {
		choices: listRunningApps(),
		visibleRows: 9,
		searchSubText: true,
		placeholder: "Switch to app…",
		onSelect,
		optionsBar: (row, chooser) => {
			const app = hs.application.matchingBundleID(row.bundleID);
			return app ? optionsFor(app, chooser) : undefined;
		},
	};
}
