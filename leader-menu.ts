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
import { flipTopLeftY, flipFrameY } from "./screen-geometry";
import { mountChooser, type ChooserSpec } from "./chooser-runtime";

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

export type MenuAction =
	| {
			kind: "submenu";
			submenu: MenuItem[] | (() => MenuItem[] | Promise<MenuItem[]>);
	  }
	| { kind: "chooser"; spec: () => ChooserSpec | Promise<ChooserSpec> }
	| { kind: "app"; bundleID: string }
	| { kind: "cmd"; path: string; args?: string[] }
	| { kind: "url"; url: string }
	| { kind: "callback"; run: () => void };

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
export type Scene =
	| { kind: "menu"; options: MenuItem[]; breadcrumb: string[] }
	| { kind: "chooser"; spec: ChooserSpec };

interface MountedScene {
	hide(): void;
}

// ============================================================
// TIMING / ANIMATION
// ============================================================

const REVEAL_DELAY_SECONDS = 0.5;
const PLACEHOLDER_ENTER_DURATION = 0.2;
const SPLIT_TRANSITION_DURATION = 0.22;
const SLIDE_OFFSET_PX = 14;
const SPLIT_GAP_PX = 24;

function nowMs(): number {
	return hs.timer.absoluteTime() / 1e6;
}

function easeOutCubic(t: number): number {
	return 1 - Math.pow(1 - t, 3);
}

interface AnimateOpts {
	fromPoint: { x: number; y: number };
	toPoint: { x: number; y: number };
	duration?: number;
	// Called every tick with the same eased progress (0-1) driving the
	// position tween, so a caller can layer in extra per-frame work (e.g.
	// opacity -- see setPlaceholderOpacity()) on this same timer instead of
	// running a second one alongside it.
	onTick?: (eased: number) => void;
	onComplete?: () => void;
}

// Tweens a canvas's position over opts.duration seconds, computing
// progress from wall-clock elapsed time each tick (not tick count).
// Registered in animTimers so a full teardown can stop it if the menu is
// torn down mid-flight. v1 also faded alpha here (canvas:alpha()) --
// HSCanvas has no window-level alpha/opacity method in v2 (confirmed
// absent from its full method list), so a fade has to animate each
// element's own fillColor/strokeColor alpha instead (via opts.onTick)
// rather than the window itself.
function animateCanvas(canvas: HSCanvas, opts: AnimateOpts): HSTimer | null {
	const durationMs = (opts.duration ?? 0.15) * 1000;
	const startMs = nowMs();
	const { fromPoint, toPoint } = opts;

	const tick = (): boolean => {
		const t = Math.min((nowMs() - startMs) / durationMs, 1);
		const e = easeOutCubic(t);
		canvas.setTopLeft(
			flipTopLeftY({
				x: fromPoint.x + (toPoint.x - fromPoint.x) * e,
				y: fromPoint.y + (toPoint.y - fromPoint.y) * e,
			}),
		);
		opts.onTick?.(e);
		return t >= 1;
	};

	if (tick()) {
		opts.onComplete?.();
		return null;
	}

	let timer: HSTimer;
	timer = hs.timer.create(1 / 60, () => {
		if (tick()) {
			timer.stop();
			animTimers.delete(timer);
			opts.onComplete?.();
		}
	});
	animTimers.add(timer);
	timer.start();
	return timer;
}

// ============================================================
// MODULE STATE
// ============================================================

let canvas: HSCanvas | null = null;
let placeholderCanvas: HSCanvas | null = null;
let tap: HSEventTap | null = null;
let mouseTap: HSEventTap | null = null;
let model: Scene[] = []; // the stack, bottom -> top; [] means fully closed
let mounted: MountedScene | null = null;
let revealed = false;
let revealTimer: HSTimer | null = null;
const animTimers = new Set<HSTimer>();
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

type Msg =
	| { type: "openSubmenu"; options: MenuItem[]; breadcrumb: string[] }
	| { type: "openChooser"; spec: ChooserSpec }
	| { type: "back" }
	| { type: "close" }
	| { type: "runEffect"; run: () => void }; // app/cmd/url/callback all normalize to this

type Cmd = (() => void) | null;

