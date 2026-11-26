// LeaderKey-style popup menu, drawn with hs.canvas, triggered by a single
// hotkey (wired up in init.ts) and navigated via key presses or clicks.
// Port of leader-menu.lua -- see that file's header for the original menu
// tree format; the shape survives here as the MenuItem/MenuAction types
// below, now a proper tagged union instead of "exactly one of five
// optional fields is present".
//
// The engine itself is a small Elm/TEA-style loop: selecting something
// produces a Msg ("open this chooser", "go back", "run this effect"), one
// pure update() interprets that Msg against the current Scene stack
// (Model), and dispatch() mounts/unmounts the actual UI (a canvas menu
// level, or an hs.chooser screen via chooser-runtime.ts) to match. This is
// what makes back-navigation -- Delete to pop a submenu, ⌘[ to pop a
// chooser, even backing out of a chooser into the menu level that opened
// it -- all the same mechanism instead of three separately hand-rolled
// ones: see Scene/Msg/update/dispatch below.
//
// Notable v1 -> v2 differences this port had to work around:
// - No `hs.window.filter` module. The "close on any app/window stealing
//   focus" watcher is rebuilt from two primitives that *do* exist:
//   hs.application.on('didActivate', ...) (catches a different app
//   becoming frontmost) plus hs.ax.on(element, 'focusedWindowChanged', ...)
//   scoped to whichever app is currently frontmost, rebound on every
//   didActivate (catches a same-app window switch too). See
//   startFocusWatcher() below.
// - No hs.styledtext module, so a label+arrow mixed-style run becomes two
//   adjacent plain text elements instead of one styled string.
// - hs.eventtap's modify-tap callback convention is the *reverse* of v1's:
//   return hs.eventtap.consume (false) to swallow a keystroke, emit (true)
//   to let it through -- opposite of v1's return-true-to-swallow.
// - No hs.shutdownCallback found in the v2 API surface; the shutdown-hook
//   chaining v1 had is dropped (it was defensive cleanup only).

import { Theme, canvasColor } from "./nord-theme";
import { Canvas, cornerRadii } from "./canvas";
import { flipFrameY } from "./screen-geometry";
import {
	canvasTarget,
	nowMs,
	parallel,
	run,
	stop,
	stopAll,
	tween,
	type Target,
	type Vec,
} from "./animation";
import {
	mountChooser,
	eraseChooser,
	type ChooserSpec,
} from "./chooser-runtime";

// `noUncheckedIndexedAccess` turns every Record<string, T> lookup -- dot
// notation included -- into `T | undefined`, so these named constants (all
// genuinely always present) are read once with a non-null assertion here
// instead of scattering `!` through the rendering/input code below.
const OVERLAY_LEVEL = hs.canvas.windowLevels["overlay"]!;
const KEY_DOWN = hs.eventtap.eventTypes["keyDown"]!;
const LEFT_MOUSE_DOWN = hs.eventtap.eventTypes["leftMouseDown"]!;
const RIGHT_MOUSE_DOWN = hs.eventtap.eventTypes["rightMouseDown"]!;
const OTHER_MOUSE_DOWN = hs.eventtap.eventTypes["otherMouseDown"]!;

// ============================================================
// MENU TREE TYPES
// ============================================================

export type ChooserSource = () => ChooserSpec | Promise<ChooserSpec>;

// One shared phantom brand (type-only -- nothing exists at runtime) so a
// MenuAction can only come from the capitalized constructors below, never
// a hand-written object literal. `kind` stays a plain string discriminant,
// so the engine's switches below narrow exactly as before.
declare const MenuActionBrand: unique symbol;
type Branded<T> = T & { readonly [MenuActionBrand]: true };

export type SubmenuAction = Branded<{
	readonly kind: "submenu";
	readonly submenu: MenuItem[];
}>;
// What a PrefetchSubmenu's render produces: its items, plus an optional
// title appended to the breadcrumb -- for a heading that depends on the
// loaded data (e.g. zellij-menu.ts's tabsMenu naming the attached session).
export interface MenuContent {
	items: MenuItem[];
	title?: string;
}

// Its data type is erased by fusing load + render into one thunk (see
// PrefetchSubmenu() below) -- the engine only ever needs the final content.
// The action object itself is the engine's cache key, see Model.loads.
export type PrefetchSubmenuAction = Branded<{
	readonly kind: "prefetchSubmenu";
	readonly load: () => Promise<MenuContent>;
}>;
export type ChooserAction = Branded<{
	readonly kind: "chooser";
	readonly spec: ChooserSource;
}>;
export type AppAction = Branded<{
	readonly kind: "app";
	readonly bundleID: string;
}>;
export type CmdAction = Branded<{
	readonly kind: "cmd";
	readonly path: string;
	readonly args: readonly string[];
}>;
export type UrlAction = Branded<{ readonly kind: "url"; readonly url: string }>;
export type CallbackAction = Branded<{
	readonly kind: "callback";
	readonly run: () => void;
}>;

