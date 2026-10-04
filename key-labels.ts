// Single-character hint-label allocator: assigns letters to a list of items
// in a fixed ergonomic priority order. Not tied to any particular menu --
// used by zellij-menu.ts to label a dynamically-sized list of
// sessions/tabs, capping the list at the pool size (see capacity()) rather
// than trying to label more items than there are convenient single keys
// for. (Port of key-labels.lua -- the two-character-label overflow phase
// from kontur's labels.rs was deliberately dropped in that port; see its
// history for why.)

// Alternating-hands priority order -- consecutive labels alternate which
// hand presses them (ergonomic, like alternating which hand hits Shift
// depending on the letter being typed). Interleaves the QWERTY left home
// row (a s d f g) and right home row (h j k l), keeping each hand's own
// internal priority order; left has 5 keys to right's 4, so the last one
// repeats left.
export const SINGLE_CHARS = [
	"a",
	"s",
	"d",
	"f",
	"g",
	"h",
	"j",
	"k",
	"l",
] as const;

export function capacity(single: readonly string[] = SINGLE_CHARS): number {
	return single.length;
}

// Returns up to `count` single-character labels (never more than
// capacity()) -- callers should cap their item list to that capacity
// first so every item actually gets one.
export function generate(
	count: number,
	single: readonly string[] = SINGLE_CHARS,
): string[] {
	return single.slice(0, Math.min(count, single.length));
}
