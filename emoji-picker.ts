// Native emoji picker, driven by hs.chooser and themed to match the
// leader menu. Port of emoji-picker.lua.
//
// v1 sourced its dataset from the bundled "Emojis" Spoon -- v1 Spoons are
// plain Lua and don't load into v2's JS runtime, so this port instead
// pulls from the unicode-emoji-json npm package (keyed by the emoji
// character itself, with name/group/version metadata), bundled directly
// into init.js by esbuild at build time. See emoji-data.d.ts for its
// hand-written ambient type.
//
// v1's refocus-previous-window trick used hs.window.filter (absent in
// v2) purely because a handle to it was lying around (the Emojis Spoon's
// own); it never needed the "sorted by last-focused" query that implies.
// Snapshotting hs.window.focusedWindow() right before the chooser steals
// focus does the same job with less.

import { Theme, chooserColor } from "./nord-theme";
import emojiData from "unicode-emoji-json/data-by-emoji.json";

const FREQUENCY_KEY = "emojiPicker.frequency";
const FREQUENT_PIN_COUNT = 12; // how many top-frequency emoji get pinned to the top

// Rendered oversized (vs. the ~16-20pt hs.chooser actually displays) so it
// stays crisp once the chooser scales it down on a Retina display.
const EMOJI_IMAGE_SIZE = 64;

interface EmojiChoice {
  text: string;
  subText?: string;
  char: string;
  image: HSImage | null;
}

// hs.chooser rows have no "render this unicode character" primitive --
// `image` wants a real HSImage. Rasterizing each emoji via a throwaway
// hs.canvas (never shown on screen; imageFromCanvas() works regardless)
// is the only way to get one. Memoized since it's the same ~64x64 bitmap
// every time a given emoji is shown again, across every show() call.
const imageCache = new Map<string, HSImage | null>();

function emojiImage(char: string): HSImage | null {
  const cached = imageCache.get(char);
  if (cached !== undefined) return cached;

  const c = hs.canvas.create({ x: 0, y: 0, w: EMOJI_IMAGE_SIZE, h: EMOJI_IMAGE_SIZE });
  c.appendElements([
    {
      type: "text",
      text: char,
      textSize: EMOJI_IMAGE_SIZE * 0.75,
      textAlignment: "center",
      frame: { x: 0, y: 0, w: EMOJI_IMAGE_SIZE, h: EMOJI_IMAGE_SIZE },
    },
  ]);
  const image = c.imageFromCanvas();
  c.destroy();
  imageCache.set(char, image);
  return image;
}

let chooser: HSChooser | null = null;
let allChoices: EmojiChoice[] = []; // built once from emojiData, cached for the session

function loadFrequency(): Record<string, number> {
  return (hs.userdefaults.get(FREQUENCY_KEY) as Record<string, number> | null) ?? {};
}

function onSelect(choice: Record<string, unknown> | null, previouslyFocused: HSWindow | null): void {
  if (!choice) return;

  const char = choice["char"] as string;
  // Deferred: onSelect fires while the chooser is still in the middle of
  // hiding (which itself restores focus to the previously active window),
  // so focusing + pasting synchronously right here races that handoff.
  // One tick later both have settled.
  //
  // Paste via the clipboard rather than hs.eventtap.keyStrokes(char):
  // nearly every emoji is outside the BMP (a UTF-16 surrogate pair), and
  // keystroke-synthesis APIs that iterate a string one UTF-16 unit at a
  // time choke on that -- each half is an invalid lone surrogate on its
  // own, so nothing gets typed. The clipboard has no such limit.
  hs.timer.doAfter(0, () => {
    previouslyFocused?.focus();
    const savedClipboard = hs.pasteboard.readString();
    hs.pasteboard.writeString(char);
    hs.eventtap.keyStroke(["cmd"], "v");
    hs.timer.doAfter(0.3, () => {
      if (savedClipboard !== null) hs.pasteboard.writeString(savedClipboard);
      else hs.pasteboard.clear();
    });
  });

  const freq = loadFrequency();
  freq[char] = (freq[char] ?? 0) + 1;
  hs.userdefaults.set(FREQUENCY_KEY, freq);
}

function loadDataset(): EmojiChoice[] {
  return Object.entries(emojiData).map(([char, meta]) => ({
    text: meta.name,
    subText: meta.group,
    char,
    image: emojiImage(char),
  }));
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
