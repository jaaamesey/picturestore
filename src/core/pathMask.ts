import { fitCurve } from "./curveFit";
import { rasterizeContours } from "./coverage";
import { rect, vec, type Rect, type Vec2 } from "./geometry";
import { pathArea, type Subpath, type VectorPath } from "./path";
import { featherMask, toMask, type Mask } from "./selection";
import type { Knot } from "./bezier";

/**
 * Paths and selections into one another: Load Path as Selection (Make
 * Selection) and Make Work Path.
 */

export interface PathMaskOptions {
  /** Soft edges; off thresholds the coverage to whole pixels. */
  readonly antiAlias: boolean;
  /** Feather radius in pixels. */
  readonly feather: number;
}

/** The area a path covers (its components combined by their operations) as a selection of a `width × height` document; null if empty. */
export function pathToMask(path: VectorPath, width: number, height: number, o: PathMaskOptions = { antiAlias: true, feather: 0 }): Mask | null {
  const clip: Rect = rect(0, 0, width, height);
  const c = rasterizeContours(pathArea(path, undefined, true), clip);
  let mask = c && toMask(c.data, c.region, width, height);
  if (mask && !o.antiAlias) mask = toMask(mask.data.map((v) => (v >= 128 ? 255 : 0)), mask.bounds, width, height);
  return featherMask(mask, o.feather);
}

/**
 * The outlines of a selection as a path (Make Work Path): its edge where
 * coverage crosses one half, traced along pixel boundaries and fitted with
 * curves to within `tolerance` pixels — the higher, the fewer anchor points.
 * Outlines are components that combine; holes subtract.
 */
export function maskToPath(mask: Mask | null, tolerance: number): VectorPath {
  if (!mask) return { subpaths: [] };
  const { bounds: b, data } = mask;
  // A pixel of the padded grid is inside the selection when at least half covered.
  const w = b.w + 2, h = b.h + 2;
  const inside = (x: number, y: number) => x >= 1 && y >= 1 && x <= b.w && y <= b.h && data[(y - 1) * b.w + (x - 1)] >= 128;
  const V = w + 1; // vertices per row of the grid of pixel corners
  const key = (x: number, y: number) => y * V + x;
  // Boundary edges with the selection on their right (in y-down coordinates: clockwise around it).
  const out = new Map<number, [number, number][]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = out.get(k);
    if (list) list.push([x1, y1]);
    else out.set(k, [[x1, y1]]);
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) add(x, y, x + 1, y);
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) add(x, y + 1, x, y);
    }
  const outlines: { pts: Vec2[]; area: number }[] = [];
  while (out.size) {
    const [startKey] = out.entries().next().value!;
    const sx = startKey % V, sy = Math.floor(startKey / V);
    const ring: Vec2[] = [];
    let x = sx, y = sy, dx = 0, dy = 0;
    for (;;) {
      ring.push(vec(x + b.x - 1, y + b.y - 1));
      const k = key(x, y);
      const options = out.get(k);
      if (!options) break;
      // At a vertex where two outlines touch, turn right (keeping the selection's pixels apart).
      let pick = 0;
      if (options.length > 1) {
        const turn = (o: [number, number]) => (o[0] - x) * -dy + (o[1] - y) * dx; // > 0: a right turn in y-down coordinates
        pick = options.reduce((best, o, i) => (turn(o) > turn(options[best]) ? i : best), 0);
      }
      const [nx, ny] = options[pick];
      options.splice(pick, 1);
      if (!options.length) out.delete(k);
      dx = nx - x;
      dy = ny - y;
      x = nx;
      y = ny;
      if (x === sx && y === sy) break;
    }
    if (ring.length >= 3) outlines.push({ pts: ring, area: signedArea(ring) });
  }
  const subpaths: Subpath[] = outlines.map(({ pts, area }) => ({ knots: fitRing(pts, tolerance), closed: true, op: area > 0 ? "combine" : "subtract" }));
  // Outlines first, so the holes cut what's before them.
  return { subpaths: [...subpaths.filter((s) => s.op === "combine"), ...subpaths.filter((s) => s.op === "subtract")] };
}

const signedArea = (p: readonly Vec2[]) => p.reduce((s, a, i) => s + (a.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * a.y), 0) / 2;

/** A closed outline of pixel corners as curves within `tolerance`. */
function fitRing(ring: readonly Vec2[], tolerance: number): Knot[] {
  // Collinear corners carry nothing.
  const pts = ring.filter((p, i) => {
    const a = ring[(i + ring.length - 1) % ring.length], c = ring[(i + 1) % ring.length];
    return (p.x - a.x) * (c.y - p.y) !== (p.y - a.y) * (c.x - p.x);
  });
  if (pts.length < 3 || tolerance <= 0.5) return pts.map((p) => ({ anchor: p, in: p, out: p, smooth: false }));
  // Corners of the staircase are real corners where the outline turns sharply over a few pixels: fit the open ring, closed at its start.
  const knots = fitCurve([...pts, pts[0]], tolerance);
  const last = knots.pop()!;
  knots[0] = { ...knots[0], in: last.in, smooth: false };
  return knots;
}
