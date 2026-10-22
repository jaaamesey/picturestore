import { describe, expect, it } from "vitest";
import { flattenKnots } from "./bezier";
import { fitCurve } from "./curveFit";
import { distToSegment } from "./bezier";
import { vec, type Vec2 } from "./geometry";

const distToPolyline = (p: Vec2, poly: readonly Vec2[]) => Math.min(...poly.slice(1).map((q, i) => distToSegment(p, poly[i], q)));

describe("curve fitting", () => {
  it("fits a straight line with two points", () => {
    const knots = fitCurve(Array.from({ length: 50 }, (_, i) => vec(i * 2, i)), 1);
    expect(knots).toHaveLength(2);
    expect(knots[0].anchor).toEqual(vec(0, 0));
    expect(knots[1].anchor).toEqual(vec(98, 49));
  });

  it("fits a half circle to within the error with a few anchor points", () => {
    const pts = Array.from({ length: 200 }, (_, i) => {
      const a = (i / 199) * Math.PI;
      return vec(100 + 80 * Math.cos(a), 100 + 80 * Math.sin(a));
    });
    const knots = fitCurve(pts, 1);
    expect(knots.length).toBeGreaterThanOrEqual(2);
    expect(knots.length).toBeLessThanOrEqual(5);
    const poly = flattenKnots(knots, false);
    for (const p of pts) expect(distToPolyline(p, poly)).toBeLessThan(1.1);
    // Interior joins are smooth: the direction lines are opposite.
    for (const k of knots.slice(1, -1)) {
      const a = vec(k.in.x - k.anchor.x, k.in.y - k.anchor.y), b = vec(k.out.x - k.anchor.x, k.out.y - k.anchor.y);
      expect(a.x * b.y - a.y * b.x).toBeCloseTo(0, 3);
      expect(a.x * b.x + a.y * b.y).toBeLessThan(0);
    }
  });

  it("uses fewer anchor points when the error allowed is greater", () => {
    const wobble = Array.from({ length: 300 }, (_, i) => vec(i, 20 * Math.sin(i / 20) + (i % 3)));
    expect(fitCurve(wobble, 8).length).toBeLessThan(fitCurve(wobble, 0.5).length);
  });

  it("copes with one point, two points and repeats", () => {
    expect(fitCurve([], 1)).toEqual([]);
    expect(fitCurve([vec(3, 4), vec(3, 4)], 1)).toHaveLength(1);
    expect(fitCurve([vec(0, 0), vec(10, 0)], 1)).toHaveLength(2);
  });
});
