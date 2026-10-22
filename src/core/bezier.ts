import { vec, type Vec2 } from "./geometry";

/**
 * Cubic Bézier paths: knots (an anchor with its incoming and outgoing
 * control points) and their flattening to polylines, and the nearest point
 * on a curve.
 */

/**
 * A Bézier knot: the anchor and its incoming/outgoing control points (equal
 * to the anchor where there is no direction line). `smooth` marks a smooth
 * point, whose direction lines stay on one line as either is dragged;
 * without it, two opposite direction lines on a line are taken as smooth.
 */
export interface Knot {
  readonly anchor: Vec2;
  readonly in: Vec2;
  readonly out: Vec2;
  readonly smooth?: boolean;
}

export const corner = (p: Vec2): Knot => ({ anchor: p, in: p, out: p });

const same = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;

/** The segment from `a` to `b` has no direction lines at either end. */
export const isStraight = (a: Knot, b: Knot) => same(a.out, a.anchor) && same(b.in, b.anchor);

const FLATNESS = 0.1; // maximum chord deviation, document pixels

const lerp = (a: Vec2, b: Vec2) => vec((a.x + b.x) / 2, (a.y + b.y) / 2);

export function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return vec(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y);
}

/** The curve's tangent (derivative) at t. */
export function cubicTangent(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  return vec(a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x), a * (p1.y - p0.y) + b * (p2.y - p1.y) + c * (p3.y - p2.y));
}

const mix = (a: Vec2, b: Vec2, t: number) => vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** de Casteljau: the two cubics a curve splits into at t, as their control points. */
export function splitCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): [[Vec2, Vec2, Vec2, Vec2], [Vec2, Vec2, Vec2, Vec2]] {
  const p01 = mix(p0, p1, t), p12 = mix(p1, p2, t), p23 = mix(p2, p3, t);
  const p012 = mix(p01, p12, t), p123 = mix(p12, p23, t);
  const m = mix(p012, p123, t);
  return [[p0, p01, p012, m], [m, p123, p23, p3]];
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

function subdivide(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, map: (p: Vec2) => Vec2, out: Vec2[], depth: number) {
  const m0 = map(p0), m3 = map(p3);
  // Flatness of the mapped curve: distance of its mapped midpoint and control points from the chord.
  const mid = map(cubicAt(p0, p1, p2, p3, 0.5));
  const flat =
    depth >= 16 ||
    (distToSegment(mid, m0, m3) <= FLATNESS &&
      distToSegment(map(p1), m0, m3) <= FLATNESS * 4 &&
      distToSegment(map(p2), m0, m3) <= FLATNESS * 4);
  if (flat) {
    if (depth > 0) out.push(m3);
    return;
  }
  const p01 = lerp(p0, p1), p12 = lerp(p1, p2), p23 = lerp(p2, p3);
  const p012 = lerp(p01, p12), p123 = lerp(p12, p23), m = lerp(p012, p123);
  subdivide(p0, p01, p012, m, map, out, depth + 1);
  subdivide(m, p123, p23, p3, map, out, depth + 1);
}

/**
 * Flattens a run of knots into a polyline, mapped through `map`. Curves are
 * subdivided until their *mapped* control polygon is within a tolerance of
 * its chord, so it holds after scaling and perspective. A closed run
 * includes the segment back to the first knot (its end is the first point,
 * not repeated).
 */
export function flattenKnots(knots: readonly Knot[], closed: boolean, map: (p: Vec2) => Vec2 = (p) => p): Vec2[] {
  const out: Vec2[] = [];
  const n = knots.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = knots[i], b = knots[(i + 1) % n];
    out.push(map(a.anchor));
    const before = out.length;
    // Straight edges stay straight under affine maps but bend under perspective/warp, so they subdivide too.
    if (isStraight(a, b)) subdivide(a.anchor, a.anchor, b.anchor, b.anchor, map, out, 0);
    else subdivide(a.anchor, a.out, b.in, b.anchor, map, out, 0);
    // The last piece ends on the next anchor, which the next iteration (or the start) supplies.
    if (out.length > before) out.pop();
  }
  if (!closed && n > 0) out.push(map(knots[n - 1].anchor));
  return out;
}

/** Closed contours flattened into polygons in document space. */
export const flattenContours = (contours: readonly (readonly Knot[])[], map: (p: Vec2) => Vec2): Vec2[][] =>
  contours.map((knots) => flattenKnots(knots, true, map));

/** The nearest point on the cubic p0..p3 to `q`: its parameter, position and distance. */
export function nearestOnCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, q: Vec2): { t: number; point: Vec2; dist: number } {
  // Coarse sampling, then refinement around the best sample.
  const N = 24;
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const p = cubicAt(p0, p1, p2, p3, i / N);
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < bestD) ((bestD = d), (best = i / N));
  }
  let lo = Math.max(0, best - 1 / N), hi = Math.min(1, best + 1 / N);
  for (let k = 0; k < 24; k++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    const pa = cubicAt(p0, p1, p2, p3, a), pb = cubicAt(p0, p1, p2, p3, b);
    if ((pa.x - q.x) ** 2 + (pa.y - q.y) ** 2 < (pb.x - q.x) ** 2 + (pb.y - q.y) ** 2) hi = b;
    else lo = a;
  }
  const t = (lo + hi) / 2;
  const point = cubicAt(p0, p1, p2, p3, t);
  return { t, point, dist: Math.hypot(point.x - q.x, point.y - q.y) };
}
