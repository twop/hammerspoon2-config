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
import type { MenuItem } from "./leader-menu";
import { eraseChooser } from "./chooser-runtime";

function symbol(name: string): HSImage {
	return HSImage.fromSymbol(name)!;
}

const APP_BUNDLE_IDS = {
	alacritty: "org.alacritty",
	zed: "dev.zed.Zed",
	arc: "company.thebrowser.Browser",
	telegram: "ru.keepcoder.Telegram",
	vscode: "com.microsoft.VSCode",
	messages: "com.apple.MobileSMS",
	safari: "com.apple.Safari",
	bear: "net.shinyfrog.bear",
	onePassword: "com.1password.1password",
	zenBrowser: "app.zen-browser.zen",
	elegooSlicer: "com.elegoo3d.elegoo-slicer",
	freeCAD: "org.freecad.FreeCAD",
} as const;

function appItem(key: string, label: string, bundleID: string): MenuItem {
	return { key, label, action: { kind: "app", bundleID } };
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

function maximizeFocusedWindow(): void {
	hs.window.focusedWindow()?.raise();
	const win = hs.window.focusedWindow();
	if (win) hs.window.maximize(win);
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

function openDailyNote(): void {
	const { path, dir } = dailyNotePath();
	hs.fs.mkdir(dir);
	if (!hs.fs.attributes(path)) hs.fs.write(path, "");
	Term.summon("journal", "hx " + Term.shellQuote(path));
}

// ============================================================
// MENU TREE
// ============================================================

export const menuTree: MenuItem[] = [
	{
		key: "t",
		label: "Alacritty",
		action: { kind: "app", bundleID: APP_BUNDLE_IDS.alacritty },
	},

	{
		key: "r",
		label: "Resize window",
		icon: symbol("rectangle.split.3x3.fill"),
		action: {
			kind: "submenu",
			submenu: [
				{
					key: "h",
					label: "Left 1/3",
					icon: symbol("inset.filled.leftthird.rectangle"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(1 / 3, "left"),
					},
				},
				{
					key: "l",
					label: "Right 1/3",
					icon: symbol("inset.filled.trailingthird.rectangle"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(1 / 3, "right"),
					},
				},
				{
					key: "j",
					label: "Left 2/3",
					icon: symbol("inset.filled.lefthalf.rectangle"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(2 / 3, "left"),
					},
				},
				{
					key: "k",
					label: "Right 2/3",
					icon: symbol("inset.filled.righthalf.rectangle"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(2 / 3, "right"),
					},
				},
				{
					key: "m",
					label: "Maximize",
					icon: symbol("inset.filled.rectangle"),
					action: { kind: "callback", run: maximizeFocusedWindow },
				},
				{
					key: ",",
					label: "Center 2/3",
					icon: symbol("inset.filled.center.rectangle"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(2 / 3, "center"),
					},
				},
				{
					key: ".",
					label: "Center 1/2",
					icon: symbol("inset.filled.rectangle.portrait"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(1 / 2, "center"),
					},
				},
				{
					key: "H",
					label: "Left 1/2",
					icon: symbol("inset.filled.lefthalf.rectangle"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(1 / 2, "left"),
					},
				},
				{
					key: "L",
					label: "Right 1/2",
					icon: symbol("inset.filled.righthalf.rectangle"),
					action: {
						kind: "callback",
						run: () => setWindowFrame(1 / 2, "right"),
					},
				},
				{
					key: "f",
					label: "Full screen",
					icon: symbol("arrow.up.backward.and.arrow.down.forward.rectangle"),
					action: { kind: "callback", run: toggleFullScreenFocusedWindow },
				},
			],
		},
	},

	{
		key: "b",
		label: "Zen Browser",
		action: { kind: "app", bundleID: APP_BUNDLE_IDS.zenBrowser },
	},

	{
		key: "f",
		label: "Hide others",
		icon: symbol("rectangle.and.hand.point.up.left"),
		action: { kind: "callback", run: hideOtherApps },
	},

	{
		key: "s",
		label: "Screenshots",
		icon: symbol("camera"),
		action: {
			kind: "submenu",
			submenu: [
				{
					key: "y",
					label: "Screenshot",
					icon: symbol("circle.rectangle.dashed"),
					action: {
						kind: "cmd",
						path: "/usr/sbin/screencapture",
						args: ["-ci"],
					},
				},
				{
					key: "a",
					label: "Show app",
					icon: symbol("app.badge"),
					action: { kind: "url", url: "shottr://show" },
				},
				{
					key: "s",
					label: "Area screenshot",
					icon: symbol("viewfinder"),
					action: { kind: "url", url: "shottr://grab/area?then=copy" },
				},
				{
					key: "r",
					label: "repeat screenshot then edit",
					icon: symbol("viewfinder"),
					action: { kind: "url", url: "shottr://grab/repeat?then=edit" },
				},
				{
					key: "w",
					label: "Window screenshot",
					icon: symbol("macwindow.badge.plus"),
					action: { kind: "url", url: "shottr://grab/window" },
				},
			],
		},
	},

	{
		key: "e",
		label: "Pick emoji",
		icon: symbol("face.smiling"),
		action: {
			kind: "url",
			url: "raycast://extensions/raycast/emoji-symbols/search-emoji-symbols",
		},
	},

	{
		key: "E",
		label: "Pick emoji (native)",
		icon: symbol("face.smiling"),
		action: { kind: "chooser", spec: () => eraseChooser(EmojiPicker.spec()) },
	},

	{
		key: "d",
		label: "Apps",
		icon: symbol("macwindow"),
		action: {
			kind: "submenu",
			submenu: [
				appItem("t", "Telegram", APP_BUNDLE_IDS.telegram),
				appItem("z", "Zed", APP_BUNDLE_IDS.zed),
				appItem("a", "Arc", APP_BUNDLE_IDS.arc),
				appItem("v", "VS Code", APP_BUNDLE_IDS.vscode),
				appItem("m", "Messages", APP_BUNDLE_IDS.messages),
				appItem("s", "Safari", APP_BUNDLE_IDS.safari),
				appItem("b", "Bear", APP_BUNDLE_IDS.bear),
				appItem("p", "1Password", APP_BUNDLE_IDS.onePassword),
				appItem("e", "ElegooSlicer", APP_BUNDLE_IDS.elegooSlicer),
				appItem("c", "FreeCAD", APP_BUNDLE_IDS.freeCAD),
			],
		},
	},

	{
		key: "m",
		label: "Search menu items",
		icon: symbol("menucard"),
		action: { kind: "chooser", spec: () => MenuItemSearch.spec() },
	},

	{
		key: "/",
		label: "Open or focus app",
		icon: symbol("magnifyingglass"),
		action: { kind: "chooser", spec: () => eraseChooser(AppPicker.spec()) },
	},

	{
		key: " ",
		label: "Switch app",
		icon: symbol("rectangle.stack"),
		action: { kind: "chooser", spec: () => eraseChooser(AppSwitcher.spec()) },
	},

	{
		key: "v",
		label: "Clipboard history",
		icon: symbol("doc.on.clipboard"),
		action: { kind: "chooser", spec: () => eraseChooser(ClipboardHistory.spec()) },
	},

	{
		key: "p",
		label: "Process explorer",
		icon: symbol("cpu"),
		action: { kind: "chooser", spec: () => ProcessExplorer.spec() },
	},

	{
		key: "a",
		label: "Arc actions",
		// Real app icon, matching the original Leader Key config's iconPath
		// (a plain .app path there resolves to the app's own icon).
		icon: HSImage.fromAppBundle(APP_BUNDLE_IDS.arc) ?? undefined,
		action: {
			kind: "submenu",
			submenu: [
				{
					key: "a",
					label: "Select space",
					icon: symbol("list.star"),
					action: {
						kind: "url",
						url: "raycast://extensions/the-browser-company/arc/search-spaces",
					},
				},
				{
					key: "s",
					label: "Search tab",
					icon: symbol("filemenu.and.selection"),
					action: {
						kind: "url",
						url: "raycast://extensions/the-browser-company/arc/search-tabs",
					},
				},
				{
					key: "t",
					label: "new tab",
					icon: symbol("plus.square.fill.on.square.fill"),
					action: {
						kind: "url",
						url: "raycast://extensions/the-browser-company/arc/new-tab?arguments=%7B%22space%22%3A%22%22%2C%22url%22%3A%22%22%7D",
					},
				},
			],
		},
	},

	{
		key: "u",
		label: "Utilities",
		icon: symbol("ellipsis"),
		action: {
			kind: "submenu",
			submenu: [
				{
					key: "m",
					label: "Music",
					action: {
						kind: "submenu",
						submenu: [
							{
								key: ",",
								label: "Play/Pause",
								action: {
									kind: "url",
									url: "raycast://extensions/fedevitaledev/music/toggle-play-pause",
								},
							},
						],
					},
				},
				{
					key: "g",
					label: "View google cal event",
					icon: symbol("calendar"),
					action: {
						kind: "url",
						url: "raycast://extensions/thomas/google-calendar/list-events",
					},
				},
				{
					key: "x",
					label: "Tuxedo",
					icon: symbol("terminal"),
					action: {
						kind: "callback",
						run: () => Term.summon("tuxedo", "tuxedo"),
					},
				},
				{
					key: "n",
					label: "Nushell",
					icon: symbol("terminal"),
					action: {
						kind: "callback",
						run: () => Term.summon("nu", undefined, " --shell nu"),
					},
				},
				{
					key: "y",
					label: "Yazi",
					icon: symbol("folder"),
					action: {
						kind: "callback",
						run: () =>
							Term.summon(
								"yazi",
								"yazi",
								" --cwd " + Term.shellQuote(hs.fs.homeDirectory()),
							),
					},
				},
				{
					key: "h",
					label: "Find file (Helix)",
					icon: symbol("doc.text.magnifyingglass"),
					action: {
						kind: "callback",
						run: () => {
							Term.pick("file-picker", "fzf", "~/work", (picked) => {
								// fzf's default output is relative to its --cwd; only
								// prefix with ~/work if the report didn't already give an
								// absolute (or ~-relative) path.
								const path = /^[~/]/.test(picked) ? picked : "~/work/" + picked;
								Term.summon("helix", "hx " + Term.shellQuote(path));
							});
						},
					},
				},
				{
					key: "d",
					label: "Daily note",
					icon: symbol("note.text"),
					action: { kind: "callback", run: openDailyNote },
				},
				{
					key: "q",
					label: "Quick note",
					icon: symbol("square.and.pencil"),
					action: { kind: "chooser", spec: () => eraseChooser(QuickNote.spec()) },
				},
				{
					key: "c",
					label: "Clear clipboard history",
					icon: symbol("trash"),
					action: { kind: "callback", run: () => ClipboardHistory.clear() },
				},
				{
					key: "r",
					label: "Reload config",
					icon: symbol("arrow.clockwise"),
					action: { kind: "callback", run: () => hs.reload() },
				},
			],
		},
	},

	ZellijMenu.node,
];
