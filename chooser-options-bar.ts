// Per-row shortcut hints for hs.chooser pickers. A chooser row can only
// ever do one thing via onSelect -- this bolts on extra actions ("options")
// for whichever row is currently highlighted, shown as a small fixed-
// position canvas bar and triggered by a dedicated modifier-key eventtap.
//
// hs.chooser has no frame/position getter (so this can't be positioned
// relative to the chooser's real on-screen panel) and no selection-changed
// event (so reacting to the highlighted row changing means polling
// selectedRowContents() on a timer) -- both confirmed by a full read of
// its class declaration. Positioned at a fixed spot (bottom-center of the
// primary screen) instead of attempting to discover the chooser's actual
// frame.
//
// A JS function stuffed into a custom choice field does NOT survive
// setChoices()/selectedRowContents()'s native round-trip as a callable
// function -- confirmed by testing: label/subText/image/plain-data custom
// fields all come back fine, but a `run: () => ...` closure came back as
// some inert boxed object ("TypeError: opt.run is not a function ... is
// an instance of Object"). Only the dedicated callback-typed properties
// (onSelect, onShow, onHide, ...) get real function bridging. So instead
// of putting ChoiceOption[] directly on the choice dict, callers pass a
// getOptionsForRow() that re-derives the options fresh, in JS, from
// whatever plain-data fields *did* survive (e.g. a bundleID or index) --
// never crossing the bridge with a live closure at all.

import { Theme, canvasColor } from "./nord-theme";
import { flipFrameY } from "./screen-geometry";
import { Canvas, cornerRadii, type CanvasElement } from "./canvas";

export interface ChoiceOption {
	// Omit mods/key/run for a display-only legend entry (e.g. keyGlyph "⏎"
	// for a chooser's own native Enter-to-select behavior) -- shown in the
	// bar like any other option, but never matched by the shortcut tap.
	mods?: string[]; // modifier names, e.g. ["cmd"] -- matched against the generic subset of HSEventTapEvent.flags
	key?: string; // a hs.keycodes.map *name* (e.g. "q") or a CONTROL_KEYCODES name (e.g. "return") -- see keyMatches() below
	keyGlyph?: string; // chip glyph for a display-only entry (e.g. "⏎"); ignored when mods/key are set, which format their own
	label: string; // short text shown next to the chip, e.g. "Quit"
	run?: () => void;
}

const KEY_DOWN = hs.eventtap.eventTypes["keyDown"]!;
const POLL_INTERVAL_SECONDS = 0.1;
const BOTTOM_MARGIN_PX = 24;
const CHIP_PADDING_X = 7;
const CHIP_LABEL_GAP = 6;
const PAIR_GAP = 20;
const BAR_HEIGHT =
	Theme.paddingY * 2 + Theme.fontSize * Theme.textFrameHeightMultiplier;
const CHIP_HEIGHT = Theme.fontSize + 10;

// Fixed indices into every bar canvas's element list -- zero-size, never
// shown, kept around purely so minimumTextSize() always has a bold (chip)
// and a regular (label) text element to measure against, independent of
// whatever render() last put in the visible portion of the list.
const BOLD_RULER_INDEX = 0;
const REGULAR_RULER_INDEX = 1;

const MOD_SYMBOLS: Record<string, string> = {
	cmd: "⌘",
	shift: "⇧",
	alt: "⌥",
	ctrl: "⌃",
	fn: "fn",
};

// hs.keycodes.map names a handful of non-letter keys with full words
// ("return", "delete", ...) rather than a single character -- rendered as
// their conventional glyph instead of e.g. the literal word "DELETE".
const KEY_SYMBOLS: Record<string, string> = {
	return: "↵",
	delete: "⌫",
	escape: "⎋",
	tab: "⇥",
	space: "␣",
};

function keyDisplay(key: string): string {
	return KEY_SYMBOLS[key] ?? key.toUpperCase();
}

// The only modifier names that matter for matching -- HSEventTapEvent.flags
// can carry a side-specific entry (e.g. "leftCmd") alongside the generic
// one ("cmd") for the same physical key, per its own doc comment, so this
// filters those out before comparing against an option's declared mods.
const GENERIC_MODS = ["cmd", "shift", "alt", "ctrl", "fn"];

function genericMods(flags: string[]): Set<string> {
	return new Set(flags.filter((f) => GENERIC_MODS.includes(f)));
}