export type AnySubmenuAction = SubmenuAction | PrefetchSubmenuAction;

export type MenuAction =
	| SubmenuAction
	| PrefetchSubmenuAction
	| ChooserAction
	| AppAction
	| CmdAction
	| UrlAction
	| CallbackAction;

export const Submenu = (submenu: MenuItem[]): SubmenuAction =>
	({ kind: "submenu", submenu }) as SubmenuAction;

// A submenu whose items come from async data (e.g. zellij-menu.ts's one
// zj_hs_jump state fetch feeding all its children). load() starts as soon
// as the level containing this item mounts -- not on selection -- and its
// result is cached for the rest of the show() session, so by the time the
// key is pressed the items are usually already there. A rejected load() or
// a throwing render() shows as an error row in the submenu itself.
export const PrefetchSubmenu = <T>(
	load: () => Promise<T>,
	render: (data: T) => MenuItem[] | MenuContent,
): PrefetchSubmenuAction =>
	({
		kind: "prefetchSubmenu",
		load: async () => {
			const rendered = render(await load());
			return Array.isArray(rendered) ? { items: rendered } : rendered;
		},
	}) as PrefetchSubmenuAction;

// Generic over the spec's row type and erases it here, so call sites pass
// their module's typed spec() straight through instead of each wrapping it
// in eraseChooser() by hand.
export const Chooser = <T extends object>(
	spec: () => ChooserSpec<T> | Promise<ChooserSpec<T>>,
): ChooserAction =>
	({
		kind: "chooser",
		spec: () => {
			const resolved = spec();
			return resolved instanceof Promise
				? resolved.then(eraseChooser)
				: eraseChooser(resolved);
		},
	}) as ChooserAction;

export const App = (bundleID: string): AppAction =>
	({ kind: "app", bundleID }) as AppAction;

export const Cmd = (path: string, ...args: string[]): CmdAction =>
	({ kind: "cmd", path, args: args as readonly string[] }) as CmdAction;

export const Url = (url: string): UrlAction =>
	({ kind: "url", url }) as UrlAction;

export const Callback = (run: () => void): CallbackAction =>
	({ kind: "callback", run }) as CallbackAction;

export interface MenuItem {
	key: string;
	label: string;
	icon?: string | HSImage; // a plain text glyph (e.g. an emoji), or an HSImage (e.g. an SF Symbol)
	action: MenuAction;
}

// One thing visibly shown; a stack of these is the engine's Model. Closed
// union on purpose -- "menu" (this file's own canvas) and "chooser"
// (chooser-runtime.ts's hs.chooser) are all seven of today's menu entries
// need. A future third kind (e.g. a chooser with a preview pane, carrying
// its own layout) would be a sibling variant with its own branch in
// mountScene() below, without touching update().
//
// A menu scene carries a snapshot of its content rather than reading the
// load cache at render time: when a load settles, update() swaps in a new
// scene object, and that identity change is what makes dispatch() remount
// it -- no separate "content changed" diffing needed.
type Remote =
	| { status: "loading" }
	| ({ status: "ready" } & MenuContent)
	| { status: "failed"; error: string };

interface MenuScene {
	kind: "menu";
	source: PrefetchSubmenuAction | null; // null: a static Submenu
	content: Remote;
	breadcrumb: string[];
}

type Scene = MenuScene | { kind: "chooser"; spec: ChooserSpec };

interface MountedScene {
	hide(): void;
}

// ============================================================
// TIMING / ANIMATION
// ============================================================

const REVEAL_DELAY_SECONDS = 0.3;
const SLIDE_OFFSET_PX = 14;
const SPLIT_GAP_PX = 24;

const below = (p: Vec): Vec => ({ x: p.x, y: p.y + SLIDE_OFFSET_PX });

// Every motion the menu makes, as data -- run by animation.ts's engine
// (see that file for the rules: a new run on a target replaces its old
// one, and a tween without `from` starts from the target's current value).
const Anim = {
	// The dot rising and fading in at the screen's center, on every show().
	dotEnter: (rest: Vec) =>
		parallel(
			tween("topLeft", rest, 0.2, { from: below(rest) }),
			tween("opacity", 1, 0.2, { from: 0 }),
		),
	// The dot moving aside for the panel. No `from`: with revealImmediately
	// this lands mid-dotEnter and just continues from there.
	dotSplit: (left: Vec) =>
		parallel(tween("topLeft", left, 0.22), tween("opacity", 1, 0.22)),
	// The panel's first appearance in a session.
	panelEnter: (rest: Vec) =>
		tween("topLeft", rest, 0.22, { from: below(rest) }),
	// A content swap (Loading… -> items) or a level change: glide from where
	// the previous panel was to the new one's rest position.
	panelMove: (rest: Vec) => tween("topLeft", rest, 0.22),
};

