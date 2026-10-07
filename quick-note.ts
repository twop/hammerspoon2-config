// Quick capture: type a line, press Enter (or ⌘Enter), it's appended to
// today's journal note. hs.chooser's query field is the text input -- it's
// the one text input this config can actually style, and already has
// working Cmd+Enter detection via chooser-options-bar.ts.

import { dailyNotePath } from "./daily-note";
import type { ChooserSpec } from "./chooser-runtime";

function appendToDailyNote(text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	const { path, dir } = dailyNotePath();
	hs.fs.mkdir(dir);
	if (!hs.fs.attributes(path)) hs.fs.write(path, "");
	hs.fs.append(path, trimmed + "\n");
	hs.ui.alert("Appended to daily note").duration(0.6).show();
}

interface NoteChoice {
	text: string;
}

export function spec(): ChooserSpec<NoteChoice> {
	return {
		width: 0.35,
		visibleRows: 1,
		placeholder: "Type a quick note…",
		choices: (query) => [
			{ text: query ? `Append: ${query}` : "Type a note, then press ⏎ to append" },
		],
		// Plain Enter confirms the row -- appends the current query.
		onSelect: (_choice, chooser) => appendToDailyNote(chooser.query),
		optionsBar: (_row, chooser) => [
			{
				mods: ["cmd"],
				key: "return",
				label: "Append to daily note",
				run: () => {
					const text = chooser.query;
					chooser.hide();
					appendToDailyNote(text);
				},
			},
		],
	};
}
