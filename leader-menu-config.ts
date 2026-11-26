// The Hyper+M menu tree itself. Port of leader-menu-config.lua --
// leader-menu.ts is the generic engine; this file is its only consumer.
//
// Icons are SF Symbols (via HSImage.fromSymbol()), matching the real
// Leader Key app's config (~/work/dotfiles/leader_key/config.json,
// "iconPath" per action) that this tree is itself a port of -- symbol()
// below just looks each one up by the same name. v2-only items this port
// added beyond that original tree (the "/" app picker, "p" process
// explorer, most of "u" Utilities) have no iconPath to carry over, so
// their symbol names are this port's own pick.
//
// v2's hs.application.launchOrFocus() takes a bundle ID, not a `.app`
// path (unlike hs.image.iconForFile(), which still wants a path, and is
// resolved via leader-menu.ts's resolveIcon() -> HSImage.fromAppBundle()
// for "app" actions instead). APP_BUNDLE_IDS below are this port's best
// effort from general knowledge, NOT independently verified against each
// app's real Info.plist -- confirm with
// `hs.plist.fromFile(path + "/Contents/Info.plist").CFBundleIdentifier`
// (or `mdls -name kMDItemCFBundleIdentifier <path>`) before wiring this up
// for real.

import * as EmojiPicker from "./emoji-picker";
import * as MenuItemSearch from "./menu-item-search";
import * as AppPicker from "./app-picker";
import * as AppSwitcher from "./app-switcher";
import * as ClipboardHistory from "./clipboard-history";
import * as ProcessExplorer from "./process-explorer";
import * as QuickNote from "./quick-note";
import * as Term from "./termview";
import * as ZellijMenu from "./zellij-menu";
import { dailyNotePath } from "./daily-note";
import {
	App,
	Callback,
	Chooser,
	Cmd,
	Submenu,
	Url,
	type MenuItem,
} from "./leader-menu";

function symbol(name: string): HSImage {
	// biome-ignore lint/style/noNonNullAssertion: <explanation>
	return HSImage.fromSymbol(name)!;
}

const APP_BUNDLE_IDS = {
	alacritty: "org.alacritty",
	zed: "dev.zed.Zed",
	telegram: "ru.keepcoder.Telegram",
	messages: "com.apple.MobileSMS",
	safari: "com.apple.Safari",
	bear: "net.shinyfrog.bear",
	onePassword: "com.1password.1password",
	zenBrowser: "app.zen-browser.zen",
	elegooSlicer: "com.elegoo3d.elegoo-slicer",
	freeCAD: "org.freecad.FreeCAD",
} as const;

function appItem(key: string, label: string, bundleID: string): MenuItem {
	return { key, label, action: App(bundleID) };
}

// ============================================================
// WINDOW RESIZING
// ============================================================

function setWindowFrame(
	widthFraction: number,
	position: "left" | "right" | "center",
): void {
	const win = hs.window.focusedWindow();
	if (!win) return;
	const screenFrame = win.screen?.frame;
	if (!screenFrame) return;
	const width = screenFrame.w * widthFraction;

	let x = screenFrame.x;
	if (position === "right") x = screenFrame.x + screenFrame.w - width;
	else if (position === "center")
		x = screenFrame.x + (screenFrame.w - width) / 2;

	// HSWindow.frame is typed as a real HSRect instance, not a plain
	// {x,y,w,h} dictionary (unlike hs.canvas's rect parameters, which take a
	// loose object) -- a plain literal cast with `as HSRect` satisfies the
	// type checker but not the native setter, which silently no-ops on it.
	win.frame = new HSRect(x, screenFrame.y, width, screenFrame.h);
}

// Not hs.window.maximize(): its bundled JS (hs.window.js) calls
// win.setFrame(x, y, w, h), which HSWindow doesn't have -- it throws, so
// the window never moves. Go through the same frame setter as the rest.
function maximizeFocusedWindow(): void {
	hs.window.focusedWindow()?.raise();
	setWindowFrame(1, "left");
}

function toggleFullScreenFocusedWindow(): void {
	hs.window.focusedWindow()?.toggleFullscreen();
}

// ============================================================
// APP VISIBILITY
// ============================================================

// Only "standard" (Dock-visible) apps, matching macOS's own Cmd+Option+H --
// "accessory"/"background" apps have no Dock presence to begin with, and
// hiding them wouldn't do anything a user would notice anyway.
function hideOtherApps(): void {
	const frontmost = hs.application.frontmost();
	for (const app of hs.application.runningApplications()) {
		if (app.kind !== "standard") continue;
		if (app.pid === frontmost?.pid) continue;
		if (app.bundleID === hs.appinfo.bundleIdentifier) continue;
		app.hide();
	}
}

