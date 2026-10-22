import { vec, type Vec2 } from "./geometry";
import type { Knot } from "./bezier";
import type { VectorPath } from "./path";

/**
 * The Curvature Pen's points: a point marked `auto` is smooth, its direction
 * lines running along the line between its neighbours and a third as long as
 * the segments they belong to, so that a curve passes through the points
 * with no handles to manage. Moving or removing a point re-forms the curve.
 * An end point has just the one line, straight at its neighbour.
 */
export function relaxKnots(knots: readonly Knot[], closed: boolean): Knot[] {
  const n = knots.length;
  const around = (i: number): [Vec2 | null, Vec2 | null] => [
    closed ? knots[(i + n - 1) % n].anchor : i > 0 ? knots[i - 1].anchor : null,
    closed ? knots[(i + 1) % n].anchor : i < n - 1 ? knots[i + 1].anchor : null,
  ];
  return knots.map((k, i) => {
    if (!k.auto || n < 2) return k;
    const [prev, next] = around(i);
    const a = k.anchor;
    const toward = (p: Vec2 | null, dir: Vec2 | null, sign: number) => {
      if (!p) return a;
      const d = Math.hypot(p.x - a.x, p.y - a.y) / 3;
      // Along the line between the neighbours if both are there, else straight at the one.
      return dir ? vec(a.x + sign * dir.x * d, a.y + sign * dir.y * d) : vec(a.x + (p.x - a.x) / 3, a.y + (p.y - a.y) / 3);
    };
    let dir: Vec2 | null = null;
    if (prev && next) {
      const l = Math.hypot(next.x - prev.x, next.y - prev.y);
      if (l > 0) dir = vec((next.x - prev.x) / l, (next.y - prev.y) / l);
    }
    return { ...k, in: toward(prev, dir, -1), out: toward(next, dir, 1), smooth: true };
  });
}

/** The path with every component's automatic points re-formed. */
export const relaxPath = (path: VectorPath): VectorPath => ({
  subpaths: path.subpaths.map((s) => (s.knots.some((k) => k.auto) ? { ...s, knots: relaxKnots(s.knots, s.closed) } : s)),
});
