// The one way this config shells out to the user's own tools (zellij,
// termview, ...). Hammerspoon runs with launchd's bare environment -- PATH
// is just /usr/bin:/bin:/usr/sbin:/sbin -- so anything in ~/.cargo/bin or
// Homebrew is unresolvable from a plain hs.task.shell(); worse, hs.task
// doesn't fail fast on a missing command, the promise just never settles.
//
// Hence a login shell (-l): ~/.zshenv (cargo) + ~/.zprofile (brew
// shellenv) put every tool used here on PATH, for ~20 ms of startup.
// Deliberately NOT interactive (-i): that also sources ~/.zshrc -- starship,
// zoxide, op/uv/uvx completion generation (each its own subprocess),
// zsh-autocomplete... -- which measured ~130 ms per call, the bulk of e.g.
// zellij-menu.ts's per-pick latency, for nothing a non-interactive command
// uses. Shells that zellij/termview open in their own panes are interactive
// themselves, so they still get .zshrc.

const SHELL = hs.appinfo.environment.SHELL ?? "/bin/zsh";

export function shellQuote(s: string): string {
	return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

// Runs cmd and resolves with its output.
export function loginShell(
	cmd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return hs.task.shell(`${SHELL} -l -c ${shellQuote(cmd)}`, {});
}

// hs.task objects must stay referenced or GC could collect (and kill) them
// mid-flight -- kept defensively even though HSTask's actual GC semantics
// under JavaScriptCore weren't verified.
const pendingTasks = new Set<HSTask>();

// Fire-and-forget form, for launching something rather than reading it.
export function spawnLoginShell(cmd: string): void {
	let task: HSTask;
	task = hs.task.create(
		SHELL,
		["-l", "-c", cmd],
		() => {
			pendingTasks.delete(task);
		},
		null,
		null,
	);
	pendingTasks.add(task);
	task.start();
}
