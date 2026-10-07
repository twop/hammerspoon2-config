// Nord color palette + UI metrics, shared by every canvas-drawn UI in this
// config (leader-menu.ts) and by hs.chooser's theming properties (the
// pickers). Port of nord-theme.lua -- same source of truth (nord-night,
// darker than stock Nord's nord0) -- but v2 needs colors in two different
// shapes depending on the API: hs.canvas element attributes take a plain
// {red, green, blue, alpha} dictionary (0.0-1.0 floats, same as v1's Lua
// tables), while hs.chooser's theming properties take a real HSColor
// instance. canvasColor()/chooserColor() convert from one hex-string
// source of truth into whichever shape the call site needs.

export interface RGBA {
	red: number;
	green: number;
	blue: number;
	alpha: number;
}

function hexToRGBA(hex: string, alpha: number): RGBA {
	const h = hex.replace("#", "");
	return {
		red: Number.parseInt(h.substring(0, 2), 16) / 255,
		green: Number.parseInt(h.substring(2, 4), 16) / 255,
		blue: Number.parseInt(h.substring(4, 6), 16) / 255,
		alpha,
	};
}

export function canvasColor(hex: string, alpha = 1): RGBA {
	return hexToRGBA(hex, alpha);
}

export function chooserColor(hex: string): HSColor {
	return HSColor.hex(hex);
}

// Applied to every hs.chooser this config creates (chooser-runtime.ts's
// mountChooser()) so every picker is consistently themed -- previously each
// of app-picker.ts/emoji-picker.ts/menu-item-search.ts/clipboard-history.ts/
// quick-note.ts/process-explorer.ts hand-rolled its own subset of these
// properties, with gaps (e.g. only quick-note.ts set queryColor/
// placeholderColor). Per-chooser fields that vary (width, visibleRows,
// placeholder, searchSubText) stay on each chooser's own ChooserSpec.
export const DEFAULT_CHOOSER_WIDTH = 0.3;

export function styleChooser(c: HSChooser): void {
	c.width = DEFAULT_CHOOSER_WIDTH;
	c.backgroundColor = chooserColor(Theme.background);
	c.borderColor = chooserColor(Theme.border);
	c.cornerRadius = Theme.cornerRadius;
	c.textColor = chooserColor(Theme.text);
	c.subTextColor = chooserColor(Theme.textDim);
	c.selectionColor = chooserColor(Theme.selectionBack);
	c.queryColor = chooserColor(Theme.text);
	c.placeholderColor = chooserColor(Theme.textDim);
}

// Raw palette (nord0..nord15, plus nord-night's darker nord0Dark) -- see
// nord-theme.lua for the full derivation/cross-check notes.
export const Nord = {
	nord0: "#2E3440",
	nord0Dark: "#252933",
	nord1: "#3B4252",
	nord2: "#434C5E",
	nord3: "#4C566A",
	nord4: "#D8DEE9",
	nord5: "#E5E9F0",
	nord6: "#ECEFF4",
	nord7: "#8FBCBB",
	nord8: "#88C0D0",
	nord9: "#81A1C1",
	nord10: "#5E81AC",
	nord11: "#BF616A",
	nord12: "#D08770",
	nord13: "#EBCB8B",
	nord14: "#A3BE8C",
	nord15: "#B48EAD",
} as const;

const FONT_SIZE = 12;

// Semantic roles + metrics. Prefer these over the raw nordN hexes in UI code.
export const Theme = {
	background: Nord.nord0Dark,
	backgroundAlpha: 1,
	surface: Nord.nord1,
	border: Nord.nord2,

	text: Nord.nord6,
	textMuted: Nord.nord3,
	textDim: Nord.nord3,

	accent: Nord.nord8,
	accentSecondary: Nord.nord9,

	error: Nord.nord11,
	warning: Nord.nord13,
	success: Nord.nord14,
	selectionBack: Nord.nord0,

	paddingX: 16,
	paddingY: 16,
	gap: 10,
	fontSize: FONT_SIZE,
	breadcrumbFontSize: 12,
	cornerRadius: 10,
	borderWidth: 1.5,

	// Descender headroom factor: multiplied onto a font size wherever a
	// canvas text element's frame height is set, so the box has room below
	// the baseline for descenders ("y"/"g"/"p") -- see leader-menu.ts.
	textFrameHeightMultiplier: 1.3,

	// "Square glyph slot" columns (app icon, key chip) share this formula.
	iconColW: FONT_SIZE + 10,
	keyChipSize: FONT_SIZE + 10,
	keyChipRadius: 4,
	imageIconSize: Math.floor(FONT_SIZE * 1.25),

	placeholderCanvasSize: 32,
	placeholderDotDiameter: 16,
	placeholderRingStrokeWidth: 1,
} as const;
