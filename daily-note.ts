// Resolves today's journal note path. Extracted out of leader-menu-config.ts
// (which used it only for the "Daily note" editor-opening item) so
// quick-note.ts can reuse the exact same path logic without that file
// having to import anything from the menu-wiring file -- every other
// feature in this config is its own file imported *into*
// leader-menu-config.ts, never the reverse.

// Not toLocaleString() -- its month/weekday-name formatting depends on
// this JS engine's ICU/Intl setup (and, with it, potentially a different
// notion of "today" than the system's actual local timezone), unlike
// getMonth()/getDay(), which ECMA-262 defines as plain local-time
// accessors with no Intl involved at all. A real-world case of this:
// testing right around a local midnight when Intl's day boundary didn't
// line up with the system clock's.
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function dailyNotePath(): { path: string; dir: string } {
	const now = new Date();
	const mon = MONTH_ABBR[now.getMonth()];
	const day = String(now.getDate()).padStart(2, "0");
	const dow = WEEKDAY_ABBR[now.getDay()];
	const dir = `${hs.fs.homeDirectory()}/work/journal/${mon}`;
	return { path: `${dir}/${day}-${dow}.md`, dir };
}
