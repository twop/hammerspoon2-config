// Screen-coordinate conversion shared by every canvas-drawn UI in this
// config. Split out of leader-menu.ts so chooser-options-bar.ts (and
// chooser-runtime.ts's callers) can use it without creating an import
// cycle back through leader-menu.ts.
//
// Every position elsewhere in this config (screen frames, mouse event
// locations, animation points) is in ordinary Hammerspoon screen
// coordinates: top-left origin, y increasing downward. hs.canvas's window
// position -- create()/setFrame()/setTopLeft()/frame()/topLeft() -- is the
// one exception: it uses unflipped AppKit screen coordinates (origin at
// the bottom-left of the *primary* screen, y increasing upward; see
// hs.canvas's own module-level "Coordinate systems" docs). flipTopLeftY()/
// flipFrameY() are the only place that boundary gets crossed.

// Cached rather than looked up fresh on every call -- leader-menu.ts's
// animateCanvas() tick runs at 60fps, and a native hs.screen.primary()
// round-trip on every single frame was visibly janking the position
// tween. Invalidated only when the display configuration actually changes.
let cachedPrimaryScreenHeight: number | null = null;
hs.screen.on("change", () => {
	cachedPrimaryScreenHeight = null;
});

function primaryScreenHeight(): number {
	if (cachedPrimaryScreenHeight === null) {
		cachedPrimaryScreenHeight = hs.screen.primary()!.fullFrame.h;
	}
	return cachedPrimaryScreenHeight;
}

// setTopLeft()/topLeft() exchange a single point, reflected across the
// primary screen's full height -- self-inverse, so the same function
// converts a Hammerspoon point to its canvas-window equivalent and back.
export function flipTopLeftY(point: { x: number; y: number }): {
	x: number;
	y: number;
} {
	return { x: point.x, y: primaryScreenHeight() - point.y };
}

// create()/setFrame()/frame() exchange a whole rect anchored at its
// *bottom*-left corner in AppKit's y-up space, unlike setTopLeft()'s
// top-left point -- the height shifts which edge "y" refers to, so this
// isn't just flipTopLeftY() again. Still self-inverse (applying it to an
// already-AppKit-coordinate rect converts it back to Hammerspoon
// coordinates), so it's also used to read canvas.frame() back.
export function flipFrameY(rect: {
	x: number;
	y: number;
	w: number;
	h: number;
}): {
	x: number;
	y: number;
	w: number;
	h: number;
} {
	return {
		x: rect.x,
		y: primaryScreenHeight() - rect.y - rect.h,
		w: rect.w,
		h: rect.h,
	};
}
