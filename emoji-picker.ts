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

import emojiData from "unicode-emoji-json/data-by-emoji.json";
import type { ChoiceOption } from "./chooser-options-bar";
import type { ChooserSpec } from "./chooser-runtime";
import { Canvas } from "./canvas";

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

// Legend for the options bar: Enter/click is the chooser's own native
// select behavior (paste), shown here display-only since it's not a
// shortcut this file intercepts -- ⌘⇧C is the one real addition, copying
// without pasting (and without closing the chooser, unlike app-switcher.ts's
// options -- picking several emoji to copy in a row is a reasonable thing
// to want, and nothing about the row goes stale the way a quit/hide does).
function emojiOptions(char: string): ChoiceOption[] {
	return [
		{ keyGlyph: "⏎", label: "Paste" },
		{
			mods: ["cmd", "shift"],
			key: "c",
			label: "Copy",
			run: () => {
				hs.pasteboard.writeString(char);
				hs.ui.alert(`Copied ${char}`).duration(0.6).show();
			},
		},
	];
}

// hs.chooser rows have no "render this unicode character" primitive --
// `image` wants a real HSImage. Rasterizing each emoji via a throwaway
// hs.canvas (never shown on screen; imageFromCanvas() works regardless)
// is the only way to get one. Memoized since it's the same ~64x64 bitmap
// every time a given emoji is shown again, across every spec() call.
const imageCache = new Map<string, HSImage | null>();

function emojiImage(char: string): HSImage | null {
	const cached = imageCache.get(char);
	if (cached !== undefined) return cached;

	const c = hs.canvas.create({
		x: 0,
		y: 0,
		w: EMOJI_IMAGE_SIZE,
		h: EMOJI_IMAGE_SIZE,
	});
	c.appendElements([
		Canvas.text(char, {
			textSize: EMOJI_IMAGE_SIZE * 0.75,
			textAlignment: "center",
			frame: { x: 0, y: 0, w: EMOJI_IMAGE_SIZE, h: EMOJI_IMAGE_SIZE },
		}),
	]);
	const image = c.imageFromCanvas();
	c.destroy();
	imageCache.set(char, image);
	return image;
}

let allChoices: EmojiChoice[] = []; // built once from emojiData, cached for the session

function loadFrequency(): Record<string, number> {
	return (
		(hs.userdefaults.get(FREQUENCY_KEY) as Record<string, number> | null) ?? {}
	);
}

function onSelect(choice: EmojiChoice, previouslyFocused: HSWindow | null): void {
	const char = choice.char;
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

// Pins the top FREQUENT_PIN_COUNT most-picked emoji (count > 0) to the
// front, ranked by descending pick count; everything else keeps the
// dataset's original order below. Recomputed on every spec() -- cheap,
// it's just sorting/filtering the already-parsed in-memory list.
function buildRankedChoices(): EmojiChoice[] {
	if (allChoices.length === 0) allChoices = loadDataset();
	const freq = loadFrequency();
	const frequent = allChoices.filter((c) => (freq[c.char] ?? 0) > 0);
	const rest = allChoices.filter((c) => (freq[c.char] ?? 0) <= 0);
	frequent.sort((a, b) => (freq[b.char] ?? 0) - (freq[a.char] ?? 0));

	// Overflow beyond the pinned cap: still frequency-sorted, just appended
	// at the very end rather than mixed into the unranked middle.
	return [
		...frequent.slice(0, FREQUENT_PIN_COUNT),
		...rest,
		...frequent.slice(FREQUENT_PIN_COUNT),
	];
}

export function spec(): ChooserSpec<EmojiChoice> {
	const previouslyFocused = hs.window.focusedWindow();
	return {
		choices: buildRankedChoices(),
		visibleRows: 9,
		width: 0.3,
		searchSubText: true,
		placeholder: "Search emoji…",
		onSelect: (choice) => onSelect(choice, previouslyFocused),
		optionsBar: (row) => emojiOptions(row.char),
	};
}
