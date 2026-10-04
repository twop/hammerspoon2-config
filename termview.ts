// termview client helper -- opens (or reuses/switches to) a persistent
// termview workspace. Port of termview.lua; shared by init.ts's hotkeys
// and the leader menu's Utilities submenu.
//
// v1's hs.execute(cmd, true) (synchronous shell-out through a login+
// interactive shell) has no v2 equivalent -- hs.task is callback/Promise
// based here instead. That's fine for summon()/pick(), which were always
// fire-and-forget (the task's own completion callback is where v1 cleared
// its keepalive table too).

export function shellQuote(s: string): string {
	return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

const BIN = "termview";
const SHELL = hs.appinfo.environment.SHELL ?? "/bin/zsh";

// hs.task objects must stay referenced or GC could collect (and kill) them
// mid-flight -- same reasoning v1 had, kept here defensively even though
// HSTask's actual GC semantics under JavaScriptCore weren't verified.
const pendingTasks = new Set<HSTask>();

function runLoginShell(argv: string): void {
	let task: HSTask;
	task = hs.task.create(
		SHELL,
		["-l", "-i", "-c", argv],
		() => {
			pendingTasks.delete(task);
		},
		null,
		null,
	);
	pendingTasks.add(task);
	task.start();
}

// Opens (or reuses/switches to) a persistent termview workspace running
// cmd. cmd may be omitted -- termview then opens an interactive session in
// its resolved shell instead.
export function summon(
	workspace: string,
	cmd?: string,
	extraArgs?: string,
): void {
	const cmdPart = cmd ? `${shellQuote(cmd)} ` : "";
	const argv = `${BIN} open ${cmdPart}--workspace ${workspace} --persistent${extraArgs ?? ""}`;
	runLoginShell(argv);
}

type PickCallback = (text: string) => void;

// Tracks in-flight picks so the urlevent callback (fired once termview's
// --report shells out to `open` on the session's self-exit) can find the
// right callback. Keyed by workspace name.
const pendingPicks = new Map<string, PickCallback>();
let pickHandlerBound = false;

function ensurePickHandlerBound(): void {
	if (pickHandlerBound) return;
	pickHandlerBound = true;

	hs.urlevent.bind("termview-pick", (_eventName, params) => {
		const workspace = params.workspace;
		const callback = workspace ? pendingPicks.get(workspace) : undefined;
		if (!callback || !workspace) return;
		pendingPicks.delete(workspace);

		// Esc / no match -> termview reports blank (or whitespace-only) final
		// on-screen text. Treat that as cancellation: do nothing.
		const result = (params.stdout ?? "").trim();
		if (result === "") return;

		callback(result);
	});
}

// Runs cmd as a one-shot, non-persistent termview session in workspace
// (rooted at cwd), and invokes callback(text) with the terminal's final
// on-screen text once cmd exits on its own. Cmd+W (manual abort) does NOT
// invoke callback.
export function pick(
	workspace: string,
	cmd: string,
	cwd: string,
	callback: PickCallback,
): void {
	ensurePickHandlerBound();
	pendingPicks.set(workspace, callback);

	// {stdout} must reach termview completely literally -- it's the token
	// termview substitutes on its side, not something to touch here.
	const reportUrl = `hammerspoon2://termview-pick?workspace=${workspace}&stdout={stdout}`;

	const argv =
		`${BIN} open ${shellQuote(cmd)}` +
		` --workspace ${workspace}` +
		` --cwd ${shellQuote(cwd)}` +
		` --report ${shellQuote(reportUrl)}`;
	// Deliberately no --persistent: a pick is one-shot.
	runLoginShell(argv);
}