// ============================================================
// MODULE STATE
// ============================================================

// A canvas plus the animation target driving it.
interface Animated {
	canvas: HSCanvas;
	target: Target;
}

let panel: Animated | null = null; // the menu level's own canvas
let dot: Animated | null = null; // the placeholder dot
let tap: HSEventTap | null = null;
let mouseTap: HSEventTap | null = null;
let model: Model = { session: 0, stack: [], loads: new Map() };
let mounted: MountedScene | null = null;
let revealed = false;
let revealTimer: HSTimer | null = null;
let showStartMs = 0;

// Focus-steal watcher state (see startFocusWatcher()). Canvas-menu-only --
// hs.chooser is a real native panel that manages its own focus/modality --
// so this lives and dies with a "menu" scene's own mount, not globally.
let watchedAppElement: HSAXElement | null = null;
const onFocusedWindowChanged = (
	_notification: string,
	_element: HSAXElement,
): void => dispatch({ type: "close" });

// Rebinds the focusedWindowChanged watch to whichever app is now frontmost.
// Split out from onDidActivate so startFocusWatcher() can seed it for the
// already-frontmost app at mount-time without also closing the menu it's
// in the middle of opening.
function watchAppElement(app: HSApplication | null): void {
	if (watchedAppElement) {
		hs.ax.off(
			watchedAppElement,
			"focusedWindowChanged",
			onFocusedWindowChanged,
		);
		watchedAppElement = null;
	}
	const element = app?.axElement() ?? null;
	if (element) {
		hs.ax.on(element, "focusedWindowChanged", onFocusedWindowChanged);
		watchedAppElement = element;
	}
}

const onDidActivate = (app: HSApplication | null): void => {
	watchAppElement(app);
	dispatch({ type: "close" });
};

function startFocusWatcher(): void {
	hs.application.on("didActivate", onDidActivate);
	watchAppElement(hs.application.frontmost());
}

function stopFocusWatcher(): void {
	hs.application.off("didActivate", onDidActivate);
	watchAppElement(null);
}

// ============================================================
// ENGINE: Scene stack (Model) / Msg / update / dispatch
// ============================================================

interface Model {
	// Bumped by every show(); each in-flight load is tagged with the session
	// it started in, so a result landing after a close/reopen is dropped.
	session: number;
	stack: Scene[]; // bottom -> top; [] means fully closed
	// PrefetchSubmenu results for this session, keyed by action identity.
	// Cleared on close, so a load still in flight then also finds no entry
	// to settle into.
	loads: Map<PrefetchSubmenuAction, Remote>;
}

type Msg =
	| { type: "open"; root: AnySubmenuAction } // from show(): starts a new session
	| { type: "select"; action: AnySubmenuAction; breadcrumb: string[] }
	| {
			type: "loadSettled";
			session: number;
			action: PrefetchSubmenuAction;
			result: Remote;
	  }
	| { type: "openChooser"; spec: ChooserSpec }
	| { type: "back" }
	| { type: "close" }
	| { type: "runEffect"; run: () => void }; // app/cmd/url/callback all normalize to this

// A side effect for dispatch() to run once the view has caught up, handed
// dispatch itself so async work (a PrefetchSubmenu load) can report back
// as a Msg instead of touching state directly.
type Effect = (dispatch: (msg: Msg) => void) => void;

const LOADING: Remote = { status: "loading" };

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function loadEffect(session: number, action: PrefetchSubmenuAction): Effect {
	return (dispatch) => {
		action.load().then(
			(content) =>
				dispatch({
					type: "loadSettled",
					session,
					action,
					result: { status: "ready", ...content },
				}),
			(err: unknown) =>
				dispatch({
					type: "loadSettled",
					session,
					action,
					result: { status: "failed", error: errorMessage(err) },
				}),
		);
	};
}

// Starts a load for every not-yet-cached PrefetchSubmenu among a level's
// items -- called whenever a level with ready content lands on the stack.
// Mutates `loads`, which callers always pass as a fresh copy.
function startPrefetches(
	session: number,
	loads: Map<PrefetchSubmenuAction, Remote>,
	content: Remote,
): Effect[] {
	if (content.status !== "ready") return [];
	const effects: Effect[] = [];
	for (const { action } of content.items) {
		if (action.kind !== "prefetchSubmenu" || loads.has(action)) continue;
		loads.set(action, LOADING);
		effects.push(loadEffect(session, action));
	}
	return effects;
}

