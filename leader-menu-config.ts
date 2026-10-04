// The Hyper+M menu tree itself. Port of leader-menu-config.lua --
// leader-menu.ts is the generic engine; this file is its only consumer.
//
// Icons are Nerd Font glyphs, same as v1 (no SF Symbols support here
// either) -- built with String.fromCodePoint() instead of v1's
// hs.utf8.codepointToUTF8 (no hs.utf8 module in v2; plain JS covers it).
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
import * as ProcessExplorer from "./process-explorer";
import * as Term from "./termview";
import * as ZellijMenu from "./zellij-menu";
import type { MenuItem } from "./leader-menu";

function icon(codepoint: number): string {
  return String.fromCodePoint(codepoint);
}

const APP_BUNDLE_IDS = {
  zed: "dev.zed.Zed",
  arc: "company.thebrowser.Browser",
  telegram: "ru.keepcoder.Telegram",
  vscode: "com.microsoft.VSCode",
  messages: "com.apple.MobileSMS",
  safari: "com.apple.Safari",
  bear: "net.shinyfrog.bear",
  onePassword: "com.1password.1password",
  zenBrowser: "app.zen-browser.zen",
} as const;

function appItem(key: string, label: string, bundleID: string): MenuItem {
  return { key, label, action: { kind: "app", bundleID } };
}

// ============================================================
// WINDOW RESIZING
// ============================================================

