// Typed builders for hs.canvas elements. The native API takes elements as
// loosely-typed dictionaries (hammerspoon.d.ts types them as loosely as
// `appendElements(elements: object[])`) with zero compile-time checking of
// which properties are valid for which element `type` -- every call site in
// this config used to hand-roll these as plain object literals, repeating
// the same property names by hand with nothing catching a typo or a
// property that doesn't apply to that element. This models the full element
// API (see Hammerspoon2's docs/canvas-guide.md) as a tagged union, one
// interface per element `type`, and a `Canvas.xxx(...)` builder per type.
//
// `action` is split into two unions rather than one: `fill`/`stroke`/
// `strokeAndFill` only make sense where an element actually has a
// fillColor/strokeColor to apply (the shape elements below), while `build`/
// `clip`/`skip` are generic path-pipeline actions available to anything
// that draws a shape. `resetClip` doesn't draw at all and isn't part of the
// action pipeline, so it has no `action` property. The shape elements take
// `action` as a required leading argument (it's the one decision that
// always matters for them); text/image/canvas keep it as an optional field
// since every current call site omits it and relies on the native default.
//
// hammerspoon.d.ts is deliberately left untouched -- it's a global ambient
// script with no top-level import/export, so giving it a cross-file type
// import would flip it into module mode and un-globalize every declaration
// in that 361KB file. Unnecessary anyway: CanvasElement[] already satisfies
// its existing object[]/Record<string, any> element-array parameters
// structurally.

import type { RGBA } from "./nord-theme";

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Transformation {
	m11: number;
	m12: number;
	m21: number;
	m22: number;
	tX: number;
	tY: number;
}

export interface BezierPoint extends Point {
	c1x?: number;
	c1y?: number;
	c2x?: number;
	c2y?: number;
}

// fill/stroke/strokeAndFill only make sense where fillColor/strokeColor
// apply -- the shape elements below. build/clip/skip are the generic
// path-pipeline actions available to any of them.
export type ShapeAction =
	| "fill"
	| "stroke"
	| "strokeAndFill"
	| "build"
	| "clip"
	| "skip";

// text/image/canvas have no strokeColor/strokeWidth field, so fill/stroke/
// strokeAndFill are excluded here -- there's no property for them to act on.
export type ContentAction = "build" | "clip" | "skip";

interface CanvasElementBase {
	compositeRule?: string;
	id?: unknown;
	trackMouseDown?: boolean;
	trackMouseUp?: boolean;
	trackMouseEnterExit?: boolean;
	trackMouseMove?: boolean;
	rotation?: number;
	rotationPoint?: Point;
	transformation?: Transformation;
	windingRule?: "nonZero" | "evenOdd";
}

interface ShapeStyle {
	fillColor?: RGBA;
	strokeColor?: RGBA;
	strokeWidth?: number;
	fillGradient?: "linear" | "radial";
	fillGradientColors?: RGBA[];
	fillGradientAngle?: number;
	fillGradientCenter?: Point;
}

export interface RectangleElement extends CanvasElementBase, ShapeStyle {
	type: "rectangle";
	action?: ShapeAction;
	frame?: Rect;
	roundedRectRadii?: number;
}

export interface CircleElement extends CanvasElementBase, ShapeStyle {
	type: "circle";
	action?: ShapeAction;
	center?: Point;
	radius?: number;
	reversePath?: boolean;
}

export interface OvalElement extends CanvasElementBase, ShapeStyle {
	type: "oval";
	action?: ShapeAction;
	frame?: Rect;
}

export interface ArcElement extends CanvasElementBase, ShapeStyle {
	type: "arc";
	action?: ShapeAction;
	center?: Point;
	radius?: number;
	startAngle?: number;
	endAngle?: number;
	arcClockwise?: boolean;
	arcRadii?: boolean;
}

export interface EllipticalArcElement extends CanvasElementBase, ShapeStyle {
	type: "ellipticalArc";
	action?: ShapeAction;
	frame?: Rect;
	startAngle?: number;
	endAngle?: number;
	arcClockwise?: boolean;
}

export interface SegmentsElement extends CanvasElementBase, ShapeStyle {
	type: "segments";
	action?: ShapeAction;
	coordinates: BezierPoint[];
	closed?: boolean;
}