function pushMenu(
	model: Model,
	action: AnySubmenuAction,
	breadcrumb: string[],
): [Model, Effect[]] {
	const loads = new Map(model.loads);
	const effects: Effect[] = [];
	let content: Remote;
	if (action.kind === "submenu") {
		content = { status: "ready", items: action.submenu };
	} else {
		const cached = loads.get(action);
		if (cached) {
			content = cached;
		} else {
			// Selected before its parent level ever mounted (e.g. show()'s own
			// root) -- start it now and show the loading state meanwhile.
			content = LOADING;
			loads.set(action, LOADING);
			effects.push(loadEffect(model.session, action));
		}
	}
	effects.push(...startPrefetches(model.session, loads, content));
	const scene: MenuScene = {
		kind: "menu",
		source: action.kind === "prefetchSubmenu" ? action : null,
		content,
		breadcrumb,
	};
	return [{ ...model, stack: [...model.stack, scene], loads }, effects];
}

function closed(model: Model): Model {
	return { ...model, stack: [], loads: new Map() };
}

// Pure: given the current model and an event, what should the model be
// next, and which side effects should run once the view has caught up?
// "back" pops one Scene, or closes entirely if already at the root -- same
// whether the Scene below is another chooser or a menu level.
function update(model: Model, msg: Msg): [Model, Effect[]] {
	switch (msg.type) {
		case "open":
			return pushMenu(
				{ session: model.session + 1, stack: [], loads: new Map() },
				msg.root,
				[],
			);
		case "select":
			return pushMenu(model, msg.action, msg.breadcrumb);
		case "loadSettled": {
			// Stale: from an earlier session, or this session was closed since.
			if (msg.session !== model.session || !model.loads.has(msg.action)) {
				return [model, []];
			}
			const loads = new Map(model.loads);
			loads.set(msg.action, msg.result);
			let onStack = false;
			const stack = model.stack.map((scene) => {
				if (scene.kind !== "menu" || scene.source !== msg.action) return scene;
				onStack = true;
				return { ...scene, content: msg.result };
			});
			// Its children only prefetch if it's actually showing -- a
			// prefetched-but-unvisited level doesn't fan out further.
			const effects = onStack
				? startPrefetches(model.session, loads, msg.result)
				: [];
			return [{ ...model, stack, loads }, effects];
		}
		case "openChooser":
			return [
				{
					...model,
					stack: [...model.stack, { kind: "chooser", spec: msg.spec }],
				},
				[],
			];
		case "back":
			return model.stack.length > 1
				? [{ ...model, stack: model.stack.slice(0, -1) }, []]
				: [closed(model), []];
		case "close":
			return [closed(model), []];
		case "runEffect":
			return [closed(model), [() => msg.run()]];
	}
}

// Cancels the reveal-delay machinery without fully closing -- used both on
// a real full close and whenever a chooser scene mounts (chooser-runtime's
// hs.chooser shows itself immediately, natively, so there's nothing left
// to "reveal" once one's on screen; see mountChooserScene()).
function stopRevealTimerAndPlaceholder(): void {
	if (revealTimer) {
		revealTimer.stop();
		revealTimer = null;
	}
	destroyDot();
}

function destroyAnimated(a: Animated | null): void {
	if (!a) return;
	stop(a.target);
	a.canvas.destroy();
}

function destroyDot(): void {
	destroyAnimated(dot);
	dot = null;
}

function destroyPanel(): void {
	destroyAnimated(panel);
	panel = null;
}

function dispatch(msg: Msg): void {
	const [next, effects] = update(model, msg);
	const prevTop = model.stack[model.stack.length - 1];
	const nextTop = next.stack[next.stack.length - 1];
	if (nextTop !== prevTop) {
		mounted?.hide();
		// A menu level's hide() leaves its canvas up so the next level can
		// glide from it (see renderMenu()); anything else replaces it.
		if (nextTop?.kind !== "menu") destroyPanel();
		mounted = nextTop ? mountScene(nextTop, next.stack.length > 1) : null;
	}
	if (next.stack.length === 0) {
		stopRevealTimerAndPlaceholder();
		stopAll();
		revealed = false;
	}
	model = next;
	// Deferred: an effect often shows a real window (hs.chooser, launches an app,
	// ...) or otherwise interacts with focus -- running it synchronously
	// here, still inside whatever eventtap/onSelect callback triggered this
	// dispatch (itself mid-teardown of the previous scene's own canvas/tap),
	// can leave the new thing created but never actually brought forward.
	// One tick later, we're clear of that callback and it shows reliably.
	for (const effect of effects) hs.timer.doAfter(0, () => effect(dispatch));
}

