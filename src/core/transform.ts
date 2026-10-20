import { apply, compose, rotation, translation, vec, type Mat, type Rect, type Vec2 } from "./geometry";
import {
  IDENTITY_PATCH,
  PATCH_ANCHORS,
  dragPatchSurface,
  invert3,
  invertPatch,
  isConvex,
  project,
  quadOf,
  squareToQuad,
  type Mapping,
  type Patch,
  type Quad,
} from "./warp";

/**
 * Free Transform, modelled on Photoshop (2020+, non-legacy behaviour).
 *
 * State is the quad the source's corners map to (an exact homography), the
 * box's orientation (used as the axes for scaling, skewing and numeric
 * entry), the reference point (pivot for rotation, Alt-scaling and flips),
 * and an optional Bézier warp applied before the homography.
 */
export interface TransformState {
  readonly source: Rect;
  /** Top-left, top-right, bottom-right, bottom-left. */
  readonly quad: Quad;
  /** Box orientation in radians (clockwise on screen). */
  readonly angle: number;
  readonly reference: Vec2;
  readonly patch: Patch | null;
}

/** Free = modifier-driven; the others are Edit ▸ Transform / context-menu modes. */
export type TransformMode = "free" | "scale" | "rotate" | "skew" | "distort" | "perspective" | "warp";

export interface Modifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  /** Ctrl, or Cmd on macOS. */
  readonly mod: boolean;
}

/** Corners: 0 TL, 1 TR, 2 BR, 3 BL. Edges: 0 top, 1 right, 2 bottom, 3 left. */
export type TransformHit =
  | { readonly kind: "corner"; readonly index: number }
  | { readonly kind: "edge"; readonly index: number }
  | { readonly kind: "move" }
  | { readonly kind: "rotate" }
  | { readonly kind: "reference" }
  | { readonly kind: "warp-point"; readonly index: number }
  | { readonly kind: "warp-surface"; readonly s: number; readonly t: number }
  | { readonly kind: "none" };

export function initialTransform(source: Rect): TransformState {
  return {
    source,
    quad: quadOf(source),
    angle: 0,
    reference: vec(source.x + source.w / 2, source.y + source.h / 2),
    patch: null,
  };
}

export const toMapping = (s: TransformState): Mapping => ({ source: s.source, quad: s.quad, patch: s.patch });

const homography = (s: TransformState) => squareToQuad(s.quad)!;

/** Normalised source coordinates of each edge's midpoint handle. */
const EDGE_UV: readonly (readonly [number, number])[] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];

/** Handle positions: edge handles sit at the projected edge midpoints, as in Photoshop. */
export function handles(s: TransformState): { corners: Quad; edges: Vec2[] } {
  const H = homography(s);
  return { corners: s.quad, edges: EDGE_UV.map(([u, v]) => project(H, u, v)) };
}

/** Reference-point locator: (ix, iy) ∈ {0, 1, 2}² across the box. */
export const locatorPoint = (s: TransformState, ix: number, iy: number) => project(homography(s), ix / 2, iy / 2);

/** Source-normalised coordinates of a document point, or null if it is outside the quad. */
export function quadCoords(s: TransformState, p: Vec2): { u: number; v: number } | null {
  const inv = invert3(homography(s));
  if (!inv) return null;
  const q = project(inv, p.x, p.y);
  return q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1 ? { u: q.x, v: q.y } : null;
}

/** Warp control points in document space. */
export function warpPoints(s: TransformState): Vec2[] {
  const H = homography(s);
  return (s.patch ?? IDENTITY_PATCH).map((c) => project(H, c.x, c.y));
}

export interface HitOptions {
  /** Handle grab radius in document units (screen pixels ÷ zoom). */
  readonly tolerance: number;
  readonly mode: TransformMode;
  readonly showReference: boolean;
  /**
   * How far outside the box (document units) rotation can be grabbed:
   * Infinity during Free Transform, a narrow band for the Move tool's
   * always-on controls (so clicks elsewhere still start a plain move).
   */
  readonly rotateBand: number;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function nearest(points: readonly Vec2[], p: Vec2, tolerance: number): number {
  let best = -1, bestD = tolerance;
  points.forEach((q, i) => {
    const d = dist(p, q);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** Distance from p to the quad's outline. */
function outlineDistance(q: Quad, p: Vec2): number {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const abx = b.x - a.x, aby = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby)));
    best = Math.min(best, Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t));
  }
  return best;
}

