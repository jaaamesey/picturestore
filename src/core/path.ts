import polygonClipping from "polygon-clipping";
import { cubicAt, flattenKnots, isStraight, nearestOnCubic, splitCubic, type Knot } from "./bezier";
import { boundsOf, vec, type Rect, type Vec2 } from "./geometry";

/**
 * Photoshop's paths: components (subpaths) of anchor points joined by
 * straight or curved segments, open or closed, each combined with the ones
 * before it by a shape-area operation. Anchor points are smooth (direction
 * lines kept on one line) or corner points. Everything here is pure: edits
 * return a new path.
 */

export type { Knot };

export type PathOp = "combine" | "subtract" | "intersect" | "exclude";

export interface Subpath {
  readonly knots: readonly Knot[];
  readonly closed: boolean;
  /** How this component's area combines with the components before it (the first one's is ignored). */
  readonly op: PathOp;
}

export interface VectorPath {
  readonly subpaths: readonly Subpath[];
}

export const EMPTY_PATH: VectorPath = { subpaths: [] };

/** An anchor point of a path. */
export interface PointRef {
  readonly sub: number;
  readonly knot: number;
}

export const sameRef = (a: PointRef, b: PointRef) => a.sub === b.sub && a.knot === b.knot;

const eq = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
const add = (a: Vec2, b: Vec2) => vec(a.x + b.x, a.y + b.y);
const sub = (a: Vec2, b: Vec2) => vec(a.x - b.x, a.y - b.y);
const reflect = (anchor: Vec2, p: Vec2) => vec(2 * anchor.x - p.x, 2 * anchor.y - p.y);

// --- Anchor points ---------------------------------------------------------------------

/** A smooth point: marked so, or with two opposite direction lines on one line. */
export function isSmooth(k: Knot): boolean {
  if (k.smooth !== undefined) return k.smooth;
  const a = sub(k.in, k.anchor), b = sub(k.out, k.anchor);
  const la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y);
  if (la < 1e-9 || lb < 1e-9) return false;
  return Math.abs(a.x * b.y - a.y * b.x) <= 1e-6 * la * lb && a.x * b.x + a.y * b.y < 0;
}

export const hasHandles = (k: Knot) => !eq(k.in, k.anchor) || !eq(k.out, k.anchor);

/** A smooth point whose direction lines are mirror images, `out` where given. */
export const smoothKnot = (anchor: Vec2, out: Vec2): Knot => ({ anchor, in: reflect(anchor, out), out, smooth: true });

/** A corner point with no direction lines. */
export const cornerKnot = (anchor: Vec2): Knot => ({ anchor, in: anchor, out: anchor, smooth: false });

const moveKnot = (k: Knot, d: Vec2): Knot => ({ ...k, anchor: add(k.anchor, d), in: add(k.in, d), out: add(k.out, d) });

/**
 * Moves one direction point. On a smooth point the other direction line
 * turns to stay on one line, keeping its length (`mode: "smooth"`; the
 * length changes on the dragged side only), or mirrors it (`"mirror"`, as
 * when first drawing the point); a corner point's lines are independent,
 * and `"break"` (Alt) makes the point a corner.
 */
export function moveHandle(k: Knot, side: "in" | "out", to: Vec2, mode: "smooth" | "mirror" | "break"): Knot {
  const other = side === "in" ? "out" : "in";
  const moved = { ...k, [side]: to } as Knot;
  if (mode === "break") return { ...moved, smooth: false };
  if (mode === "mirror") return { ...moved, [other]: reflect(k.anchor, to), smooth: true };
  if (!isSmooth(k)) return { ...moved, smooth: false };
  const d = sub(to, k.anchor), len = Math.hypot(d.x, d.y);
  const o = sub(k[other], k.anchor), olen = Math.hypot(o.x, o.y);
  if (len < 1e-9 || olen < 1e-9) return { ...moved, smooth: true };
  return { ...moved, [other]: vec(k.anchor.x - (d.x / len) * olen, k.anchor.y - (d.y / len) * olen), smooth: true };
}