function mountScene(scene: Scene, canGoBack: boolean): MountedScene {
	return scene.kind === "menu"
		? mountMenu(scene)
		: mountChooserScene(scene.spec, canGoBack);
}

// Selectable items of a menu scene -- none while loading or failed, so
// only Escape/Delete do anything there (other keys are still swallowed).
function sceneItems(scene: MenuScene): MenuItem[] {
	return scene.content.status === "ready" ? scene.content.items : [];
}

// The scene's breadcrumb plus its loaded title, if any -- what's drawn,
// and what child levels extend.
function sceneBreadcrumb(scene: MenuScene): string[] {
	const { content } = scene;
	return content.status === "ready" && content.title
		? [...scene.breadcrumb, content.title]
		: scene.breadcrumb;
}

function mountMenu(scene: MenuScene): MountedScene {
	// Blind-typing grace period: keys are live immediately, but nothing is
	// drawn until revealMenu() fires (or this mount is replaced by
	// something else first) -- see armRevealTimer()/revealMenu() below.
	if (revealed) renderMenu(scene);
	bindKeys(sceneItems(scene), sceneBreadcrumb(scene));
	startFocusWatcher();
	startMouseWatcher();
	return {
		hide: () => {
			tap?.stop();
			tap = null;
			mouseTap?.stop();
			mouseTap = null;
			stopFocusWatcher();
		},
	};
}

function mountChooserScene(
	spec: ChooserSpec,
	canGoBack: boolean,
): MountedScene {
	stopRevealTimerAndPlaceholder();
	revealed = true; // committed past the reveal-placeholder phase for the rest of this session
	return mountChooser(
		spec,
		() => dispatch({ type: "close" }),
		(nextSpec) => dispatch({ type: "openChooser", spec: nextSpec }),
		canGoBack ? () => dispatch({ type: "back" }) : undefined,
	);
}

function cancelRevealTimer(): void {
	if (revealTimer) {
		revealTimer.stop();
		revealTimer = null;
	}
}

// Called on every keydown so a user blind-typing a multi-key chain keeps
// getting a fresh reveal window as long as they keep moving. No-ops once
// revealed: showing the menu is sticky, session-wide, not re-armed per
// submenu level.
function armRevealTimer(): void {
	cancelRevealTimer();
	if (revealed) return;
	revealTimer = hs.timer.doAfter(REVEAL_DELAY_SECONDS, () => {
		revealTimer = null;
		revealMenu();
	});
}

function resolveIcon(opt: MenuItem): string | HSImage | null {
	if (opt.icon) return opt.icon;
	if (opt.action.kind === "app") {
		return HSImage.fromAppBundle(opt.action.bundleID);
	}
	return null;
}

// What an "app" MenuAction does -- exported so modules that bring an app
// forward from their own callbacks (e.g. zellij-menu.ts after a switch)
// get the same behavior. launchOrFocus() alone launches/unhides but
// doesn't reliably make an already-running app frontmost, hence the
// explicit activate() once it resolves.
export async function focusApp(bundleID: string): Promise<void> {
	await hs.application.launchOrFocus(bundleID);
	hs.application.matchingBundleID(bundleID)?.activate();
}

function runShellCommand(path: string, args: readonly string[]): void {
	const task = hs.task.create(path, [...args], null, null, null);
	task.start();
}

// The one place that decides what "selecting" an item does, shared by the
// keydown handler and renderMenu's mouseCallback, so a click and the
// matching keypress always behave identically. Turns a MenuAction into a
// Msg and hands it to dispatch() -- "submenu" and "chooser" grow the
// stack; everything else normalizes to "runEffect" (close everything, then
// run this side effect).
function selectOption(opt: MenuItem, breadcrumb: string[]): void {
	const action = opt.action;
	switch (action.kind) {
		case "submenu":
		case "prefetchSubmenu":
			dispatch({
				type: "select",
				action,
				breadcrumb: [...breadcrumb, opt.label],
			});
			break;
		case "chooser": {
			// Most spec() builders resolve synchronously, but
			// process-explorer.ts's needs an async `ps` shell-out first.
			const resolved = action.spec();
			if (resolved instanceof Promise) {
				void resolved.then((spec) => dispatch({ type: "openChooser", spec }));
			} else {
				dispatch({ type: "openChooser", spec: resolved });
			}
			break;
		}
		case "app":
			dispatch({
				type: "runEffect",
				run: () => focusApp(action.bundleID),
			});
			break;
		case "cmd":
			dispatch({
				type: "runEffect",
				run: () => runShellCommand(action.path, action.args),
			});
			break;
		case "url":
			dispatch({
				type: "runEffect",
				run: () => hs.urlevent.openURL(action.url),
			});
			break;
		case "callback":
			dispatch({ type: "runEffect", run: action.run });
			break;
	}
}