export function hitTest(s: TransformState, p: Vec2, o: HitOptions): TransformHit {
  if (o.showReference && dist(p, s.reference) <= o.tolerance) return { kind: "reference" };
  // Keep the middle of small boxes grabbable: handles never claim more than a quarter of the shortest side.
  const shortest = Math.min(...s.quad.map((q, i) => dist(q, s.quad[(i + 1) % 4])));
  const tolerance = Math.min(o.tolerance, shortest / 4);
  if (o.mode === "warp") {
    const k = nearest(warpPoints(s), p, o.tolerance);
    if (k >= 0) return { kind: "warp-point", index: k };
    const inv = invert3(homography(s));
    const q = inv && project(inv, p.x, p.y);
    const st = q && invertPatch(s.patch ?? IDENTITY_PATCH, q);
    return st ? { kind: "warp-surface", s: st.s, t: st.t } : { kind: "none" };
  }
  const h = handles(s);
  const c = nearest(h.corners, p, tolerance);
  if (c >= 0) return { kind: "corner", index: c };
  const e = nearest(h.edges, p, tolerance);
  if (e >= 0) return { kind: "edge", index: e };
  if (quadCoords(s, p)) return { kind: "move" };
  const canRotate = o.mode === "free" || o.mode === "rotate";
  return canRotate && outlineDistance(s.quad, p) <= o.rotateBand ? { kind: "rotate" } : { kind: "none" };
}

// ---------------------------------------------------------------------------
// Operations. Each takes the state at drag start and returns a new state.

/** Vector into / out of the box's frame. */
const toFrame = (s: TransformState, v: Vec2) => apply(rotation(-s.angle), v);
const fromFrame = (s: TransformState, v: Vec2) => apply(rotation(s.angle), v);
const sub = (a: Vec2, b: Vec2) => vec(a.x - b.x, a.y - b.y);
const add = (a: Vec2, b: Vec2) => vec(a.x + b.x, a.y + b.y);

/** Applies `m` to the quad and reference point. */
function transformBy(s: TransformState, m: Mat, angle = s.angle): TransformState {
  return {
    ...s,
    quad: s.quad.map((q) => apply(m, q)) as unknown as Quad,
    reference: apply(m, s.reference),
    angle,
  };
}

/** Scales by (kx, ky) along the box's axes about `origin`. */
function scaleAbout(s: TransformState, kx: number, ky: number, origin: Vec2): TransformState {
  const m = compose(translation(-origin.x, -origin.y), rotation(-s.angle), [kx, 0, 0, ky, 0, 0], rotation(s.angle), translation(origin.x, origin.y));
  return transformBy(s, m);
}

export function rotateAbout(s: TransformState, radians: number, origin = s.reference): TransformState {
  const m = compose(translation(-origin.x, -origin.y), rotation(radians), translation(origin.x, origin.y));
  return transformBy(s, m, s.angle + radians);
}

export function flip(s: TransformState, axis: "horizontal" | "vertical"): TransformState {
  return axis === "horizontal" ? scaleAbout(s, -1, 1, s.reference) : scaleAbout(s, 1, -1, s.reference);
}

export const translate = (s: TransformState, dx: number, dy: number) => transformBy(s, translation(dx, dy));

const withQuad = (from: TransformState, quad: Quad): TransformState =>
  isConvex(quad) ? { ...from, quad } : from; // never fold the quad or cross the horizon

/** Locks a frame-space vector to its dominant axis. */
function lockAxis(s: TransformState, d: Vec2): Vec2 {
  const f = toFrame(s, d);
  return fromFrame(s, Math.abs(f.x) >= Math.abs(f.y) ? vec(f.x, 0) : vec(0, f.y));
}

const SNAP = Math.PI / 12; // 15°