// --- Segments ---------------------------------------------------------------------------

export const segmentCount = (s: Subpath) => (s.closed ? (s.knots.length > 1 ? s.knots.length : 0) : Math.max(0, s.knots.length - 1));

/** The knots at the ends of segment `i`. */
export const segmentKnots = (s: Subpath, i: number): [Knot, Knot] => [s.knots[i], s.knots[(i + 1) % s.knots.length]];

/** A point on segment `i` of a component. */
export function segmentPoint(s: Subpath, i: number, t: number): Vec2 {
  const [a, b] = segmentKnots(s, i);
  return cubicAt(a.anchor, a.out, b.in, b.anchor, t);
}

export interface PathHit {
  readonly sub: number;
  readonly seg: number;
  readonly t: number;
  readonly point: Vec2;
  readonly dist: number;
}

/** The segment nearest `p` within `tolerance`, if any. */
export function nearestSegment(path: VectorPath, p: Vec2, tolerance: number): PathHit | null {
  let best: PathHit | null = null;
  path.subpaths.forEach((s, si) => {
    for (let i = 0; i < segmentCount(s); i++) {
      const [a, b] = segmentKnots(s, i);
      const r = isStraight(a, b) ? nearestOnLine(a.anchor, b.anchor, p) : nearestOnCubic(a.anchor, a.out, b.in, b.anchor, p);
      if (r.dist <= tolerance && (!best || r.dist < best.dist)) best = { sub: si, seg: i, t: r.t, point: r.point, dist: r.dist };
    }
  });
  return best;
}

function nearestOnLine(a: Vec2, b: Vec2, q: Vec2): { t: number; point: Vec2; dist: number } {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
  const point = vec(a.x + dx * t, a.y + dy * t);
  return { t, point, dist: Math.hypot(q.x - point.x, q.y - point.y) };
}

/** The anchor point nearest `p` within `tolerance`, if any (the last of equally near ones). */
export function anchorAt(path: VectorPath, p: Vec2, tolerance: number): PointRef | null {
  let best: PointRef | null = null, bestD = tolerance;
  path.subpaths.forEach((s, si) =>
    s.knots.forEach((k, ki) => {
      const d = Math.hypot(k.anchor.x - p.x, k.anchor.y - p.y);
      if (d <= bestD) ((bestD = d), (best = { sub: si, knot: ki }));
    }),
  );
  return best;
}

// --- Editing ----------------------------------------------------------------------------

const withSub = (path: VectorPath, i: number, f: (s: Subpath) => Subpath): VectorPath => ({ subpaths: path.subpaths.map((s, k) => (k === i ? f(s) : s)) });
const withKnot = (path: VectorPath, r: PointRef, f: (k: Knot) => Knot): VectorPath => withSub(path, r.sub, (s) => ({ ...s, knots: s.knots.map((k, i) => (i === r.knot ? f(k) : k)) }));

/** A new component of one anchor point (the first click of the Pen tool). */
export const addSubpath = (path: VectorPath, knot: Knot, op: PathOp = "combine"): VectorPath => ({ subpaths: [...path.subpaths, { knots: [knot], closed: false, op }] });

export const replaceKnot = withKnot;

export const setKnot = (path: VectorPath, r: PointRef, k: Knot): VectorPath => withKnot(path, r, () => k);

/** A knot added at the end (`end`) or the start of an open component. */
export function extend(path: VectorPath, subIndex: number, knot: Knot, end = true): VectorPath {
  return withSub(path, subIndex, (s) => ({ ...s, knots: end ? [...s.knots, knot] : [knot, ...s.knots] }));
}

export const closeSubpath = (path: VectorPath, subIndex: number): VectorPath => withSub(path, subIndex, (s) => ({ ...s, closed: true }));

/** Whether a knot is an end of an open component (the only places a Pen tool continues from). */
export function isEndpoint(path: VectorPath, r: PointRef): boolean {
  const s = path.subpaths[r.sub];
  return !!s && !s.closed && (r.knot === 0 || r.knot === s.knots.length - 1);
}

