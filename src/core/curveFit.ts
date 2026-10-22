import { cubicAt, cubicTangent, type Knot } from "./bezier";
import { vec, type Vec2 } from "./geometry";

/**
 * Least-squares Bézier fitting (Schneider, "An Algorithm for Automatically
 * Fitting Digitized Curves", Graphics Gems, 1990): the fewest cubic
 * segments, smooth where they meet, that pass within `error` of every
 * sample. The Freeform Pen's Curve Fit.
 */

type Seg = [Vec2, Vec2, Vec2, Vec2];

const sub = (a: Vec2, b: Vec2) => vec(a.x - b.x, a.y - b.y);
const add = (a: Vec2, b: Vec2) => vec(a.x + b.x, a.y + b.y);
const mul = (a: Vec2, s: number) => vec(a.x * s, a.y * s);
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const unit = (a: Vec2) => {
  const l = len(a);
  return l === 0 ? a : mul(a, 1 / l);
};

/** Fits `points` (a polyline; repeated points are dropped); smooth knots, the ends with a direction line on their inner side only. */
export function fitCurve(points: readonly Vec2[], error: number): Knot[] {
  const pts = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (pts.length === 0) return [];
  if (pts.length === 1) return [{ anchor: pts[0], in: pts[0], out: pts[0] }];
  const segs: Seg[] = [];
  fit(pts, 0, pts.length - 1, unit(sub(pts[Math.min(1, pts.length - 1)], pts[0])), unit(sub(pts[pts.length - 2], pts[pts.length - 1])), error, segs);
  return segs.map((s, i) => ({ anchor: s[0], in: i === 0 ? s[0] : segs[i - 1][2], out: s[1], ...(i > 0 && { smooth: true }) })).concat([
    { anchor: segs[segs.length - 1][3], in: segs[segs.length - 1][2], out: segs[segs.length - 1][3] },
  ]);
}

function fit(d: readonly Vec2[], first: number, last: number, t1: Vec2, t2: Vec2, error: number, out: Seg[]) {
  if (last - first === 1) {
    // Two points: the end tangents at a third of the distance.
    const dist = len(sub(d[last], d[first])) / 3;
    return void out.push([d[first], add(d[first], mul(t1, dist)), add(d[last], mul(t2, dist)), d[last]]);
  }
  let u = chordLengths(d, first, last);
  let bez = generate(d, first, last, u, t1, t2);
  let { err, split } = maxError(d, first, last, bez, u);
  if (err < error) return void out.push(bez);
  // Close: a few Newton–Raphson passes of the parameters may bring it in.
  if (err < error * error * 16 + error) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(d, first, u, bez);
      bez = generate(d, first, last, u, t1, t2);
      ({ err, split } = maxError(d, first, last, bez, u));
      if (err < error) return void out.push(bez);
    }
  }
  // Split where it's worst, with one tangent shared by both halves.
  const center = unit(sub(d[split - 1], d[split + 1]));
  fit(d, first, split, t1, center, error, out);
  fit(d, split, last, mul(center, -1), t2, error, out);
}

function chordLengths(d: readonly Vec2[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(d[i], d[i - 1])));
  const total = u[u.length - 1];
  return u.map((x) => x / total);
}

/** The Bézier with the given end tangents that fits the points best, by least squares on the handle lengths. */
function generate(d: readonly Vec2[], first: number, last: number, u: readonly number[], t1: Vec2, t2: Vec2): Seg {
  const p0 = d[first], p3 = d[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i <= last - first; i++) {
    const t = u[i], s = 1 - t;
    const b0 = s * s * s, b1 = 3 * t * s * s, b2 = 3 * t * t * s, b3 = t * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(d[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const alpha1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  const alpha2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const dist = len(sub(p3, p0));
  const eps = 1e-6 * dist;
  // Degenerate or backwards handles: the Wu/Barsky heuristic, a third of the way.
  if (alpha1 < eps || alpha2 < eps) return [p0, add(p0, mul(t1, dist / 3)), add(p3, mul(t2, dist / 3)), p3];
  return [p0, add(p0, mul(t1, alpha1)), add(p3, mul(t2, alpha2)), p3];
}

function maxError(d: readonly Vec2[], first: number, last: number, b: Seg, u: readonly number[]) {
  let err = 0, split = Math.floor((first + last + 1) / 2);
  for (let i = first + 1; i < last; i++) {
    const p = cubicAt(b[0], b[1], b[2], b[3], u[i - first]);
    const e = Math.hypot(p.x - d[i].x, p.y - d[i].y);
    if (e >= err) ((err = e), (split = i));
  }
  return { err, split };
}

function reparameterize(d: readonly Vec2[], first: number, u: readonly number[], b: Seg): number[] {
  return u.map((t, i) => {
    const p = d[first + i];
    const q = cubicAt(b[0], b[1], b[2], b[3], t);
    const d1 = cubicTangent(b[0], b[1], b[2], b[3], t);
    // The second derivative of the cubic.
    const s = 1 - t;
    const d2 = add(mul(add(sub(b[2], mul(b[1], 2)), b[0]), 6 * s), mul(add(sub(b[3], mul(b[2], 2)), b[1]), 6 * t));
    const diff = sub(q, p);
    const num = dot(diff, d1);
    const den = dot(d1, d1) + dot(diff, d2);
    return den === 0 ? t : Math.min(1, Math.max(0, t - num / den));
  });
}