export interface Drag {
  readonly hit: TransformHit;
  readonly start: Vec2;
  readonly from: TransformState;
  readonly mode: TransformMode;
  /** The options bar's link (maintain aspect ratio); Shift inverts it. */
  readonly link: boolean;
}

const MIN_SIZE = 1; // pixels

export function scaleFromCorner(from: TransformState, corner: number, target: Vec2, proportional: boolean, fromRef: boolean) {
  const anchor = fromRef ? from.reference : from.quad[(corner + 2) % 4];
  const a = toFrame(from, sub(from.quad[corner], anchor));
  const b = toFrame(from, sub(target, anchor));
  const ratio = (num: number, den: number) => (Math.abs(den) < 1e-9 ? 1 : num / den);
  let kx = ratio(b.x, a.x);
  let ky = ratio(b.y, a.y);
  if (proportional) {
    // Project the pointer onto the handle's diagonal: smooth and sign-aware.
    const k = (b.x * a.x + b.y * a.y) / (a.x * a.x + a.y * a.y || 1);
    kx = ky = k;
  }
  const clampK = (k: number, len: number) => (Math.abs(k * len) < MIN_SIZE ? Math.sign(k || 1) * (MIN_SIZE / Math.max(len, 1e-9)) : k);
  return scaleAbout(from, clampK(kx, Math.abs(a.x)), clampK(ky, Math.abs(a.y)), anchor);
}

export function scaleFromEdge(from: TransformState, edge: number, target: Vec2, proportional: boolean, fromRef: boolean) {
  const h = handles(from);
  const anchor = fromRef ? from.reference : h.edges[(edge + 2) % 4];
  const horizontal = edge === 1 || edge === 3; // left/right handles scale x
  const a = toFrame(from, sub(h.edges[edge], anchor));
  const b = toFrame(from, sub(target, anchor));
  const len = Math.abs(horizontal ? a.x : a.y);
  if (len < 1e-9) return from;
  let k = (horizontal ? b.x : b.y) / (horizontal ? a.x : a.y);
  if (Math.abs(k * len) < MIN_SIZE) k = Math.sign(k || 1) * (MIN_SIZE / len);
  // Proportional side drags scale the other axis too (by magnitude, about the centre line).
  const other = proportional ? Math.abs(k) : 1;
  return horizontal ? scaleAbout(from, k, other, anchor) : scaleAbout(from, other, k, anchor);
}

export function rotateDrag(from: TransformState, start: Vec2, p: Vec2, snap: boolean): TransformState {
  const r = from.reference;
  const delta = Math.atan2(p.y - r.y, p.x - r.x) - Math.atan2(start.y - r.y, start.x - r.x);
  let angle = from.angle + delta;
  if (snap) angle = Math.round(angle / SNAP) * SNAP;
  return rotateAbout(from, angle - from.angle);
}

/** Shift-constrained moves snap to multiples of 45°. */
export function moveDrag(from: TransformState, d: Vec2, constrain: boolean): TransformState {
  if (constrain) {
    const a = Math.round(Math.atan2(d.y, d.x) / (Math.PI / 4)) * (Math.PI / 4);
    const len = d.x * Math.cos(a) + d.y * Math.sin(a);
    d = vec(len * Math.cos(a), len * Math.sin(a));
  }
  return translate(from, d.x, d.y);
}

export function distortCorner(from: TransformState, corner: number, d: Vec2, constrain: boolean): TransformState {
  const delta = constrain ? lockAxis(from, d) : d;
  const quad = [...from.quad];
  quad[corner] = add(quad[corner], delta);
  return withQuad(from, quad as unknown as Quad);
}

/** Moves a whole edge (Ctrl+side, or Distort mode); Alt moves the opposite edge the other way. */
export function moveEdge(from: TransformState, edge: number, d: Vec2, constrain: boolean, symmetric: boolean): TransformState {
  const delta = constrain ? lockAxis(from, d) : d;
  const quad = [...from.quad];
  const [i, j] = [edge, (edge + 1) % 4];
  quad[i] = add(quad[i], delta);
  quad[j] = add(quad[j], delta);
  if (symmetric) {
    const [k, l] = [(edge + 2) % 4, (edge + 3) % 4];
    quad[k] = sub(quad[k], delta);
    quad[l] = sub(quad[l], delta);
  }
  return withQuad(from, quad as unknown as Quad);
}