/** Moves anchor points (with their direction lines). */
export function moveKnots(path: VectorPath, refs: readonly PointRef[], d: Vec2): VectorPath {
  let out = path;
  for (const r of refs) out = withKnot(out, r, (k) => moveKnot(k, d));
  return out;
}

/** Moves whole components. */
export const moveSubpaths = (path: VectorPath, subs: readonly number[], d: Vec2): VectorPath => ({
  subpaths: path.subpaths.map((s, i) => (subs.includes(i) ? { ...s, knots: s.knots.map((k) => moveKnot(k, d)) } : s)),
});

/**
 * Splits segment `seg` of a component at `t`, adding an anchor point there
 * that keeps the shape exactly: smooth on a curve, a corner on a straight
 * segment (the Add Anchor Point tool).
 */
export function insertKnot(path: VectorPath, subIndex: number, seg: number, t: number): { path: VectorPath; ref: PointRef } {
  const s = path.subpaths[subIndex];
  const [a, b] = segmentKnots(s, seg);
  const bi = (seg + 1) % s.knots.length;
  const knots = [...s.knots];
  let knot: Knot;
  if (isStraight(a, b)) {
    knot = cornerKnot(vec(a.anchor.x + (b.anchor.x - a.anchor.x) * t, a.anchor.y + (b.anchor.y - a.anchor.y) * t));
  } else {
    const [l, r] = splitCubic(a.anchor, a.out, b.in, b.anchor, t);
    knot = { anchor: l[3], in: l[2], out: r[1], smooth: true };
    knots[seg] = { ...a, out: l[1] };
    knots[bi] = { ...b, in: r[2] };
  }
  // The segment closing a component ends at its first knot: the new one goes last.
  knots.splice(seg + 1, 0, knot);
  return { path: withSub(path, subIndex, (x) => ({ ...x, knots })), ref: { sub: subIndex, knot: seg + 1 } };
}

/** Removes an anchor point, keeping its neighbours' direction lines (the Delete Anchor Point tool); a component left empty goes. */
export function removeKnot(path: VectorPath, r: PointRef): VectorPath {
  const s = path.subpaths[r.sub];
  const knots = s.knots.filter((_, i) => i !== r.knot);
  if (!knots.length) return { subpaths: path.subpaths.filter((_, i) => i !== r.sub) };
  return withSub(path, r.sub, (x) => ({ ...x, knots, closed: x.closed && knots.length > 1 }));
}

/** A corner point: its direction lines removed (clicking a smooth point with the Convert Point tool). */
export const toCorner = (path: VectorPath, r: PointRef): VectorPath => setKnot(path, r, cornerKnot(path.subpaths[r.sub].knots[r.knot].anchor));

/** A smooth point with mirrored direction lines, `out` where given (dragging from a corner point). */
export const toSmooth = (path: VectorPath, r: PointRef, out: Vec2): VectorPath => setKnot(path, r, smoothKnot(path.subpaths[r.sub].knots[r.knot].anchor, out));

/** Removes one segment: a closed component opens there; an open one splits in two. */
export function deleteSegment(path: VectorPath, subIndex: number, seg: number): VectorPath {
  const s = path.subpaths[subIndex];
  const n = s.knots.length;
  const pieces: Subpath[] = [];
  if (s.closed) {
    const order = Array.from({ length: n }, (_, i) => s.knots[(seg + 1 + i) % n]);
    pieces.push({ ...s, knots: order, closed: false });
  } else {
    pieces.push({ ...s, knots: s.knots.slice(0, seg + 1) }, { ...s, knots: s.knots.slice(seg + 1) });
  }
  return { subpaths: [...path.subpaths.slice(0, subIndex), ...pieces, ...path.subpaths.slice(subIndex + 1)] };
}

export const removeSubpaths = (path: VectorPath, subs: readonly number[]): VectorPath => ({ subpaths: path.subpaths.filter((_, i) => !subs.includes(i)) });

