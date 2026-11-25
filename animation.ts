// Animations as data, plus the small engine that runs them.
//
// An Animation is a plain description -- which property, to what value, how
// long, which easing -- built with tween()/parallel() and never touching
// hs.* itself. run() plays one against a Target (an adapter over whatever
// actually moves, e.g. canvasTarget() below). The engine's rules are what
// keep motion smooth when things change mid-flight:
// - a new run() on a target cancels that target's previous run, so two
//   tweens can never fight over the same property;
// - a tween with no `from` starts from the target's current value, so
//   retargeting mid-flight continues from wherever it currently is;
// - this file owns the only animation timer -- one shared ticker, running
//   only while something is animating.

import { flipTopLeftY } from "./screen-geometry";

// ============================================================
// DESCRIPTION
// ============================================================

export interface Vec {
	x: number;
	y: number;
}

// Hammerspoon (top-left origin) coordinates; canvasTarget() flips them.
export interface Values {
	topLeft: Vec;
	opacity: number;
}

export type Prop = keyof Values;
export type Ease = (t: number) => number;

export const easeOutCubic: Ease = (t) => 1 - Math.pow(1 - t, 3);

type Tween = {
	[P in Prop]: {
		kind: "tween";
		prop: P;
		from?: Values[P];
		to: Values[P];
		duration: number; // seconds
		ease: Ease;
	};
}[Prop];

export type Animation = Tween | { kind: "parallel"; anims: Animation[] };

export function tween<P extends Prop>(
	prop: P,
	to: Values[P],
	duration: number,
	opts: { from?: Values[P]; ease?: Ease } = {},
): Animation {
	return {
		kind: "tween",
		prop,
		to,
		from: opts.from,
		duration,
		ease: opts.ease ?? easeOutCubic,
	} as Tween;
}

export function parallel(...anims: Animation[]): Animation {
	return { kind: "parallel", anims };
}

// ============================================================
// TARGETS
// ============================================================

export interface Target {
	readonly current: Values; // last values written -- what an omitted `from` resolves to
	set<P extends Prop>(prop: P, value: Values[P]): void;
}

// HSCanvas has no window-level alpha in v2, so "opacity" means whatever
// the canvas's owner says it means (typically re-tinting each element's own
// colors) -- omit opts.opacity for a canvas that never fades.
export function canvasTarget(
	canvas: HSCanvas,
	initial: Values,
	opts: { opacity?: (canvas: HSCanvas, value: number) => void } = {},
): Target {
	let current = initial;
	const apply = <P extends Prop>(prop: P, value: Values[P]): void => {
		if (prop === "topLeft") canvas.setTopLeft(flipTopLeftY(value as Vec));
		else opts.opacity?.(canvas, value as number);
	};
	apply("topLeft", initial.topLeft);
	apply("opacity", initial.opacity);
	return {
		get current() {
			return current;
		},
		set(prop, value) {
			current = { ...current, [prop]: value };
			apply(prop, value);
		},
	};
}

// ============================================================
// ENGINE
// ============================================================

export function nowMs(): number {
	return hs.timer.absoluteTime() / 1e6;
}

// A tween with its `from` resolved at run() time.
type Resolved = Tween & { start: Tween["to"] };

interface Run {
	tweens: Resolved[];
	startMs: number;
}

const runs = new Map<Target, Run>();
let ticker: HSTimer | null = null;

function flatten(anim: Animation): Tween[] {
	return anim.kind === "parallel" ? anim.anims.flatMap(flatten) : [anim];
}

function lerp<P extends Prop>(
	prop: P,
	a: Values[P],
	b: Values[P],
	e: number,
): Values[P] {
	if (prop === "topLeft") {
		const [p, q] = [a as Vec, b as Vec];
		return { x: p.x + (q.x - p.x) * e, y: p.y + (q.y - p.y) * e } as Values[P];
	}
	const [p, q] = [a as number, b as number];
	return (p + (q - p) * e) as Values[P];
}

// Applies one frame of `r` at `now`; true once every tween has finished.
function step(target: Target, r: Run, now: number): boolean {
	let done = true;
	for (const t of r.tweens) {
		const elapsed = (now - r.startMs) / (t.duration * 1000);
		const progress = t.duration > 0 ? Math.min(elapsed, 1) : 1;
		if (progress < 1) done = false;
		target.set(t.prop, lerp(t.prop, t.start, t.to, t.ease(progress)));
	}
	return done;
}

function tick(): void {
	const now = nowMs();
	for (const [target, r] of runs) {
		if (step(target, r, now)) runs.delete(target);
	}
	if (runs.size === 0) {
		ticker?.stop();
		ticker = null;
	}
}

export function run(target: Target, anim: Animation): void {
	const tweens = flatten(anim).map(
		(t) => ({ ...t, start: t.from ?? target.current[t.prop] }) as Resolved,
	);
	const r: Run = { tweens, startMs: nowMs() };
	// Frame 0 right away, so the target is never shown at a stale value
	// while waiting for the ticker's first tick.
	if (step(target, r, r.startMs)) {
		runs.delete(target);
		return;
	}
	runs.set(target, r);
	if (!ticker) {
		ticker = hs.timer.create(1 / 60, tick);
		ticker.start();
	}
}

// Call before destroying the thing a target drives.
export function stop(target: Target): void {
	runs.delete(target);
}

export function stopAll(): void {
	runs.clear();
	ticker?.stop();
	ticker = null;
}