/** Skew: an edge slides along its own axis; Alt slides the opposite edge the other way. */
export function skewEdge(from: TransformState, edge: number, d: Vec2, symmetric: boolean): TransformState {
  const f = toFrame(from, d);
  const along = edge === 0 || edge === 2 ? vec(f.x, 0) : vec(0, f.y);
  return moveEdge(from, edge, fromFrame(from, along), false, symmetric);
}

/** Skew mode corner drags move just that corner along the box's dominant axis. */
export const skewCorner = (from: TransformState, corner: number, d: Vec2) => distortCorner(from, corner, d, true);

/**
 * Perspective: a corner moves along one box axis and its neighbour on that
 * axis moves the opposite way, keeping the shape a symmetric trapezoid.
 */
export function perspectiveCorner(from: TransformState, corner: number, d: Vec2): TransformState {
  const f = toFrame(from, d);
  const horizontal = Math.abs(f.x) >= Math.abs(f.y);
  const delta = fromFrame(from, horizontal ? vec(f.x, 0) : vec(0, f.y));
  // Horizontal neighbours: 0↔1, 3↔2. Vertical neighbours: 0↔3, 1↔2.
  const pair = horizontal ? [1, 0, 3, 2][corner] : [3, 2, 1, 0][corner];
  const quad = [...from.quad];
  quad[corner] = add(quad[corner], delta);
  quad[pair] = sub(quad[pair], delta);
  return withQuad(from, quad as unknown as Quad);
}

function warpDrag(from: TransformState, hit: TransformHit, start: Vec2, p: Vec2): TransformState {
  const inv = invert3(homography(from));
  if (!inv) return from;
  const a = project(inv, start.x, start.y);
  const b = project(inv, p.x, p.y);
  const delta = sub(b, a);
  const patch = from.patch ?? IDENTITY_PATCH;
  if (hit.kind === "warp-surface") return { ...from, patch: dragPatchSurface(patch, hit.s, hit.t, delta) };
  if (hit.kind !== "warp-point") return from;
  // Anchors carry their two Bézier handles with them.
  const group = PATCH_ANCHORS.find((g) => g[0] === hit.index) ?? [hit.index];
  return { ...from, patch: patch.map((c, k) => (group.includes(k) ? add(c, delta) : c)) };
}

/**
 * The state after dragging from `drag.start` to `p` with the given modifiers.
 * Encodes Photoshop's handle semantics:
 *
 * | handle | free mode                                   | mode          |
 * |--------|---------------------------------------------|---------------|
 * | corner | scale (proportional = link ⊕ Shift, Alt = about reference); Ctrl distort (Shift locks axis); Ctrl+Alt+Shift perspective | scale / rotate / skew / distort / perspective |
 * | side   | scale; Ctrl moves the edge; Ctrl+Shift skews (Alt = opposite side too) | scale / rotate / skew / move edge / skew |
 * | inside | move (Shift: 45° steps)                     | move          |
 * | outside| rotate (Shift: 15° steps)                   | rotate mode only |
 */
export function dragTransform(drag: Drag, p: Vec2, m: Modifiers): TransformState {
  const { hit, start, from, mode, link } = drag;
  const d = sub(p, start);
  switch (hit.kind) {
    case "reference":
      return { ...from, reference: p };
    case "move":
      return mode === "rotate" ? rotateDrag(from, start, p, m.shift) : moveDrag(from, d, m.shift);
    case "rotate":
      return rotateDrag(from, start, p, m.shift);
    case "warp-point":
    case "warp-surface":
      return warpDrag(from, hit, start, p);
    case "corner": {
      const target = add(from.quad[hit.index], d);
      if (mode === "rotate") return rotateDrag(from, start, p, m.shift);
      if (mode === "skew") return skewCorner(from, hit.index, d);
      if (mode === "distort") return distortCorner(from, hit.index, d, m.shift);
      if (mode === "perspective") return perspectiveCorner(from, hit.index, d);
      if (mode === "free" && m.mod && m.alt && m.shift) return perspectiveCorner(from, hit.index, d);
      if (mode === "free" && m.mod) return distortCorner(from, hit.index, d, m.shift);
      return scaleFromCorner(from, hit.index, target, link !== m.shift, m.alt);
    }
    case "edge": {
      const target = add(handles(from).edges[hit.index], d);
      if (mode === "rotate") return rotateDrag(from, start, p, m.shift);
      if (mode === "skew" || mode === "perspective") return skewEdge(from, hit.index, d, m.alt);
      if (mode === "distort") return moveEdge(from, hit.index, d, m.shift, m.alt);
      if (mode === "free" && m.mod && m.shift) return skewEdge(from, hit.index, d, m.alt);
      if (mode === "free" && m.mod) return moveEdge(from, hit.index, d, false, m.alt);
      return scaleFromEdge(from, hit.index, target, link !== m.shift, m.alt);
    }
    default:
      return from;
  }
}