const flip = (k: Knot): Knot => ({ ...k, in: k.out, out: k.in });
export const reverseKnots = (knots: readonly Knot[]): Knot[] => [...knots].reverse().map(flip);

/**
 * Joins two open components at the given ends — or, if they're the two ends
 * of one, closes it. The result keeps the first component's place; returns
 * the joined knot's references (`a`'s end, then `b`'s).
 */
export function joinEnds(path: VectorPath, a: PointRef, b: PointRef): { path: VectorPath; a: PointRef; b: PointRef } {
  if (a.sub === b.sub) {
    return { path: closeSubpath(path, a.sub), a, b };
  }
  const sa = path.subpaths[a.sub], sb = path.subpaths[b.sub];
  const first = a.knot === sa.knots.length - 1 ? sa.knots : reverseKnots(sa.knots);
  const second = b.knot === 0 ? sb.knots : reverseKnots(sb.knots);
  const merged: Subpath = { ...sa, knots: [...first, ...second] };
  const subpaths = path.subpaths.flatMap((s, i) => (i === a.sub ? [merged] : i === b.sub ? [] : [s]));
  const at = a.sub < b.sub ? a.sub : a.sub - 1;
  return { path: { subpaths }, a: { sub: at, knot: first.length - 1 }, b: { sub: at, knot: first.length } };
}

/**
 * Drags a segment by `d`, grabbed at parameter `t`: a straight segment
 * moves with its end points; a curve's direction points move so the curve
 * follows the pointer, the nearer end's more. A smooth end point's other
 * direction line turns to stay on one line — the segments either side bend
 * with it — unless `constrain` (Constrain Path Dragging), which leaves them.
 */
export function dragSegment(path: VectorPath, subIndex: number, seg: number, t: number, d: Vec2, constrain: boolean): VectorPath {
  const s = path.subpaths[subIndex];
  const n = s.knots.length;
  const ia = seg, ib = (seg + 1) % n;
  const a = s.knots[ia], b = s.knots[ib];
  let na: Knot, nb: Knot;
  if (isStraight(a, b)) {
    na = moveKnot(a, d);
    nb = moveKnot(b, d);
  } else {
    const u = Math.min(0.9, Math.max(0.1, t));
    const k = 1 / (3 * u * (1 - u) * ((1 - u) ** 2 + u ** 2));
    na = { ...a, out: add(a.out, vec(d.x * k * (1 - u), d.y * k * (1 - u))) };
    nb = { ...b, in: add(b.in, vec(d.x * k * u, d.y * k * u)) };
    na = follow(a, na, "out", constrain);
    nb = follow(b, nb, "in", constrain);
  }
  return withSub(path, subIndex, (x) => ({ ...x, knots: x.knots.map((kn, i) => (i === ia ? na : i === ib ? nb : kn)) }));
}

/** After a direction point of a smooth point moved: the other turns to follow (or, constrained, the point stops being smooth). */
function follow(before: Knot, moved: Knot, side: "in" | "out", constrain: boolean): Knot {
  if (!isSmooth(before)) return moved;
  if (constrain) return { ...moved, smooth: false };
  return moveHandle(before, side, moved[side], "smooth");
}

// --- Areas -------------------------------------------------------------------------------

const signedArea = (poly: readonly Vec2[]) => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
};

const oriented = (poly: Vec2[], positive: boolean) => (signedArea(poly) < 0 === positive ? [...poly].reverse() : poly);

/** A component flattened (through `map`), closed or not. */
export const flattenSubpath = (s: Subpath, map?: (p: Vec2) => Vec2): Vec2[] => flattenKnots(s.knots, s.closed, map);

/**
 * The area a path's components make, as polygons for the rasterizer (outer
 * rings one way round, holes the other, so non-zero winding fills them):
 * each component is an area — an open one closes with a straight edge —
 * and the operations (combine, subtract, intersect, exclude) apply in
 * order, as in Photoshop.
 */