export interface PointsElement extends CanvasElementBase, ShapeStyle {
	type: "points";
	action?: ShapeAction;
	coordinates: Point[];
}

export interface TextElement extends CanvasElementBase {
	type: "text";
	action?: ContentAction;
	text: string;
	frame?: Rect;
	textSize?: number;
	textColor?: RGBA;
	textFont?: string;
	textWeight?:
		| "thin"
		| "ultraLight"
		| "light"
		| "regular"
		| "medium"
		| "semibold"
		| "bold"
		| "heavy"
		| "black";
	textDesign?: "monospaced" | "rounded" | "serif";
	textItalic?: boolean;
	textAlignment?: "natural" | "left" | "right" | "center" | "justified";
	textLineBreak?:
		| "wordWrap"
		| "charWrap"
		| "clip"
		| "truncateHead"
		| "truncateMiddle"
		| "truncateTail";
}

export interface ImageElement extends CanvasElementBase {
	type: "image";
	action?: ContentAction;
	image: HSImage;
	frame?: Rect;
	imageAlpha?: number;
	imageScaling?: "none" | "scaleToFit" | "scaleProportionally" | "shrinkToFit";
	imageAlignment?:
		| "center"
		| "top"
		| "bottom"
		| "left"
		| "right"
		| "topLeft"
		| "topRight"
		| "bottomLeft"
		| "bottomRight";
}

export interface CanvasEmbedElement extends CanvasElementBase {
	type: "canvas";
	action?: ContentAction;
	canvas: HSCanvas;
	frame?: Rect;
	canvasAlpha?: number;
}

export interface ResetClipElement extends CanvasElementBase {
	type: "resetClip";
}

export type CanvasElement =
	| RectangleElement
	| CircleElement
	| OvalElement
	| ArcElement
	| EllipticalArcElement
	| SegmentsElement
	| PointsElement
	| TextElement
	| ImageElement
	| CanvasEmbedElement
	| ResetClipElement;

function rectangle(
	action: ShapeAction,
	props: Omit<RectangleElement, "type" | "action"> = {},
): RectangleElement {
	return { type: "rectangle", action, ...props };
}

function circle(
	action: ShapeAction,
	props: Omit<CircleElement, "type" | "action"> = {},
): CircleElement {
	return { type: "circle", action, ...props };
}

function oval(
	action: ShapeAction,
	props: Omit<OvalElement, "type" | "action"> = {},
): OvalElement {
	return { type: "oval", action, ...props };
}

function arc(
	action: ShapeAction,
	props: Omit<ArcElement, "type" | "action"> = {},
): ArcElement {
	return { type: "arc", action, ...props };
}

function ellipticalArc(
	action: ShapeAction,
	props: Omit<EllipticalArcElement, "type" | "action"> = {},
): EllipticalArcElement {
	return { type: "ellipticalArc", action, ...props };
}

function segments(
	action: ShapeAction,
	props: Omit<SegmentsElement, "type" | "action">,
): SegmentsElement {
	return { type: "segments", action, ...props };
}

function points(
	action: ShapeAction,
	props: Omit<PointsElement, "type" | "action">,
): PointsElement {
	return { type: "points", action, ...props };
}

function text(
	txt: string,
	props: Omit<TextElement, "type" | "text">,
): TextElement {
	return { type: "text", text: txt, ...props };
}

function image(props: Omit<ImageElement, "type">): ImageElement {
	return { type: "image", ...props };
}

function canvas(props: Omit<CanvasEmbedElement, "type">): CanvasEmbedElement {
	return { type: "canvas", ...props };
}

function resetClip(
	props: Omit<ResetClipElement, "type"> = {},
): ResetClipElement {
	return { type: "resetClip", ...props };
}

export const Canvas = {
	rectangle,
	circle,
	oval,
	arc,
	ellipticalArc,
	segments,
	points,
	text,
	image,
	canvas,
	resetClip,
} as const;

// hs.canvas has no documented shape for roundedRectRadii (element attributes
// are just loosely-typed dictionaries) -- empirically, a plain number
// silently applies no rounding at all; only the {xRadius, yRadius} object
// form actually rounds. Always use this, never a bare number.
export function cornerRadii(r: number): number {
	return r;
}