// ============================================================
// LAYOUT / RENDERING
// ============================================================

function placeholderRestTopLeft(half: "screen" | "left"): {
	x: number;
	y: number;
} {
	const sf = hs.screen.main()!.frame;
	const size = Theme.placeholderCanvasSize;
	const centerX = sf.x + sf.w / 2;
	const cy = sf.y + sf.h / 2;
	if (half === "left") {
		return { x: centerX - SPLIT_GAP_PX / 2 - size, y: cy - size / 2 };
	}
	return { x: centerX - size / 2, y: cy - size / 2 };
}

function menuRestTopLeft(w: number, h: number): { x: number; y: number } {
	const sf = hs.screen.main()!.frame;
	const centerX = sf.x + sf.w / 2;
	return { x: centerX + SPLIT_GAP_PX / 2, y: sf.y + (sf.h - h) / 2 };
}

function buildPlaceholderCanvas(topLeft: { x: number; y: number }): HSCanvas {
	const size = Theme.placeholderCanvasSize;
	const c = hs.canvas.create(
		flipFrameY({ x: topLeft.x, y: topLeft.y, w: size, h: size }),
	);
	c.appendElements([
		Canvas.circle("fill", {
			fillColor: canvasColor(Theme.background, Theme.backgroundAlpha),
			center: { x: size / 2, y: size / 2 },
			radius: size / 2,
		}),
		Canvas.circle("stroke", {
			strokeColor: canvasColor(Theme.border),
			strokeWidth: Theme.placeholderRingStrokeWidth,
			center: { x: size / 2, y: size / 2 },
			radius: size / 2 - 0.5,
		}),
		Canvas.circle("fill", {
			fillColor: canvasColor(Theme.border),
			center: { x: size / 2, y: size / 2 },
			radius: Theme.placeholderDotDiameter / 2,
		}),
	]);
	c.levelValue(OVERLAY_LEVEL);
	c.clickActivating(false);
	return c;
}

// HSCanvas has no window-level alpha, so "fading" the placeholder means
// scaling each of its 3 elements' own fillColor/strokeColor alpha by
// `factor` -- indices and base alphas mirror buildPlaceholderCanvas()'s
// appendElements() above exactly.
function setPlaceholderOpacity(c: HSCanvas, factor: number): void {
	c.setElementAttribute(
		0,
		"fillColor",
		canvasColor(Theme.background, Theme.backgroundAlpha * factor),
	);
	c.setElementAttribute(1, "strokeColor", canvasColor(Theme.border, factor));
	c.setElementAttribute(2, "fillColor", canvasColor(Theme.border, factor));
}

function showPlaceholderInitial(): void {
	const rest = placeholderRestTopLeft("screen");
	const c = buildPlaceholderCanvas(below(rest));
	const target = canvasTarget(
		c,
		{ topLeft: below(rest), opacity: 0 },
		{ opacity: setPlaceholderOpacity },
	);
	c.show();
	dot = { canvas: c, target };
	run(target, Anim.dotEnter(rest));
}

function revealMenu(): void {
	if (revealed) return;
	revealed = true;
	cancelRevealTimer();

	if (dot) run(dot.target, Anim.dotSplit(placeholderRestTopLeft("left")));

	// The reveal timer only ever fires while a "menu" scene is still on top
	// (mountChooserScene() cancels it the instant a chooser mounts), so this
	// is always safe -- defensive check only.
	const top = model.stack[model.stack.length - 1];
	if (!top || top.kind !== "menu") return;
	renderMenu(top, { entering: true });
}

interface RenderOpts {
	entering?: boolean;
}

// The one non-selectable row a menu scene shows instead of items: while
// its PrefetchSubmenu is loading, after it failed, or when it loaded
// nothing at all.
function statusText(content: Remote): string | null {
	switch (content.status) {
		case "loading":
			return "Loading…";
		case "failed":
			return `⚠ ${content.error}`;
		case "ready":
			return content.items.length === 0 ? "Nothing here" : null;
	}
}

