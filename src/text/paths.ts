import { vec, type Vec2 } from "../core/geometry";
import { flattenContours, type Knot } from "../core/shape";
import type { PathKnot } from "./model";

/** A path flattened for measuring: points and the distance along it to each. */
export interface MeasuredPath {
  readonly points: readonly Vec2[];
  readonly lengths: Float64Array;
  readonly length: number;
}

const asKnots = (knots: readonly PathKnot[]): Knot[] => knots.map((k) => ({ anchor: vec(k.anchor.x, k.anchor.y), in: vec(k.in.x, k.in.y), out: vec(k.out.x, k.out.y) }));

/** A path (open or closed) as a polyline with cumulative lengths. */
export function measurePath(knots: readonly PathKnot[], closed: boolean): MeasuredPath {
  if (knots.length === 0) return { points: [], lengths: new Float64Array(0), length: 0 };
  // flattenContours closes contours; an open path drops the closing edge.
  const [poly] = flattenContours([asKnots(knots)], (p) => p);
  const points = closed ? [...poly, poly[0]] : poly.slice(0, openEnd(poly, knots[knots.length - 1].anchor) + 1);
  const lengths = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) lengths[i] = lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return { points, lengths, length: lengths[points.length - 1] ?? 0 };
}

/** Where the open path's last anchor is in the closed polyline. */
function openEnd(poly: readonly Vec2[], last: { x: number; y: number }): number {
  for (let i = poly.length - 1; i >= 0; i--) if (Math.abs(poly[i].x - last.x) < 1e-6 && Math.abs(poly[i].y - last.y) < 1e-6) return i;
  return poly.length - 1;
}

/** The point `s` along a path and the direction there (radians); past the ends, extended straight. */
export function pointAlong(path: MeasuredPath, s: number): { p: Vec2; angle: number } {
  const { points, lengths } = path;
  if (points.length < 2) return { p: points[0] ?? vec(0, 0), angle: 0 };
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const seg = lengths[hi] - lengths[lo] || 1;
  const t = (s - lengths[lo]) / seg;
  return { p: vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** Closed contours as polygons. */
export const areaPolygons = (contours: readonly (readonly PathKnot[])[]): Vec2[][] => flattenContours(contours.map(asKnots), (p) => p);

/**
 * The horizontal spans inside polygons (non-zero winding) along the line y,
 * sorted.
 */
function spansAt(polys: readonly (readonly Vec2[])[], y: number): [number, number][] {
  const xs: { x: number; d: number }[] = [];
  for (const poly of polys)
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push({ x: a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x), d: b.y > a.y ? 1 : -1 });
    }
  xs.sort((p, q) => p.x - q.x);
  const out: [number, number][] = [];
  let w = 0, start = 0;
  for (const { x, d } of xs) {
    const was = w;
    w += d;
    if (was === 0 && w !== 0) start = x;
    else if (was !== 0 && w === 0) out.push([start, x]);
  }
  return out;
}

/**
 * The widest span that's inside the shape all the way from `top` to
 * `bottom` (a line's height): where area type's line goes.
 */
export function spanBetween(polys: readonly (readonly Vec2[])[], top: number, bottom: number): [number, number] | null {
  const samples = 5;
  let spans = spansAt(polys, top);
  for (let i = 1; i <= samples; i++) {
    const y = top + ((bottom - top) * i) / samples;
    const next = spansAt(polys, y);
    const inter: [number, number][] = [];
    for (const [a, b] of spans)
      for (const [c, d] of next) {
        const lo = Math.max(a, c), hi = Math.min(b, d);
        if (hi > lo) inter.push([lo, hi]);
      }
    spans = inter;
  }
  let best: [number, number] | null = null;
  for (const s of spans) if (!best || s[1] - s[0] > best[1] - best[0]) best = s;
  return best;
}

/** The vertical extent of polygons. */
export function polygonsTop(polys: readonly (readonly Vec2[])[]): { top: number; bottom: number } {
  let top = Infinity, bottom = -Infinity;
  for (const p of polys) for (const q of p) (top = Math.min(top, q.y)), (bottom = Math.max(bottom, q.y));
  return { top, bottom };
}
