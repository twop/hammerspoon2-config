// Quick capture: type a line, press Enter (or ⌘Enter), it's appended to
// today's journal note. Built on chooser-runtime.ts's textInput().

import { dailyNotePath } from "./daily-note";
import { textInput, type ChooserSpec } from "./chooser-runtime";

function appendToDailyNote(text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	const { path, dir } = dailyNotePath();
	hs.fs.mkdir(dir);
	if (!hs.fs.attributes(path)) hs.fs.write(path, "");
	hs.fs.append(path, trimmed + "\n");
	hs.ui.alert("Appended to daily note").duration(0.6).show();
}

export function spec(): ChooserSpec<{ text: string }> {
	return textInput({
		placeholder: "Type a quick note…",
		preview: (query) =>
			query ? `Append: ${query}` : "Type a note, then press ⏎ to append",
		submitLabel: "Append to daily note",
		onSubmit: appendToDailyNote,
	});
}