function renderMenu(scene: MenuScene, opts: RenderOpts = {}): void {
	const breadcrumb = sceneBreadcrumb(scene);
	const options = sceneItems(scene);
	const status = statusText(scene.content);
	const rowCount = options.length + (status ? 1 : 0);

	const { paddingX, paddingY, fontSize, breadcrumbFontSize, gap } = Theme;
	const breadcrumbSpace = gap + breadcrumbFontSize;
	const w = 320;
	let h = paddingY * 2 + rowCount * (fontSize + gap) - gap;
	if (breadcrumb.length > 0) h += breadcrumbSpace;

	const restTopLeft = menuRestTopLeft(w, h);
	const { x, y } = restTopLeft;

	const c = hs.canvas.create(flipFrameY({ x, y, w, h }));
	c.appendElements([
		Canvas.rectangle("strokeAndFill", {
			fillColor: canvasColor(Theme.background, Theme.backgroundAlpha),
			strokeColor: canvasColor(Theme.border),
			strokeWidth: Theme.borderWidth,
			roundedRectRadii: cornerRadii(Theme.cornerRadius),
		}),
	]);

	let yOffset = paddingY;
	if (breadcrumb.length > 0) {
		c.appendElements([
			Canvas.text(breadcrumb.join(" > "), {
				textColor: canvasColor(Theme.textDim),
				textSize: breadcrumbFontSize,
				frame: {
					x: paddingX,
					y: paddingY,
					w: w - paddingX * 2,
					h: breadcrumbFontSize * Theme.textFrameHeightMultiplier,
				},
			}),
		]);
		yOffset += breadcrumbSpace;
	}

	const iconColX = paddingX;
	const iconColW = Theme.iconColW;
	const iconGap = 8;
	const keyColX = iconColX + iconColW + iconGap;
	const keyColW = Theme.keyChipSize;
	const keyGap = 8;
	const textX = keyColX + keyColW + keyGap;
	const rowTextH = fontSize * Theme.textFrameHeightMultiplier;

	options.forEach((opt, i) => {
		const rowY = yOffset + i * (fontSize + gap);
		const id = i + 1;

		const icon = resolveIcon(opt);
		if (icon) {
			if (typeof icon === "string") {
				c.appendElements([
					Canvas.text(icon, {
						textSize: fontSize,
						textAlignment: "center",
						frame: { x: iconColX, y: rowY, w: iconColW, h: rowTextH },
						id,
						trackMouseDown: true,
					}),
				]);
			} else {
				const imageSize = Theme.imageIconSize;
				c.appendElements([
					Canvas.image({
						image: icon,
						imageScaling: "scaleProportionally",
						frame: {
							x: iconColX + (iconColW - imageSize) / 2,
							y: rowY,
							w: imageSize,
							h: imageSize,
						},
						id,
						trackMouseDown: true,
					}),
				]);
			}
		}

		// Keycap-style chip behind the key character: a background rect plus a
		// centered, bold text element, both carrying id/trackMouseDown like
		// every other row element -- otherwise this area of the row becomes a
		// dead click zone against the shared mouseCallback below.
		c.appendElements([
			Canvas.rectangle("fill", {
				fillColor: canvasColor(Theme.surface),
				roundedRectRadii: cornerRadii(Theme.keyChipRadius),
				frame: { x: keyColX, y: rowY, w: keyColW, h: rowTextH },
				id,
				trackMouseDown: true,
			}),
			Canvas.text(opt.key, {
				textColor: canvasColor(Theme.text),
				textWeight: "bold",
				textSize: fontSize,
				textAlignment: "center",
				frame: { x: keyColX, y: rowY, w: keyColW, h: rowTextH },
				id,
				trackMouseDown: true,
			}),
		]);

		// Label + submenu arrow: two adjacent text elements (no hs.styledtext
		// in v2 to mix styles within one string -- see file header).
		const hasSubmenu =
			opt.action.kind === "submenu" || opt.action.kind === "prefetchSubmenu";
		const arrowW = hasSubmenu ? 24 : 0;
		c.appendElements([
			Canvas.text(opt.label, {
				textColor: canvasColor(Theme.text),
				textSize: fontSize,
				frame: {
					x: textX,
					y: rowY,
					w: w - textX - paddingX - arrowW,
					h: rowTextH,
				},
				id,
				trackMouseDown: true,
			}),
		]);
		if (hasSubmenu) {
			c.appendElements([
				Canvas.text("→", {
					textColor: canvasColor(Theme.textDim),
					textSize: fontSize,
					frame: { x: w - paddingX - arrowW, y: rowY, w: arrowW, h: rowTextH },
					id,
					trackMouseDown: true,
				}),
			]);
		}
	});

	// No id/trackMouseDown: there's nothing to select, and a click on it
	// shouldn't count as a click outside either (see withinCanvas()).
	if (status) {
		c.appendElements([
			Canvas.text(status, {
				textColor: canvasColor(Theme.textDim),
				textSize: fontSize,
				frame: {
					x: paddingX,
					y: yOffset + options.length * (fontSize + gap),
					w: w - paddingX * 2,
					h: rowTextH,
				},
			}),
		]);
	}

	c.levelValue(OVERLAY_LEVEL);
	c.clickActivating(false);
	c.mouseCallback((_canvas, message, id) => {
		if (message !== "mouseDown") return;
		const opt = options[(id as number) - 1];
		if (opt) selectOption(opt, breadcrumb);
	});

	// A previous panel still up means this is a content swap or level
	// change: take over its current position and glide to the new rest,
	// instead of popping in there. New canvas shown before the old one is
	// destroyed, so there's no blank frame in between.
	const rest = { x, y };
	const previous = panel;
	const start = previous
		? previous.target.current.topLeft
		: opts.entering
			? below(rest)
			: rest;
	const target = canvasTarget(c, { topLeft: start, opacity: 1 });
	c.show();
	destroyAnimated(previous);
	panel = { canvas: c, target };
	if (previous) run(target, Anim.panelMove(rest));
	else if (opts.entering) run(target, Anim.panelEnter(rest));
}

