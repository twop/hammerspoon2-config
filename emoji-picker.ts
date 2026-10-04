// Native emoji picker, driven by hs.chooser and themed to match the
// leader menu. Port of emoji-picker.lua.
//
// v1 sourced its dataset from the bundled "Emojis" Spoon (used only for
// its parsed emojis.json, never its own chooser/hotkeys) -- v1 Spoons are
// plain Lua and don't load into v2's JS runtime, and this port hasn't
// re-derived that Spoon's exact on-disk JSON schema, so loadDataset()
// below reads a file of the documented EmojiChoice[] shape directly.
// Point EMOJI_DATA_PATH at a real file matching it before relying on this.
//
// v1's refocus-previous-window trick used hs.window.filter (absent in
// v2) purely because a handle to it was lying around (the Emojis Spoon's
// own); it never needed the "sorted by last-focused" query that implies.
// Snapshotting hs.window.focusedWindow() right before the chooser steals
// focus does the same job with less.

import { Theme, chooserColor } from "./nord-theme";

const FREQUENCY_KEY = "emojiPicker.frequency";
const FREQUENT_PIN_COUNT = 12; // how many top-frequency emoji get pinned to the top
const EMOJI_DATA_PATH = hs.fs.homeDirectory() + "/.hammerspoon/v2/emojis.json";

interface EmojiChoice {
  text: string;
  subText?: string;
  char: string;
}

let chooser: HSChooser | null = null;
let allChoices: EmojiChoice[] = []; // built once from EMOJI_DATA_PATH, cached for the session

function loadFrequency(): Record<string, number> {
  return (hs.userdefaults.get(FREQUENCY_KEY) as Record<string, number> | null) ?? {};
}

function onSelect(choice: Record<string, unknown> | null, previouslyFocused: HSWindow | null): void {
  previouslyFocused?.focus();
  if (!choice) return;

  const char = choice["char"] as string;
  hs.eventtap.keyStrokes(char);

  const freq = loadFrequency();
  freq[char] = (freq[char] ?? 0) + 1;
  hs.userdefaults.set(FREQUENCY_KEY, freq);
}

function loadDataset(): EmojiChoice[] {
  const attrs = hs.fs.attributes(EMOJI_DATA_PATH) as { size?: number } | null;
  if (!attrs?.size) return [];
  const contents = hs.fs.read(EMOJI_DATA_PATH, 0, attrs.size);
  if (!contents) return [];
  try {
    return JSON.parse(contents) as EmojiChoice[];
  } catch {
    return [];
  }
}

function ensureLoaded(): void {
  if (chooser) return;
  allChoices = loadDataset();

  chooser = hs.chooser.create();
  chooser.visibleRows = 9;
  chooser.width = 0.3;
  chooser.searchSubText = true;
  chooser.placeholder = "Search emoji…";
  chooser.backgroundColor = chooserColor(Theme.background);
  chooser.borderColor = chooserColor(Theme.border);
  chooser.cornerRadius = Theme.cornerRadius;
  chooser.textColor = chooserColor(Theme.text);
  chooser.subTextColor = chooserColor(Theme.textDim);
}

// Pins the top FREQUENT_PIN_COUNT most-picked emoji (count > 0) to the
// front, ranked by descending pick count; everything else keeps the
// dataset's original order below. Recomputed on every show() -- cheap, it's
// just sorting/filtering the already-parsed in-memory list.
function buildRankedChoices(): EmojiChoice[] {
  const freq = loadFrequency();
  const frequent = allChoices.filter((c) => (freq[c.char] ?? 0) > 0);
  const rest = allChoices.filter((c) => (freq[c.char] ?? 0) <= 0);
  frequent.sort((a, b) => (freq[b.char] ?? 0) - (freq[a.char] ?? 0));

  // Overflow beyond the pinned cap: still frequency-sorted, just appended
  // at the very end rather than mixed into the unranked middle.
  return [...frequent.slice(0, FREQUENT_PIN_COUNT), ...rest, ...frequent.slice(FREQUENT_PIN_COUNT)];
}

export function show(): void {
  ensureLoaded();
  const c = chooser!;

  const previouslyFocused = hs.window.focusedWindow();
  c.onSelect = (choice) => onSelect(choice, previouslyFocused);

  c.setChoices(buildRankedChoices());
  c.query = ""; // hs.chooser keeps the previous query across show() calls
  c.show();
}
