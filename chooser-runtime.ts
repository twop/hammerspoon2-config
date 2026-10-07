// Mounts one hs.chooser screen from a declarative ChooserSpec -- the
// chooser-side counterpart to leader-menu.ts's canvas-drawn menu screens.
// Scene/stack-agnostic on purpose: it knows nothing about leader-menu.ts's
// Model/Msg, it just renders one chooser and reports back ("closed",
// "drill into this other spec") via the callbacks it's given.
//
// ChooserSpec is generic over its row type so each module's onSelect gets
// real typed field access instead of indexing into
// Record<string, unknown> by hand. See eraseChooser() below for why
// crossing into the untyped/erased form needs an explicit cast rather than
// relying on structural subtyping.

import { styleChooser } from "./nord-theme";
import { attachOptionsBar, type ChoiceOption } from "./chooser-options-bar";

export interface ChooserSpec<T extends object = Record<string, unknown>> {
	choices: T[] | ((query: string) => T[]);
	placeholder?: string;
	searchSubText?: boolean;
	visibleRows?: number;
	width?: number;
	// Returning a ChooserSpec means "drill into this other chooser" (pushed
	// onto leader-menu.ts's stack, backable to here); returning void means
	// the selection was a terminal action -- the whole runtime closes, same
	// as picking an "app"/"cmd"/"url" MenuAction. The returned spec must
	// already be erased (see eraseChooser) since it crosses into the
	// runtime's untyped stack.
	//
	// Both callbacks are handed the live chooser (rather than each module
	// caching its own hs.chooser.create() result, as before this was
	// centralized) for the cases that need it directly -- quick-note.ts's
	// onSelect reads the in-progress .query rather than the row; several
	// modules' options-bar actions hide()/refreshChoices() after a
	// Quit/Pin/Delete.
	onSelect: (choice: T, chooser: HSChooser) => void | ChooserSpec;
	optionsBar?: (row: T, chooser: HSChooser) => ChoiceOption[] | undefined;
}

// ChooserSpec<T> isn't a safe structural upcast to the erased
// ChooserSpec (= ChooserSpec<Record<string, unknown>>) on its own --
// onSelect/optionsBar's parameter position is contravariant, so a function
// that only knows how to handle T can't be passed off as one that accepts
// any Record<string, unknown>, and TypeScript correctly refuses the
// assignment. The cast below is sound rather than just convenient: the
// choice/row mountChooser() ever hands back out is always one of the exact
// T values `spec.choices` was built from, round-tripped through
// hs.chooser's native bridge (chooser-options-bar.ts's header comment
// confirms plain-data fields survive setChoices()/selectedRowContents()
// intact). This is the one place that fact becomes a cast, instead of
// every module sprinkling `choice["x"] as Y` through its own onSelect.
export function eraseChooser<T extends object>(
	spec: ChooserSpec<T>,
): ChooserSpec {
	return {
		placeholder: spec.placeholder,
		searchSubText: spec.searchSubText,
		visibleRows: spec.visibleRows,
		width: spec.width,
		choices: spec.choices as unknown as
			| Record<string, unknown>[]
			| ((query: string) => Record<string, unknown>[]),
		onSelect: (choice, chooser) =>
			spec.onSelect(choice as unknown as T, chooser),
		optionsBar: spec.optionsBar
			? (choice, chooser) => spec.optionsBar!(choice as unknown as T, chooser)
			: undefined,
	};
}

export interface MountedChooser {
	hide(): void;
}

// onBack is present only when leader-menu.ts's stack has something beneath
// this chooser to go back to -- when present, a synthetic "Back" entry is
// merged into whatever row-specific options the spec's own optionsBar
// computes, reusing chooser-options-bar.ts's existing shortcut-legend
// mechanism rather than a second eventtap. ⌘[ specifically because Delete/
// Backspace (leader-menu.ts's own back gesture) is already claimed by
// hs.chooser's query text field.
export function mountChooser(
	spec: ChooserSpec,
	onClose: () => void,
	onOpenChooser: (spec: ChooserSpec) => void,
	onBack?: () => void,
): MountedChooser {
	const c = hs.chooser.create();
	styleChooser(c);
	if (spec.width !== undefined) c.width = spec.width;
	c.visibleRows = spec.visibleRows ?? 9;
	c.searchSubText = spec.searchSubText ?? false;
	c.placeholder = spec.placeholder ?? "";
	c.setChoices(spec.choices);
	// hs.chooser doesn't automatically re-invoke a function-form choices
	// list as the query changes -- quick-note.ts's live "Append: <query>"
	// preview relies on exactly this refresh.
	if (typeof spec.choices === "function") {
		c.onQueryChange = () => c.refreshChoices();
	}

	c.onSelect = (choice) => {
		// hs.chooser fires onSelect with a null choice on Escape/cancel too --
		// every module this replaces already relied on that convention (each
		// started its own onSelect with `if (!choice) return;`). The chooser
		// has already hidden itself natively at this point; onClose() here
		// just keeps leader-menu.ts's stack in sync with that fact.
		if (choice === null) {
			onClose();
			return;
		}
		const result = spec.onSelect(choice, c);
		// Deferred: onSelect fires while `c` is still mid-hide (hiding itself
		// restores focus to whatever was active before) -- mounting a brand
		// new chooser synchronously right here, inside that same native
		// callback, races that handoff. One tick later it's settled. Each
		// module's own terminal side effects (paste, focus a window, ...)
		// defer themselves the same way inside their own onSelect.
		if (result) hs.timer.doAfter(0, () => onOpenChooser(result));
		else onClose();
	};

	attachOptionsBar(c, (row) => {
		const own = spec.optionsBar?.(row, c) ?? [];
		return onBack
			? [...own, { mods: ["cmd"], key: "[", label: "Back", run: onBack }]
			: own;
	});

	c.query = "";
	c.show();
	return { hide: () => c.hide() };
}
