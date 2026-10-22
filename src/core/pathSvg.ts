import type { Vec2 } from "./geometry";
import type { Subpath, VectorPath } from "./path";

/** An SVG path through a component's knots, with points mapped through `at`. */
export function subpathData(s: Subpath, at: (p: Vec2) => Vec2 = (p) => p): string {
  const n = s.knots.length;
  if (!n) return "";
  const pt = (p: Vec2) => `${at(p).x},${at(p).y}`;
  let d = `M${pt(s.knots[0].anchor)}`;
  const last = s.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = s.knots[i], b = s.knots[(i + 1) % n];
    d += ` C${pt(a.out)} ${pt(b.in)} ${pt(b.anchor)}`;
  }
  return s.closed && n > 1 ? `${d}Z` : d;
}

/** All of a path's components as one SVG path. */
export const pathData = (path: VectorPath, at?: (p: Vec2) => Vec2): string => path.subpaths.map((s) => subpathData(s, at)).join(" ");
