// Quick capture: type a line, press Enter (or ⌘Enter), it's appended to
// today's journal note. hs.chooser's query field is the text input -- it's
// the one text input this config can actually style, and already has
// working Cmd+Enter detection via chooser-options-bar.ts.

import { dailyNotePath } from "./daily-note";
import { Theme, chooserColor } from "./nord-theme";
import { attachOptionsBar } from "./chooser-options-bar";

function appendToDailyNote(text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	const { path, dir } = dailyNotePath();
	hs.fs.mkdir(dir);
	if (!hs.fs.attributes(path)) hs.fs.write(path, "");
	hs.fs.append(path, trimmed + "\n");
	hs.ui.alert("Appended to daily note").duration(0.6).show();
}

let chooser: HSChooser | null = null;

function ensureChooser(): void {
	if (chooser) return;
	chooser = hs.chooser.create();
	chooser.width = 0.35;
	chooser.visibleRows = 1;
	chooser.placeholder = "Type a quick note…";
	chooser.backgroundColor = chooserColor(Theme.background);
	chooser.borderColor = chooserColor(Theme.border);
	chooser.cornerRadius = Theme.cornerRadius;
	chooser.textColor = chooserColor(Theme.text);
	chooser.subTextColor = chooserColor(Theme.textDim);
	chooser.queryColor = chooserColor(Theme.text);
	chooser.placeholderColor = chooserColor(Theme.textDim);
	chooser.setChoices((query) => [
		{ text: query ? `Append: ${query}` : "Type a note, then press ⏎ to append" },
	]);
	chooser.onQueryChange = () => chooser!.refreshChoices();
	// Plain Enter confirms the row -- appends the current query.
	chooser.onSelect = () => appendToDailyNote(chooser!.query);
	attachOptionsBar(chooser, () => [
		{
			mods: ["cmd"],
			key: "return",
			label: "Append to daily note",
			run: () => {
				const text = chooser!.query;
				chooser!.hide();
				appendToDailyNote(text);
			},
		},
	]);
}

export function show(): void {
	ensureChooser();
	const c = chooser!;
	c.query = "";
	c.show();
}
