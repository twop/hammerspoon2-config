// LeaderKey-style popup menu, drawn with hs.canvas, triggered by a single
// hotkey (wired up in init.ts) and navigated via key presses or clicks.
// Port of leader-menu.lua -- see that file's header for the original menu
// tree format; the shape survives here as the MenuItem/MenuAction types
// below, now a proper tagged union instead of "exactly one of five
// optional fields is present".
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

interface StackFrame {
	options: MenuItem[];
	breadcrumb: string[];
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
	onComplete?: () => void;
}

// Tweens a canvas's position over opts.duration seconds, computing
// progress from wall-clock elapsed time each tick (not tick count).
// Registered in animTimers so closeMenu() can stop it if the menu is torn
// down mid-flight. v1 also faded alpha here (canvas:alpha()) -- HSCanvas
// has no window-level alpha/opacity method in v2 (confirmed absent from
// its full method list), so the reveal/enter animations are a position
// slide only now, no fade-in.
function animateCanvas(canvas: HSCanvas, opts: AnimateOpts): HSTimer | null {
	const durationMs = (opts.duration ?? 0.15) * 1000;
	const startMs = nowMs();
	const { fromPoint, toPoint } = opts;

	const tick = (): boolean => {
		const t = Math.min((nowMs() - startMs) / durationMs, 1);
		const e = easeOutCubic(t);
		canvas.setTopLeft({
			x: fromPoint.x + (toPoint.x - fromPoint.x) * e,
			y: fromPoint.y + (toPoint.y - fromPoint.y) * e,
		});
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
let stack: StackFrame[] = [];
let revealed = false;
let revealTimer: HSTimer | null = null;
const animTimers = new Set<HSTimer>();
let showStartMs = 0;

// Focus-steal watcher state (see startFocusWatcher()).
let watchedAppElement: HSAXElement | null = null;
const onFocusedWindowChanged = (
	_notification: string,
	_element: HSAXElement,
): void => closeMenu("focus stolen");

// Rebinds the focusedWindowChanged watch to whichever app is now frontmost.
// Split out from onDidActivate so startFocusWatcher() can seed it for the
// already-frontmost app at show()-time without also closing the menu it's
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
	closeMenu("app activated");
};

// ============================================================
// CORE
// ============================================================

function closeMenu(_source: string): void {
	if (revealTimer) {
		revealTimer.stop();
		revealTimer = null;
	}
	for (const timer of animTimers) timer.stop();
	animTimers.clear();

	canvas?.destroy();
	canvas = null;
	placeholderCanvas?.destroy();
	placeholderCanvas = null;

	tap?.stop();
	tap = null;
	mouseTap?.stop();
	mouseTap = null;

	hs.application.off("didActivate", onDidActivate);
	if (watchedAppElement) {
		hs.ax.off(
			watchedAppElement,
			"focusedWindowChanged",
			onFocusedWindowChanged,
		);
		watchedAppElement = null;
	}

	stack = [];
	revealed = false;
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

// Pushes a resolved submenu onto the stack and shows it -- the shared tail
// end of entering a submenu, regardless of whether it resolved
// synchronously or (e.g. zellij-menu.ts's zellij-CLI-backed lists, since
// v2 has no synchronous shell-out) via a Promise.
function pushAndRenderSubmenu(
	submenuOptions: MenuItem[],
	newBreadcrumb: string[],
): void {
	stack.push({ options: submenuOptions, breadcrumb: newBreadcrumb });
	if (revealed) renderMenu(submenuOptions, newBreadcrumb);
	bindKeys(submenuOptions, newBreadcrumb);
}

// The one place that decides what "selecting" an item does, shared by the
// keydown handler and renderMenu's mouseCallback, so a click and the
// matching keypress always behave identically.
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
				void resolved.then((items) =>
					pushAndRenderSubmenu(items, newBreadcrumb),
				);
			} else {
				pushAndRenderSubmenu(resolved, newBreadcrumb);
			}
			break;
		}
		case "app":
			closeMenu("app launched");
			void hs.application.launchOrFocus(action.bundleID);
			break;
		case "cmd":
			closeMenu("cmd started");
			runShellCommand(action.path, action.args ?? []);
			break;
		case "url":
			closeMenu("url opened");
			hs.urlevent.openURL(action.url);
			break;
		case "callback":
			closeMenu("callback called");
			// Deferred: action.run() often shows a real window (hs.chooser, etc.)
			// -- calling that synchronously, still inside the keyDown eventtap
			// callback that's mid-teardown of the menu's own canvas/tap, can leave
			// the new window created but never actually brought forward. One tick
			// later, we're clear of the eventtap callback and it shows reliably.
			hs.timer.doAfter(0, action.run);
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
	const c = hs.canvas.create({ x: topLeft.x, y: topLeft.y, w: size, h: size });
	c.appendElements([
		{
			type: "circle",
			action: "fill",
			fillColor: canvasColor(Theme.background, Theme.backgroundAlpha),
			center: { x: size / 2, y: size / 2 },
			radius: size / 2,
		},
		{
			type: "circle",
			action: "stroke",
			strokeColor: canvasColor(Theme.border),
			strokeWidth: Theme.placeholderRingStrokeWidth,
			center: { x: size / 2, y: size / 2 },
			radius: size / 2 - 0.5,
		},
		{
			type: "circle",
			action: "fill",
			fillColor: canvasColor(Theme.border),
			center: { x: size / 2, y: size / 2 },
			radius: Theme.placeholderDotDiameter / 2,
		},
	]);
	c.levelValue(OVERLAY_LEVEL);
	c.clickActivating(false);
	return c;
}