// Pure: given the current stack and an event, what should the stack be
// next, and is there a side effect ("Cmd") to run once the view has caught
// up? "back" pops one Scene, or closes entirely if already at the root --
// same whether the Scene below is another chooser or a menu level.
function update(stack: Scene[], msg: Msg): [Scene[], Cmd] {
	switch (msg.type) {
		case "openSubmenu":
			return [
				[
					...stack,
					{ kind: "menu", options: msg.options, breadcrumb: msg.breadcrumb },
				],
				null,
			];
		case "openChooser":
			return [[...stack, { kind: "chooser", spec: msg.spec }], null];
		case "back":
			return [stack.length > 1 ? stack.slice(0, -1) : [], null];
		case "close":
			return [[], null];
		case "runEffect":
			return [[], msg.run];
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
	for (const timer of animTimers) timer.stop();
	animTimers.clear();
	placeholderCanvas?.destroy();
	placeholderCanvas = null;
}

function dispatch(msg: Msg): void {
	const [next, cmd] = update(model, msg);
	const prevTop = model[model.length - 1];
	const nextTop = next[next.length - 1];
	if (nextTop !== prevTop) {
		mounted?.hide();
		mounted = nextTop ? mountScene(nextTop, next.length > 1) : null;
	}
	if (next.length === 0) {
		stopRevealTimerAndPlaceholder();
		revealed = false;
	}
	model = next;
	// Deferred: cmd often shows a real window (hs.chooser, launches an app,
	// ...) or otherwise interacts with focus -- running it synchronously
	// here, still inside whatever eventtap/onSelect callback triggered this
	// dispatch (itself mid-teardown of the previous scene's own canvas/tap),
	// can leave the new thing created but never actually brought forward.
	// One tick later, we're clear of that callback and it shows reliably.
	if (cmd) hs.timer.doAfter(0, cmd);
}

function mountScene(scene: Scene, canGoBack: boolean): MountedScene {
	return scene.kind === "menu"
		? mountMenu(scene.options, scene.breadcrumb)
		: mountChooserScene(scene.spec, canGoBack);
}

function mountMenu(options: MenuItem[], breadcrumb: string[]): MountedScene {
	// Blind-typing grace period: keys are live immediately, but nothing is
	// drawn until revealMenu() fires (or this mount is replaced by
	// something else first) -- see armRevealTimer()/revealMenu() below.
	if (revealed) renderMenu(options, breadcrumb);
	bindKeys(options, breadcrumb);
	startFocusWatcher();
	startMouseWatcher();
	return {
		hide: () => {
			tap?.stop();
			tap = null;
			mouseTap?.stop();
			mouseTap = null;
			stopFocusWatcher();
			canvas?.destroy();
			canvas = null;
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

function runShellCommand(path: string, args: string[]): void {
	const task = hs.task.create(path, args, null, null, null);
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
		case "submenu": {
			// Resolved fresh on every selection (not cached) so it can reflect
			// live external state (e.g. zellij-menu.ts's session/tab lists).
			const newBreadcrumb = [...breadcrumb, opt.label];
			const resolved =
				typeof action.submenu === "function"
					? action.submenu()
					: action.submenu;
			if (resolved instanceof Promise) {
				void resolved.then((options) =>
					dispatch({ type: "openSubmenu", options, breadcrumb: newBreadcrumb }),
				);
			} else {
				dispatch({
					type: "openSubmenu",
					options: resolved,
					breadcrumb: newBreadcrumb,
				});
			}
			break;
		}
		case "chooser": {
			// Mirrors the "submenu" case above: most spec() builders resolve
			// synchronously, but process-explorer.ts's needs an async `ps`
			// shell-out first.
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
				run: async () => {
					await hs.application.launchOrFocus(action.bundleID);
					hs.application.matchingBundleID(action.bundleID)?.activate();
				},
			});
			break;
		case "cmd":
			dispatch({
				type: "runEffect",
				run: () => runShellCommand(action.path, action.args ?? []),
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
	const start = { x: rest.x, y: rest.y + SLIDE_OFFSET_PX };
	const c = buildPlaceholderCanvas(start);
	setPlaceholderOpacity(c, 0);
	c.show();
	placeholderCanvas = c;
	animateCanvas(c, {
		fromPoint: start,
		toPoint: rest,
		duration: PLACEHOLDER_ENTER_DURATION,
		onTick: (e) => setPlaceholderOpacity(c, e),
	});
}

function revealMenu(): void {
	if (revealed) return;
	revealed = true;
	cancelRevealTimer();

	if (placeholderCanvas) {
		const leftRest = placeholderRestTopLeft("left");
		animateCanvas(placeholderCanvas, {
			fromPoint: flipTopLeftY(
				placeholderCanvas.topLeft() as { x: number; y: number },
			),
			toPoint: leftRest,
			duration: SPLIT_TRANSITION_DURATION,
		});
	}

	// The reveal timer only ever fires while a "menu" scene is still on top
	// (mountChooserScene() cancels it the instant a chooser mounts), so this
	// is always safe -- defensive check only.
	const top = model[model.length - 1];
	if (!top || top.kind !== "menu") return;
	renderMenu(top.options, top.breadcrumb, { entering: true });
}

interface RenderOpts {
	entering?: boolean;
}

function renderMenu(
	options: MenuItem[],
	breadcrumb: string[],
	opts: RenderOpts = {},
): void {
	canvas?.destroy();

	const { paddingX, paddingY, fontSize, breadcrumbFontSize, gap } = Theme;
	const breadcrumbSpace = gap + breadcrumbFontSize;
	const w = 320;
	let h = paddingY * 2 + options.length * (fontSize + gap) - gap;
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
		const arrowW = opt.action.kind === "submenu" ? 24 : 0;
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
		if (opt.action.kind === "submenu") {
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

	c.levelValue(OVERLAY_LEVEL);
	c.clickActivating(false);
	c.mouseCallback((_canvas, message, id) => {
		if (message !== "mouseDown") return;
		const opt = options[(id as number) - 1];
		if (opt) selectOption(opt, breadcrumb);
	});

	if (opts.entering) {
		const restPos = { x, y };
		const startPos = { x, y: y + SLIDE_OFFSET_PX };
		c.setTopLeft(flipTopLeftY(startPos));
		c.show();
		animateCanvas(c, {
			fromPoint: startPos,
			toPoint: restPos,
			duration: SPLIT_TRANSITION_DURATION,
		});
	} else {
		c.show();
	}
	canvas = c;
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
	if (!canvas) return false;
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

export function show(menuTree: MenuItem[]): void {
	showStartMs = nowMs();
	dispatch({ type: "close" }); // defensive: never stack a new menu/timers on a stale one
	showPlaceholderInitial();
	dispatch({ type: "openSubmenu", options: menuTree, breadcrumb: [] }); // eventtap is live immediately; the real menu isn't drawn yet
	armRevealTimer();
}