// ============================================================
// DAILY JOURNAL NOTE
// ============================================================

// Today's note path, creating the file (and its folder) if missing.
function ensureDailyNote(): string {
	const { path, dir } = dailyNotePath();
	hs.fs.mkdir(dir);
	if (!hs.fs.attributes(path)) hs.fs.write(path, "");
	return path;
}

function openDailyNote(): void {
	Term.summon("journal", `hx ${Term.shellQuote(ensureDailyNote())}`);
}

function openDailyNoteInShelv(): void {
	hs.task
		.create(
			"/usr/bin/open",
			["-a", "Shelv", ensureDailyNote()],
			null,
			null,
			null,
		)
		.start();
}

// ============================================================
// MENU TREE
// ============================================================

export const menuTree: MenuItem[] = [
	{
		key: "t",
		label: "Alacritty",
		action: App(APP_BUNDLE_IDS.alacritty),
	},

	{
		key: "r",
		label: "Resize window",
		icon: symbol("rectangle.split.3x3.fill"),
		action: Submenu([
			{
				key: "h",
				label: "Left 1/3",
				icon: symbol("inset.filled.leftthird.rectangle"),
				action: Callback(() => setWindowFrame(1 / 3, "left")),
			},
			{
				key: "l",
				label: "Right 1/3",
				icon: symbol("inset.filled.trailingthird.rectangle"),
				action: Callback(() => setWindowFrame(1 / 3, "right")),
			},
			{
				key: "j",
				label: "Left 2/3",
				icon: symbol("inset.filled.lefthalf.rectangle"),
				action: Callback(() => setWindowFrame(2 / 3, "left")),
			},
			{
				key: "k",
				label: "Right 2/3",
				icon: symbol("inset.filled.righthalf.rectangle"),
				action: Callback(() => setWindowFrame(2 / 3, "right")),
			},
			{
				key: "m",
				label: "Maximize",
				icon: symbol("inset.filled.rectangle"),
				action: Callback(maximizeFocusedWindow),
			},
			{
				key: ",",
				label: "Center 2/3",
				icon: symbol("inset.filled.center.rectangle"),
				action: Callback(() => setWindowFrame(2 / 3, "center")),
			},
			{
				key: ".",
				label: "Center 1/2",
				icon: symbol("inset.filled.rectangle.portrait"),
				action: Callback(() => setWindowFrame(1 / 2, "center")),
			},
			{
				key: "H",
				label: "Left 1/2",
				icon: symbol("inset.filled.lefthalf.rectangle"),
				action: Callback(() => setWindowFrame(1 / 2, "left")),
			},
			{
				key: "L",
				label: "Right 1/2",
				icon: symbol("inset.filled.righthalf.rectangle"),
				action: Callback(() => setWindowFrame(1 / 2, "right")),
			},
			{
				key: "f",
				label: "Full screen",
				icon: symbol("arrow.up.backward.and.arrow.down.forward.rectangle"),
				action: Callback(toggleFullScreenFocusedWindow),
			},
		]),
	},

	{
		key: "b",
		label: "Zen Browser",
		action: App(APP_BUNDLE_IDS.zenBrowser),
	},

	{
		key: "f",
		label: "Hide others",
		icon: symbol("rectangle.and.hand.point.up.left"),
		action: Callback(hideOtherApps),
	},

	{
		key: "s",
		label: "Screenshots",
		icon: symbol("camera"),
		action: Submenu([
			{
				key: "y",
				label: "Screenshot",
				icon: symbol("circle.rectangle.dashed"),
				action: Cmd("/usr/sbin/screencapture", "-ci"),
			},
			{
				key: "a",
				label: "Show app",
				icon: symbol("app.badge"),
				action: Url("shottr://show"),
			},
			{
				key: "s",
				label: "Area screenshot",
				icon: symbol("viewfinder"),
				action: Url("shottr://grab/area?then=copy"),
			},
			{
				key: "r",
				label: "repeat screenshot then edit",
				icon: symbol("viewfinder"),
				action: Url("shottr://grab/repeat?then=edit"),
			},
			{
				key: "w",
				label: "Window screenshot",
				icon: symbol("macwindow.badge.plus"),
				action: Url("shottr://grab/window"),
			},
		]),
	},

	{
		key: "e",
		label: "Pick emoji",
		icon: symbol("face.smiling"),
		action: Url(
			"raycast://extensions/raycast/emoji-symbols/search-emoji-symbols",
		),
	},

	{
		key: "E",
		label: "Pick emoji (native)",
		icon: symbol("face.smiling"),
		action: Chooser(() => EmojiPicker.spec()),
	},

	{
		key: "d",
		label: "Apps",
		icon: symbol("macwindow"),
		action: Submenu([
			appItem("t", "Telegram", APP_BUNDLE_IDS.telegram),
			appItem("z", "Zed", APP_BUNDLE_IDS.zed),
			appItem("m", "Messages", APP_BUNDLE_IDS.messages),
			appItem("s", "Safari", APP_BUNDLE_IDS.safari),
			appItem("b", "Bear", APP_BUNDLE_IDS.bear),
			appItem("p", "1Password", APP_BUNDLE_IDS.onePassword),
			appItem("e", "ElegooSlicer", APP_BUNDLE_IDS.elegooSlicer),
			appItem("c", "FreeCAD", APP_BUNDLE_IDS.freeCAD),
		]),
	},

	{
		key: "m",
		label: "Search menu items",
		icon: symbol("menucard"),
		action: Chooser(() => MenuItemSearch.spec()),
	},

	{
		key: "/",
		label: "Open or focus app",
		icon: symbol("magnifyingglass"),
		action: Chooser(() => AppPicker.spec()),
	},

	{
		key: " ",
		label: "Switch app",
		icon: symbol("rectangle.stack"),
		action: Chooser(() => AppSwitcher.spec()),
	},

	{
		key: "v",
		label: "Clipboard history",
		icon: symbol("doc.on.clipboard"),
		action: Chooser(() => ClipboardHistory.spec()),
	},

	{
		key: "p",
		label: "Process explorer",
		icon: symbol("cpu"),
		action: Chooser(() => ProcessExplorer.spec()),
	},

	{
		key: "u",
		label: "Utilities",
		icon: symbol("ellipsis"),
		action: Submenu([
			{
				key: "m",
				label: "Music",
				action: Submenu([
					{
						key: ",",
						label: "Play/Pause",
						action: Url(
							"raycast://extensions/fedevitaledev/music/toggle-play-pause",
						),
					},
				]),
			},
			{
				key: "g",
				label: "View google cal event",
				icon: symbol("calendar"),
				action: Url("raycast://extensions/thomas/google-calendar/list-events"),
			},
			{
				key: "x",
				label: "Tuxedo",
				icon: symbol("terminal"),
				action: Callback(() => Term.summon("tuxedo", "tuxedo")),
			},
			{
				key: "n",
				label: "Nushell",
				icon: symbol("terminal"),
				action: Callback(() => Term.summon("nu", undefined, " --shell nu")),
			},
			{
				key: "y",
				label: "Yazi",
				icon: symbol("folder"),
				action: Callback(() =>
					Term.summon(
						"yazi",
						"yazi",
						" --cwd " + Term.shellQuote(hs.fs.homeDirectory()),
					),
				),
			},
			{
				key: "h",
				label: "Find file (Helix)",
				icon: symbol("doc.text.magnifyingglass"),
				action: Callback(() => {
					Term.pick("file-picker", "fzf", "~/work", (picked) => {
						// fzf's default output is relative to its --cwd; only
						// prefix with ~/work if the report didn't already give an
						// absolute (or ~-relative) path.
						const path = /^[~/]/.test(picked) ? picked : "~/work/" + picked;
						Term.summon("helix", "hx " + Term.shellQuote(path));
					});
				}),
			},
			{
				key: "d",
				label: "Daily note",
				icon: symbol("note.text"),
				action: Callback(openDailyNote),
			},
			{
				key: "D",
				label: "Daily note (Shelv)",
				icon: symbol("note.text"),
				action: Callback(openDailyNoteInShelv),
			},
			{
				key: "q",
				label: "Quick note",
				icon: symbol("square.and.pencil"),
				action: Chooser(() => QuickNote.spec()),
			},
			{
				key: "c",
				label: "Clear clipboard history",
				icon: symbol("trash"),
				action: Callback(() => ClipboardHistory.clear()),
			},
			{
				key: "r",
				label: "Reload config",
				icon: symbol("arrow.clockwise"),
				action: Callback(() => hs.reload()),
			},
		]),
	},

	{ key: "j", label: "Zellij", action: ZellijMenu.menu },
];