// ---------------------------------------------------------------------------
// Numeric entry (options bar): reference position, scale %, angle, skews.

export interface NumericTransform {
  /** Reference point, document pixels. */
  readonly x: number;
  readonly y: number;
  /** Percent of the source size. */
  readonly w: number;
  readonly h: number;
  /** Degrees. */
  readonly angle: number;
  readonly hSkew: number;
  readonly vSkew: number;
}

const DEG = 180 / Math.PI;

/** The box's affine part as frame-space columns u (top edge) and v (left edge). */
function frameColumns(s: TransformState) {
  return { u: toFrame(s, sub(s.quad[1], s.quad[0])), v: toFrame(s, sub(s.quad[3], s.quad[0])) };
}

export function numeric(s: TransformState): NumericTransform {
  const { u, v } = frameColumns(s);
  return {
    x: s.reference.x,
    y: s.reference.y,
    w: (u.x / s.source.w) * 100,
    h: (v.y / s.source.h) * 100,
    angle: s.angle * DEG,
    hSkew: Math.atan2(v.x, v.y) * DEG,
    vSkew: Math.atan2(u.y, u.x) * DEG,
  };
}

/** Linear part (frame space) from numeric values: columns (sx·w, sx·tan v·w) and (sy·tan h·h, sy·h). */
function linear(n: NumericTransform): Mat {
  const sx = n.w / 100, sy = n.h / 100;
  return [sx, sx * Math.tan(n.vSkew / DEG), sy * Math.tan(n.hSkew / DEG), sy, 0, 0];
}

const invert2 = (m: Mat): Mat => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, 0, 0];
};

/**
 * Applies edited numeric values as a relative transform, so any distortion or
 * warp already applied is preserved (as Photoshop does).
 */
export function withNumeric(s: TransformState, patch: Partial<NumericTransform>): TransformState {
  const before = numeric(s);
  const after = { ...before, ...patch };
  if (Math.abs(after.w) < 1e-6 || Math.abs(after.h) < 1e-6) return s;
  const r = s.reference;
  const m = compose(
    translation(-r.x, -r.y),
    rotation(-s.angle),
    invert2(linear(before)),
    linear(after),
    rotation(after.angle / DEG),
    translation(after.x, after.y),
  );
  return transformBy(s, m, after.angle / DEG);
}

export const isIdentityTransform = (s: TransformState) => {
  const q = quadOf(s.source);
  return !s.patch && s.quad.every((p, i) => Math.abs(p.x - q[i].x) < 1e-6 && Math.abs(p.y - q[i].y) < 1e-6);
};

/** A pure integer translation, which can be committed exactly without resampling. */
export function integerOffset(s: TransformState): Vec2 | null {
  if (s.patch) return null;
  const q = quadOf(s.source);
  const dx = s.quad[0].x - q[0].x, dy = s.quad[0].y - q[0].y;
  if (Math.abs(dx - Math.round(dx)) > 1e-6 || Math.abs(dy - Math.round(dy)) > 1e-6) return null;
  const same = s.quad.every((p, i) => Math.abs(p.x - q[i].x - dx) < 1e-6 && Math.abs(p.y - q[i].y - dy) < 1e-6);
  return same ? vec(Math.round(dx), Math.round(dy)) : null;
}