function setWindowFrame(widthFraction: number, position: "left" | "right" | "center"): void {
  const win = hs.window.focusedWindow();
  if (!win) return;
  const screenFrame = win.screen?.frame;
  if (!screenFrame) return;
  const width = screenFrame.w * widthFraction;

  let x = screenFrame.x;
  if (position === "right") x = screenFrame.x + screenFrame.w - width;
  else if (position === "center") x = screenFrame.x + (screenFrame.w - width) / 2;

  win.frame = { x, y: screenFrame.y, w: width, h: screenFrame.h } as HSRect;
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
// DAILY JOURNAL NOTE
// ============================================================

function dailyNotePath(): { path: string; dir: string } {
  const now = new Date();
  const mon = now.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = String(now.getDate()).padStart(2, "0");
  const dow = now.toLocaleString("en-US", { weekday: "short" }).toLowerCase();
  const dir = `${hs.fs.homeDirectory()}/work/journal/${mon}`;
  return { path: `${dir}/${day}-${dow}.md`, dir };
}

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
  { key: "t", label: "Alacritty", action: { kind: "app", bundleID: "io.alacritty" } },

  {
    key: "r",
    label: "Resize window",
    icon: icon(0xf009), // th-large
    action: {
      kind: "submenu",
      submenu: [
        { key: "h", label: "Left 1/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 3, "left") } },
        { key: "l", label: "Right 1/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 3, "right") } },
        { key: "j", label: "Left 2/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(2 / 3, "left") } },
        { key: "k", label: "Right 2/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(2 / 3, "right") } },
        { key: "m", label: "Maximize", icon: icon(0xf2d0), action: { kind: "callback", run: maximizeFocusedWindow } },
        { key: ",", label: "Center 2/3", icon: "?", action: { kind: "callback", run: () => setWindowFrame(2 / 3, "center") } },
        { key: ".", label: "Center 1/2", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 2, "center") } },
        { key: "H", label: "Left 1/2", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 2, "left") } },
        { key: "L", label: "Right 1/2", icon: "?", action: { kind: "callback", run: () => setWindowFrame(1 / 2, "right") } },
        { key: "f", label: "Full screen", icon: icon(0xf065), action: { kind: "callback", run: toggleFullScreenFocusedWindow } },
      ],
    },
  },

  { key: "b", label: "Zen Browser", action: { kind: "app", bundleID: APP_BUNDLE_IDS.zenBrowser } },

  {
    key: "f",
    label: "Hide others",
    icon: icon(0xf0a6), // hand-o-up
    action: { kind: "url", url: "raycast://extensions/raycast/system/hide-all-apps-except-frontmost" },
  },

  {
    key: "s",
    label: "Screenshots",
    icon: icon(0xf030), // camera
    action: {
      kind: "submenu",
      submenu: [
        { key: "y", label: "Screenshot", icon: icon(0xf030), action: { kind: "cmd", path: "/usr/sbin/screencapture", args: ["-ci"] } },
        { key: "a", label: "Show app", icon: "?", action: { kind: "url", url: "shottr://show" } },
        { key: "s", label: "Area screenshot", icon: icon(0xf125), action: { kind: "url", url: "shottr://grab/area?then=copy" } },
        { key: "r", label: "repeat screenshot then edit", icon: icon(0xf125), action: { kind: "url", url: "shottr://grab/repeat?then=edit" } },
        { key: "w", label: "Window screenshot", icon: icon(0xf2d2), action: { kind: "url", url: "shottr://grab/window" } },
      ],
    },
  },

  {
    key: "e",
    label: "Pick emoji",
    icon: icon(0xf118), // smile-o
    action: { kind: "url", url: "raycast://extensions/raycast/emoji-symbols/search-emoji-symbols" },
  },

  {
    key: "E",
    label: "Pick emoji (native)",
    icon: icon(0xf118),
    action: { kind: "callback", run: () => EmojiPicker.show() },
  },

  {
    key: "d",
    label: "Apps",
    icon: icon(0xf108), // desktop
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
      ],
    },
  },

  {
    key: "m",
    label: "Search menu items",
    icon: icon(0xf0c9), // bars
    action: { kind: "callback", run: () => MenuItemSearch.show() },
  },

  {
    key: "/",
    label: "Open or focus app",
    icon: icon(0xf002), // search
    action: { kind: "callback", run: () => AppPicker.show() },
  },

  {
    key: "p",
    label: "Process explorer",
    icon: icon(0xf0e8), // sitemap
    action: { kind: "callback", run: () => void ProcessExplorer.show() },
  },

  {
    key: "a",
    label: "Arc actions",
    icon: icon(0xf005), // star (no bundle icon lookup here, unlike v1's hs.image.iconForFile(path) -- v2's icon
    // path needs the resolved .app path, which this config doesn't look up for icon-only purposes
    action: {
      kind: "submenu",
      submenu: [
        { key: "a", label: "Select space", icon: icon(0xf005), action: { kind: "url", url: "raycast://extensions/the-browser-company/arc/search-spaces" } },
        { key: "s", label: "Search tab", icon: icon(0xf002), action: { kind: "url", url: "raycast://extensions/the-browser-company/arc/search-tabs" } },
        {
          key: "t",
          label: "new tab",
          icon: icon(0xf0fe),
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
    icon: icon(0xf141), // ellipsis-h
    action: {
      kind: "submenu",
      submenu: [
        {
          key: "m",
          label: "Music",
          action: {
            kind: "submenu",
            submenu: [
              { key: ",", label: "Play/Pause", action: { kind: "url", url: "raycast://extensions/fedevitaledev/music/toggle-play-pause" } },
            ],
          },
        },
        {
          key: "g",
          label: "View google cal event",
          icon: icon(0xf073), // calendar
          action: { kind: "url", url: "raycast://extensions/thomas/google-calendar/list-events" },
        },
        {
          key: "x",
          label: "Tuxedo",
          icon: icon(0xf120), // terminal
          action: { kind: "callback", run: () => Term.summon("tuxedo", "tuxedo") },
        },
        {
          key: "n",
          label: "Nushell",
          icon: icon(0xf120),
          action: { kind: "callback", run: () => Term.summon("nu", undefined, " --shell nu") },
        },
        {
          key: "y",
          label: "Yazi",
          icon: icon(0xf120),
          action: {
            kind: "callback",
            run: () => Term.summon("yazi", "yazi", " --cwd " + Term.shellQuote(hs.fs.homeDirectory())),
          },
        },
        {
          key: "h",
          label: "Find file (Helix)",
          icon: icon(0xf120),
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
          icon: icon(0xf120),
          action: { kind: "callback", run: openDailyNote },
        },
        {
          key: "r",
          label: "Reload config",
          icon: icon(0xf021), // refresh
          action: { kind: "callback", run: () => hs.reload() },
        },
      ],
    },
  },

  ZellijMenu.node,
];