function showPlaceholderInitial(): void {
	const rest = placeholderRestTopLeft("screen");
	const start = { x: rest.x, y: rest.y + SLIDE_OFFSET_PX };
	const c = buildPlaceholderCanvas(start);
	c.show();
	placeholderCanvas = c;
	animateCanvas(c, {
		fromPoint: start,
		toPoint: rest,
		duration: PLACEHOLDER_ENTER_DURATION,
	});
}

function revealMenu(): void {
	if (revealed) return;
	revealed = true;
	cancelRevealTimer();

	if (placeholderCanvas) {
		const leftRest = placeholderRestTopLeft("left");
		animateCanvas(placeholderCanvas, {
			fromPoint: placeholderCanvas.topLeft() as { x: number; y: number },
			toPoint: leftRest,
			duration: SPLIT_TRANSITION_DURATION,
		});
	}

	const top = stack[stack.length - 1]!;
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

	const c = hs.canvas.create({ x, y, w, h });
	c.appendElements([
		{
			type: "rectangle",
			action: "strokeAndFill",
			fillColor: canvasColor(Theme.background, Theme.backgroundAlpha),
			strokeColor: canvasColor(Theme.border),
			strokeWidth: Theme.borderWidth,
			roundedRectRadii: Theme.cornerRadius,
		},
	]);

	let yOffset = paddingY;
	if (breadcrumb.length > 0) {
		c.appendElements([
			{
				type: "text",
				text: breadcrumb.join(" > "),
				textColor: canvasColor(Theme.textDim),
				textSize: breadcrumbFontSize,
				frame: {
					x: paddingX,
					y: paddingY,
					w: w - paddingX * 2,
					h: breadcrumbFontSize * Theme.textFrameHeightMultiplier,
				},
			},
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
					{
						type: "text",
						text: icon,
						textSize: fontSize,
						textAlignment: "center",
						frame: { x: iconColX, y: rowY, w: iconColW, h: rowTextH },
						id,
						trackMouseDown: true,
					},
				]);
			} else {
				const imageSize = Theme.imageIconSize;
				c.appendElements([
					{
						type: "image",
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
					},
				]);
			}
		}

		// Keycap-style chip behind the key character: a background rect plus a
		// centered, bold text element, both carrying id/trackMouseDown like
		// every other row element -- otherwise this area of the row becomes a
		// dead click zone against the shared mouseCallback below.
		c.appendElements([
			{
				type: "rectangle",
				action: "fill",
				fillColor: canvasColor(Theme.surface),
				roundedRectRadii: {
					xRadius: Theme.keyChipRadius,
					yRadius: Theme.keyChipRadius,
				},
				frame: { x: keyColX, y: rowY, w: keyColW, h: rowTextH },
				id,
				trackMouseDown: true,
			},
			{
				type: "text",
				text: opt.key,
				textColor: canvasColor(Theme.text),
				textWeight: "bold",
				textSize: fontSize,
				textAlignment: "center",
				frame: { x: keyColX, y: rowY, w: keyColW, h: rowTextH },
				id,
				trackMouseDown: true,
			},
		]);

		// Label + submenu arrow: two adjacent text elements (no hs.styledtext
		// in v2 to mix styles within one string -- see file header).
		const arrowW = opt.action.kind === "submenu" ? 24 : 0;
		c.appendElements([
			{
				type: "text",
				text: opt.label,
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
			},
		]);
		if (opt.action.kind === "submenu") {
			c.appendElements([
				{
					type: "text",
					text: "→",
					textColor: canvasColor(Theme.textDim),
					textSize: fontSize,
					frame: { x: w - paddingX - arrowW, y: rowY, w: arrowW, h: rowTextH },
					id,
					trackMouseDown: true,
				},
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
		c.setTopLeft(startPos);
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

			const codeMap = hs.keycodes.map as Record<string, unknown>;
			let pressed = String(codeMap[String(event.keyCode)] ?? "");
			if (
				event.flags.includes("shift") &&
				pressed.length === 1 &&
				/[a-z]/i.test(pressed)
			) {
				pressed = pressed.toUpperCase();
			}

			if (pressed === "escape") {
				closeMenu("esc pressed");
				return hs.eventtap.consume;
			}

			if (pressed === "delete") {
				if (stack.length <= 1) {
					closeMenu("backspace at root");
				} else {
					stack.pop();
					const parent = stack[stack.length - 1]!;
					if (revealed) renderMenu(parent.options, parent.breadcrumb);
					bindKeys(parent.options, parent.breadcrumb);
				}
				return hs.eventtap.consume;
			}

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
		closeMenu("listening failed to start");
		return;
	}
	tap.start();
}

function withinCanvas(point: { x: number; y: number }): boolean {
	if (!canvas) return false;
	const f = canvas.frame() as { x: number; y: number; w: number; h: number };
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
			if (!withinCanvas(loc)) closeMenu("click outside");
			return hs.eventtap.emit; // let the click still reach whatever's underneath
		},
		false,
	);
	mouseTap?.start();
}

// Close on focus loss: catches anything stealing focus WITHOUT a click --
// another app activating, Spotlight, a dialog, the screensaver, or (via
// the per-app focusedWindowChanged watch) a same-app window switch. See
// the file header for why this needed two primitives instead of v1's
// single hs.window.filter subscription.
function startFocusWatcher(): void {
	hs.application.on("didActivate", onDidActivate);
	watchAppElement(hs.application.frontmost());
}

// ============================================================
// PUBLIC API
// ============================================================

export function show(menuTree: MenuItem[]): void {
	showStartMs = nowMs();
	closeMenu("close at the start"); // defensive: never stack a new menu/timers on a stale one

	stack = [{ options: menuTree, breadcrumb: [] }];
	showPlaceholderInitial();
	bindKeys(menuTree, []); // eventtap is live immediately; the real menu isn't drawn yet
	startMouseWatcher();
	startFocusWatcher();
	armRevealTimer();
}