// ============================================================
// INPUT
// ============================================================

function bindKeys(options: MenuItem[], breadcrumb: string[]): void {
	tap?.stop();

	tap = hs.eventtap.addWatcher(
		[KEY_DOWN],
		(event) => {
			armRevealTimer();

			// "escape"/"delete" are control keys with no useful .characters value,
			// so those two stay identified by name via the keyCode->name reverse
			// lookup in hs.keycodes.map.
			const codeMap = hs.keycodes.map as Record<string, unknown>;
			const keyName = String(codeMap[String(event.keyCode)] ?? "");

			if (keyName === "escape") {
				dispatch({ type: "close" });
				return hs.eventtap.consume;
			}

			if (keyName === "delete") {
				dispatch({ type: "back" });
				return hs.eventtap.consume;
			}

			// Every other binding matches against the actual Unicode text this
			// keypress produces -- shift and keyboard layout already applied by
			// the OS. Far more reliable than reverse-mapping keyCode through
			// hs.keycodes.map and hand-rolling a shift-to-uppercase hack, which
			// only ever covered plain a-z letters and silently never matched
			// punctuation keys like "/", "," or ".".
			const pressed = event.characters ?? "";
			for (const opt of options) {
				if (pressed === opt.key) {
					selectOption(opt, breadcrumb);
					return hs.eventtap.consume;
				}
			}
			return hs.eventtap.consume; // swallow unmatched keys
		},
		false,
	);

	if (!tap) {
		hs.ui
			.alert(
				"Leader menu: eventtap failed to start — check Accessibility permissions",
			)
			.show();
		dispatch({ type: "close" });
		return;
	}
	tap.start();
}

function withinCanvas(point: { x: number; y: number }): boolean {
	if (!panel) return false;
	const { canvas } = panel;
	// canvas.frame() comes back in AppKit coordinates; point (a mouse event
	// location) is in Hammerspoon coordinates -- flipFrameY() is self-inverse,
	// so it converts the frame back rather than the Hammerspoon rect forward.
	const f = flipFrameY(
		canvas.frame() as { x: number; y: number; w: number; h: number },
	);
	return (
		point.x >= f.x &&
		point.x <= f.x + f.w &&
		point.y >= f.y &&
		point.y <= f.y + f.h
	);
}

function startMouseWatcher(): void {
	mouseTap?.stop();
	mouseTap = hs.eventtap.addWatcher(
		[LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN],
		(event) => {
			const loc = event.location as { x: number; y: number };
			if (!withinCanvas(loc)) dispatch({ type: "close" });
			return hs.eventtap.emit; // let the click still reach whatever's underneath
		},
		false,
	);
	mouseTap?.start();
}

// ============================================================
// PUBLIC API
// ============================================================

export interface ShowOptions {
	// Skip the REVEAL_DELAY_SECONDS wait and draw the menu right away -- for
	// menus whose items are worth reading (e.g. zellij-menu.ts's live
	// "Switch session → X" label) rather than driven from muscle memory.
	// Sticky for the session: once revealed, armRevealTimer() no-ops.
	revealImmediately?: boolean;
}

// The root is itself a submenu action: Submenu(tree) for a static menu, or
// a PrefetchSubmenu to open straight into its loading state (e.g. init.ts's
// Hyper+G showing zellij-menu.ts's node directly).
export function show(root: AnySubmenuAction, opts: ShowOptions = {}): void {
	showStartMs = nowMs();
	dispatch({ type: "close" }); // defensive: never stack a new menu/timers on a stale one
	showPlaceholderInitial();
	dispatch({ type: "open", root }); // eventtap is live immediately; the real menu isn't drawn yet
	if (opts.revealImmediately) revealMenu();
	else armRevealTimer();
}