function modsMatch(required: string[], present: Set<string>): boolean {
	return (
		required.length === present.size && required.every((m) => present.has(m))
	);
}

// Apple's standard virtual keycodes for these function-area keys -- fixed
// across every keyboard layout, unlike letter/punctuation keys (whose
// keyCode->character mapping is layout-dependent). Compared directly
// rather than through hs.keycodes.map's name lookup (confirmed unreliable
// for "return" and "." by testing -- the same kind of gap that made
// leader-menu.ts's own key matching unreliable for "/") or event.characters
// (also confirmed unreliable for "return" specifically: holding Cmd
// alongside a key with no inherent glyph leaves nothing for AppKit to
// report as "the character", unlike a plain "." or letter key).
const CONTROL_KEYCODES: Record<string, number> = {
	return: 36,
	tab: 48,
	space: 49,
	delete: 51,
	escape: 53,
};

function keyMatches(
	optKey: string,
	event: HSEventTapEvent,
	keyName: string,
): boolean {
	const controlCode = CONTROL_KEYCODES[optKey];
	if (controlCode !== undefined) return event.keyCode === controlCode;
	if (optKey === keyName) return true;
	return event.characters === optKey;
}

function chipGlyph(opt: ChoiceOption): string {
	if (opt.mods && opt.key)
		return (
			opt.mods.map((m) => MOD_SYMBOLS[m] ?? m).join("") + keyDisplay(opt.key)
		);
	return opt.keyGlyph ?? "";
}

function barRect(width: number): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	const sf = hs.screen.primary()!.frame;
	return {
		x: sf.x + (sf.w - width) / 2,
		y: sf.y + sf.h - BAR_HEIGHT - BOTTOM_MARGIN_PX,
		w: width,
		h: BAR_HEIGHT,
	};
}

function rulerElements(): CanvasElement[] {
	return [
		Canvas.text("", {
			textWeight: "bold",
			textSize: Theme.fontSize,
			frame: { x: 0, y: 0, w: 1, h: 1 },
		}),

		Canvas.text("", {
			textSize: Theme.fontSize,
			frame: { x: 0, y: 0, w: 1, h: 1 },
		}),
	];
}

function backgroundElement(): CanvasElement {
	return Canvas.rectangle("strokeAndFill", {
		fillColor: canvasColor(Theme.background, Theme.backgroundAlpha),
		strokeColor: canvasColor(Theme.border),
		strokeWidth: Theme.borderWidth,
		roundedRectRadii: cornerRadii(Theme.cornerRadius),
	});
}

function buildBarCanvas(): HSCanvas {
	// Placeholder size -- render() immediately resizes this to fit real
	// content via setFrame() before it's ever shown.
	const c = hs.canvas.create(flipFrameY(barRect(200)));
	c.appendElements([...rulerElements(), backgroundElement()]);
	c.levelValue(hs.canvas.windowLevels["overlay"]!);
	c.clickActivating(false);
	return c;
}

