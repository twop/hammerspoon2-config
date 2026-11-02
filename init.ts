// Source for init.js, which Hammerspoon 2 actually loads. Run `npm run build`
// (or `npm run watch`) to bundle this file and its imports into init.js via
// esbuild. Port of init.lua.

import * as Term from "./termview";
import * as LeaderMenu from "./leader-menu";
import { menuTree } from "./leader-menu-config";
import * as ZellijMenu from "./zellij-menu";

// Hyper is provided at the hardware level by the keyboard, sending
// Cmd+Ctrl+Option+Shift.
const hyper = ["cmd", "alt", "ctrl", "shift"];

// Hotkeys must be kept alive for as long as the config runs -- hs.hotkey.bind()
// return values that aren't retained anywhere get garbage collected and silently
// stop firing, with no exception.
const hotkeys = [
	hs.hotkey.bind(hyper, "t", () => Term.summon("tuxedo", "tuxedo"), null),
	hs.hotkey.bind(
		hyper,
		"y",
		() =>
			Term.summon(
				"yazi",
				"yazi",
				` --cwd ${Term.shellQuote(hs.fs.homeDirectory())}`,
			),
		null,
	),
	// LEADER MENU (Hyper+M) -- LeaderKey-style popup.
	hs.hotkey.bind(hyper, "space", () => LeaderMenu.show(menuTree), null),
	// ZELLIJ MENU (Hyper+G) -- the leader menu's "j" submenu, opened directly.
	// Its items need a zj_hs_jump state fetch first, so the menu shows once
	// that resolves.
	hs.hotkey.bind(
		hyper,
		"g",
		() => void ZellijMenu.items().then((items) => LeaderMenu.show(items)),
		null,
	),
];