export function pathArea(path: VectorPath, map?: (p: Vec2) => Vec2, resolve = false): Vec2[][] {
  const polys = path.subpaths.map((s) => ({ poly: flattenSubpath(s, map), op: s.op })).filter((p) => p.poly.length >= 3);
  return combineAreas(polys.map((p) => p.poly), polys.map((p) => p.op), resolve);
}

/**
 * Polygons combined in order by their operations (the first one's is
 * ignored). Overlapping polygons that only combine are left overlapping
 * (non-zero winding unites them) unless `resolve` asks for an outline with
 * no overlap.
 */
export function combineAreas(polys: readonly Vec2[][], ops: readonly PathOp[], resolve = false): Vec2[][] {
  if (polys.length <= 1 || (!resolve && ops.slice(1).every((o) => o === "combine"))) {
    // Union: every polygon one way round, so overlapping ones add under non-zero winding.
    return polys.map((p) => oriented(p, true));
  }
  const ring = (p: Vec2[]): [number, number][] => [...p.map((q) => [q.x, q.y] as [number, number]), [p[0].x, p[0].y]];
  let acc: polygonClipping.MultiPolygon = [[ring(polys[0])]];
  for (let i = 1; i < polys.length; i++) {
    const next: polygonClipping.Polygon = [ring(polys[i])];
    switch (ops[i]) {
      case "combine":
        acc = polygonClipping.union(acc, next);
        break;
      case "subtract":
        acc = polygonClipping.difference(acc, next);
        break;
      case "intersect":
        acc = polygonClipping.intersection(acc, next);
        break;
      case "exclude":
        acc = polygonClipping.xor(acc, next);
        break;
    }
  }
  const out: Vec2[][] = [];
  for (const poly of acc)
    poly.forEach((r, i) => {
      const pts = r.slice(0, -1).map(([x, y]) => vec(x, y));
      if (pts.length >= 3) out.push(oriented(pts, i === 0));
    });
  return out;
}

/** A path's extent: its anchor points and the curves between them. */
export function pathBounds(path: VectorPath): Rect | null {
  const pts = path.subpaths.flatMap((s) => flattenSubpath(s));
  return pts.length ? boundsOf(pts) : null;
}

/** Bounds of one component. */
export const subpathBounds = (s: Subpath): Rect | null => {
  const pts = flattenSubpath(s);
  return pts.length ? boundsOf(pts) : null;
};

// --- Components ---------------------------------------------------------------------------

export const mapPath = (path: VectorPath, f: (p: Vec2) => Vec2): VectorPath => ({
  subpaths: path.subpaths.map((s) => ({ ...s, knots: s.knots.map((k) => ({ ...k, anchor: f(k.anchor), in: f(k.in), out: f(k.out) })) })),
});

export const setOps = (path: VectorPath, subs: readonly number[], op: PathOp): VectorPath => ({
  subpaths: path.subpaths.map((s, i) => (subs.includes(i) ? { ...s, op } : s)),
});

/** Whole components copied, as dragging with Alt does; the copies come after the rest, in order. */
export const copySubpaths = (path: VectorPath, subs: readonly number[]): { path: VectorPath; copies: number[] } => {
  const picked = path.subpaths.filter((_, i) => subs.includes(i));
  return { path: { subpaths: [...path.subpaths, ...picked] }, copies: picked.map((_, i) => path.subpaths.length + i) };
};

/**
 * Merge Shape Components: the area the components make becomes one set of
 * components — each outline combined, its holes subtracted — with no
 * overlap left. (Curves are replaced by their flattened outlines.)
 */
export function mergeComponents(path: VectorPath): VectorPath {
  const rings = pathArea(path, undefined, true);
  const subpaths: Subpath[] = [];
  for (const ring of rings) {
    const outer = signedArea(ring) > 0;
    // pathArea orients outers positive and holes negative.
    const knots = ring.map((p): Knot => ({ anchor: p, in: p, out: p, smooth: false }));
    subpaths.push({ knots, closed: true, op: outer ? "combine" : "subtract" });
  }
  // Outers first, so holes cut what's before them.
  return { subpaths: [...subpaths.filter((s) => s.op === "combine"), ...subpaths.filter((s) => s.op === "subtract")] };
}