// Sizes and positions the bar's own window to exactly fit its content
// (plus padding) rather than some fixed/guessed width -- avoids ever having
// to center content inside an arbitrarily wider box.
function render(bar: HSCanvas, options: ChoiceOption[]): void {
	const rowTextH = Theme.fontSize * Theme.textFrameHeightMultiplier;

	const segments = options.map((opt) => {
		const glyph = chipGlyph(opt);
		const chipTextSize = glyph
			? (bar.minimumTextSize(BOLD_RULER_INDEX, glyph) as {
					w: number;
					h: number;
				})
			: { w: 0, h: 0 };
		const labelSize = bar.minimumTextSize(REGULAR_RULER_INDEX, opt.label) as {
			w: number;
			h: number;
		};
		const chipW = glyph ? chipTextSize.w + CHIP_PADDING_X * 2 : 0;
		const pairW = chipW + (chipW ? CHIP_LABEL_GAP : 0) + labelSize.w;
		return { opt, glyph, chipW, labelW: labelSize.w, pairW };
	});

	const contentW =
		segments.reduce((sum, s) => sum + s.pairW, 0) +
		Math.max(0, segments.length - 1) * PAIR_GAP;
	const maxW = hs.screen.primary()!.frame.w * 0.9;
	const barWidth = Math.min(contentW + Theme.paddingX * 2, maxW);

	bar.setFrame(flipFrameY(barRect(barWidth)));

	const elements: CanvasElement[] = [...rulerElements(), backgroundElement()];

	const chipY = (BAR_HEIGHT - CHIP_HEIGHT) / 2;
	const labelY = (BAR_HEIGHT - rowTextH) / 2;
	let x = Theme.paddingX;

	segments.forEach((seg, i) => {
		if (seg.chipW) {
			elements.push(
				Canvas.rectangle("fill", {
					fillColor: canvasColor(Theme.surface),
					roundedRectRadii: cornerRadii(Theme.keyChipRadius),
					frame: { x, y: chipY, w: seg.chipW, h: CHIP_HEIGHT },
				}),
			);
			elements.push(
				Canvas.text(seg.glyph, {
					textColor: canvasColor(Theme.text),
					textWeight: "bold",
					textSize: Theme.fontSize,
					textAlignment: "center",
					frame: { x, y: chipY, w: seg.chipW, h: CHIP_HEIGHT },
				}),
			);
			x += seg.chipW + CHIP_LABEL_GAP;
		}
		elements.push(
			Canvas.text(seg.opt.label, {
				textColor: canvasColor(Theme.textDim),
				textSize: Theme.fontSize,
				frame: { x, y: labelY, w: seg.labelW + 2, h: rowTextH },
			}),
		);
		x += seg.labelW;
		if (i < segments.length - 1) x += PAIR_GAP;
	});

	bar.replaceElements(elements);
	bar.show();
}

// Attaches a shortcut bar to `chooser`, independent of any other chooser
// also using this module -- each call gets its own canvas/timer/tap via
// closure. Takes over the chooser's onShow/onHide (unused by every current
// caller, safe to claim outright).
//
// getOptionsForRow(row) is called with whatever selectedRowContents()
// returns (the choice dict's plain-data fields -- text/subText/image/your
// own custom fields, all intact) and must return a fresh ChoiceOption[]
// computed in JS, not one stashed on the choice dict itself (see the file
// header for why).
export function attachOptionsBar(
	chooser: HSChooser,
	getOptionsForRow: (
		row: Record<string, unknown>,
	) => ChoiceOption[] | undefined,
): void {
	let bar: HSCanvas | null = null;
	let pollTimer: HSTimer | null = null;
	let tap: HSEventTap | null = null;
	let lastRow: Record<string, unknown> | null = null;
	let currentOptions: ChoiceOption[] | undefined;

	function renderCurrent(): void {
		if (!currentOptions || currentOptions.length === 0) {
			bar?.destroy();
			bar = null;
			return;
		}
		if (!bar) bar = buildBarCanvas();
		render(bar, currentOptions);
	}

	// Compares the highlighted row dict's own identity rather than
	// chooser.selectedRow's numeric index -- that index is into whatever
	// subset the chooser is currently displaying, which hs.chooser re-filters
	// internally as the user types a query, so the same index can silently
	// refer to a different row across ticks.
	function tick(): void {
		const row = chooser.selectedRowContents(null) as Record<
			string,
			unknown
		> | null;
		if (row === lastRow) return;
		lastRow = row;
		currentOptions = row ? getOptionsForRow(row) : undefined;
		renderCurrent();
	}

	function onKeyDown(event: HSEventTapEvent): boolean {
		if (!currentOptions) return hs.eventtap.emit;
		const codeMap = hs.keycodes.map as Record<string, unknown>;
		const keyName = String(codeMap[String(event.keyCode)] ?? "");
		const flags = genericMods(event.flags);
		for (const opt of currentOptions) {
			if (!opt.key || !opt.run) continue; // display-only legend entry
			if (
				keyMatches(opt.key, event, keyName) &&
				modsMatch(opt.mods ?? [], flags)
			) {
				opt.run();
				return hs.eventtap.consume;
			}
		}
		return hs.eventtap.emit;
	}

	chooser.onShow = () => {
		lastRow = null;
		tick();
		pollTimer = hs.timer.create(POLL_INTERVAL_SECONDS, tick);
		pollTimer.start();
		tap = hs.eventtap.addWatcher([KEY_DOWN], onKeyDown, false);
		tap?.start();
	};

	chooser.onHide = () => {
		pollTimer?.stop();
		pollTimer = null;
		tap?.stop();
		tap = null;
		bar?.destroy();
		bar = null;
	};
}
