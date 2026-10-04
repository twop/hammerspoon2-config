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

import { Theme, chooserColor } from "./nord-theme";

let chooser: HSChooser | null = null;
let currentApp: HSApplication | null = null; // captured fresh at the top of every show(), used by onSelect

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

function ensureLoaded(): void {
  if (chooser) return;

  chooser = hs.chooser.create();
  chooser.visibleRows = 9;
  chooser.width = 0.35;
  chooser.searchSubText = true;
  chooser.placeholder = "Filter by menu item title…";
  chooser.backgroundColor = chooserColor(Theme.background);
  chooser.borderColor = chooserColor(Theme.border);
  chooser.cornerRadius = Theme.cornerRadius;
  chooser.textColor = chooserColor(Theme.text);
  chooser.subTextColor = chooserColor(Theme.textDim);
  chooser.onSelect = (choice) => {
    if (choice && currentApp) currentApp.selectMenuItemByPath(choice["path"] as string[]);
  };
}

export function show(): void {
  // Capture before ensureLoaded()/chooser.show() steal frontmost-app status.
  const app = hs.application.frontmost();
  if (!app) return;
  currentApp = app;

  ensureLoaded();
  hs.ui.alert("Loading menu items…").duration(1).show();

  const menuItems = app.getMenuItems() as RawMenuItem[] | null;
  if (!menuItems) return;

  const choices: MenuChoice[] = [];
  flatten(menuItems, [], choices);
  if (choices.length === 0) return;

  const c = chooser!;
  c.setChoices(choices);
  c.query = ""; // hs.chooser keeps the previous query across show() calls
  c.show();
}