export type Alignment = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type Distribution = "top" | "vcenter" | "bottom" | "left" | "hcenter" | "right";

/** Aligns components to the edges or centre of their combined bounds (Path Alignment). */
export function alignSubpaths(path: VectorPath, subs: readonly number[], how: Alignment): VectorPath {
  const boxes = subs.map((i) => ({ i, b: subpathBounds(path.subpaths[i]) })).filter((x): x is { i: number; b: Rect } => !!x.b);
  if (boxes.length < 2) return path;
  const all = boundsOf(boxes.flatMap(({ b }) => [vec(b.x, b.y), vec(b.x + b.w, b.y + b.h)]));
  let out = path;
  for (const { i, b } of boxes) {
    const d =
      how === "left" ? vec(all.x - b.x, 0)
      : how === "right" ? vec(all.x + all.w - (b.x + b.w), 0)
      : how === "hcenter" ? vec(all.x + all.w / 2 - (b.x + b.w / 2), 0)
      : how === "top" ? vec(0, all.y - b.y)
      : how === "bottom" ? vec(0, all.y + all.h - (b.y + b.h))
      : vec(0, all.y + all.h / 2 - (b.y + b.h / 2));
    out = moveSubpaths(out, [i], d);
  }
  return out;
}

/** Spreads at least three components evenly by their edges or centres (Path Arrangement ▸ Distribute). */
export function distributeSubpaths(path: VectorPath, subs: readonly number[], how: Distribution): VectorPath {
  const horizontal = how === "left" || how === "hcenter" || how === "right";
  const boxes = subs.map((i) => ({ i, b: subpathBounds(path.subpaths[i]) })).filter((x): x is { i: number; b: Rect } => !!x.b);
  if (boxes.length < 3) return path;
  const key = (b: Rect) => {
    const [pos, size] = horizontal ? [b.x, b.w] : [b.y, b.h];
    return how === "left" || how === "top" ? pos : how === "right" || how === "bottom" ? pos + size : pos + size / 2;
  };
  const sorted = [...boxes].sort((p, q) => key(p.b) - key(q.b));
  const lo = key(sorted[0].b), hi = key(sorted[sorted.length - 1].b);
  let out = path;
  sorted.forEach(({ i, b }, n) => {
    const want = lo + ((hi - lo) * n) / (sorted.length - 1);
    const d = want - key(b);
    out = moveSubpaths(out, [i], horizontal ? vec(d, 0) : vec(0, d));
  });
  return out;
}

/** Brings components forward or back in the stacking order (the order operations apply in). */
export function arrangeSubpaths(path: VectorPath, subs: readonly number[], how: "front" | "forward" | "backward" | "back"): { path: VectorPath; moved: number[] } {
  const items = path.subpaths.map((s, i) => ({ s, sel: subs.includes(i) }));
  const order = [...items];
  if (how === "front" || how === "back") {
    const sel = order.filter((x) => x.sel), rest = order.filter((x) => !x.sel);
    const next = how === "front" ? [...rest, ...sel] : [...sel, ...rest];
    return { path: { subpaths: next.map((x) => x.s) }, moved: next.flatMap((x, i) => (x.sel ? [i] : [])) };
  }
  const step = how === "forward" ? 1 : -1;
  const idx = order.map((_, i) => i);
  const walk = step > 0 ? [...idx].reverse() : idx;
  for (const i of walk) {
    const j = i + step;
    if (order[i].sel && j >= 0 && j < order.length && !order[j].sel) [order[i], order[j]] = [order[j], order[i]];
  }
  return { path: { subpaths: order.map((x) => x.s) }, moved: order.flatMap((x, i) => (x.sel ? [i] : [])) };
}
