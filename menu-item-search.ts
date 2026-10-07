// Native "Search Menu Items", Raycast-style: fuzzy-search the frontmost
// app's entire menu bar and invoke whichever one is picked. Port of
// menu-item-search.lua.
//
// v2's `app.getMenuItems()` returns a simpler `{title, items}` tree
// (confirmed synchronous, no callback needed -- a nice simplification
// over v1's async AX walk) instead of v1's raw AX dictionaries, so the
// AXChildren/AXEnabled/AXMenuItemCmdChar+Glyph/menuGlyphs shortcut-symbol
// rendering v1 built is gone -- v2's public API doesn't expose that detail
// (hs.application.menuGlyphs has no v2 equivalent at all), and this just
// flattens title paths without a shortcut hint.

import { eraseChooser, type ChooserSpec } from "./chooser-runtime";

interface RawMenuItem {
  title?: string;
  enabled?: boolean;
  items?: RawMenuItem[];
}

interface MenuChoice {
  text: string;
  subText?: string;
  path: string[];
}

// Recurses into containers without emitting a row for them; only emits
// leaves. An item missing the `enabled` field is treated as enabled --
// v2's docs don't guarantee every item carries it, and an occasional
// no-op click is a smaller problem than hiding a real item over an
// unconfirmed field.
function flatten(items: RawMenuItem[] | undefined, ancestorTitles: string[], out: MenuChoice[]): void {
  for (const item of items ?? []) {
    const title = item.title;
    if (!title) continue;

    if (item.items && item.items.length > 0) {
      flatten(item.items, [...ancestorTitles, title], out);
    } else if (item.enabled !== false) {
      out.push({
        text: title,
        subText: ancestorTitles.length > 0 ? ancestorTitles.join(" → ") : undefined,
        path: [...ancestorTitles, title],
      });
    }
  }
}

// A chooser always gets shown once a "chooser" MenuAction fires -- there's
// no "don't open anything" signal in that contract -- so the "no
// frontmost app"/"no menu items" cases that used to just silently no-op
// now show a single informational row instead.
//
// This module's spec() returns the already-*erased* ChooserSpec (unlike
// every other chooser module, which returns a typed ChooserSpec<T> and
// leaves erasing to leader-menu-config.ts's call site) because the two
// branches below have genuinely different row shapes -- there's no single
// T to parametrize the function's own return type over.
function informationalSpec(message: string): ChooserSpec {
  return eraseChooser<{ text: string }>({
    choices: [{ text: message }],
    onSelect: () => {},
  });
}

export function spec(): ChooserSpec {
  const app = hs.application.frontmost();
  if (!app) return informationalSpec("No frontmost app");

  hs.ui.alert("Loading menu items…").duration(1).show();
  const menuItems = app.getMenuItems() as RawMenuItem[] | null;
  const choices: MenuChoice[] = [];
  // Top-level menu 0 is always the bolded app-name menu (About/Preferences/
  // Services/Hide/Quit) -- boilerplate that's identical in shape across every
  // app and never what you're searching for, so it's dropped rather than
  // flattened alongside the app's real menus (File, Edit, ...).
  if (menuItems) flatten(menuItems.slice(1), [], choices);
  if (choices.length === 0) return informationalSpec("No menu items found");

  return eraseChooser<MenuChoice>({
    choices,
    visibleRows: 9,
    width: 0.35,
    searchSubText: true,
    placeholder: "Filter by menu item title…",
    onSelect: (choice) => {
      app.selectMenuItemByPath(choice.path);
    },
  });
}
