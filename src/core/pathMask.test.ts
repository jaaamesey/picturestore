import { describe, expect, it } from "vitest";
import { flattenKnots } from "./bezier";
import { cornerKnot, pathArea, type VectorPath } from "./path";
import { maskToPath, pathToMask } from "./pathMask";
import { maskAt, rectMask, combine, featherMask } from "./selection";
import { vec } from "./geometry";

const box = (x: number, y: number, s: number, op: "combine" | "subtract" = "combine") => ({ closed: true, op, knots: [cornerKnot(vec(x, y)), cornerKnot(vec(x + s, y)), cornerKnot(vec(x + s, y + s)), cornerKnot(vec(x, y + s))] });

describe("paths and selections", () => {
  it("a path makes a selection: components operate, holes cut", () => {
    const m = pathToMask({ subpaths: [box(10, 10, 40), box(20, 20, 10, "subtract")] }, 100, 100)!;
    expect(maskAt(m, 15, 15)).toBe(255);
    expect(maskAt(m, 25, 25)).toBe(0);
    expect(maskAt(m, 60, 60)).toBe(0);
    expect(m.bounds).toEqual({ x: 10, y: 10, w: 40, h: 40 });
  });

  it("edges are soft with anti-aliasing and whole pixels without; an empty path selects nothing", () => {
    const tri: VectorPath = { subpaths: [{ closed: true, op: "combine", knots: [cornerKnot(vec(0, 0)), cornerKnot(vec(40, 0)), cornerKnot(vec(0, 40))] }] };
    const soft = pathToMask(tri, 50, 50, { antiAlias: true, feather: 0 })!;
    const hard = pathToMask(tri, 50, 50, { antiAlias: false, feather: 0 })!;
    expect(soft.data.some((v) => v > 0 && v < 255)).toBe(true);
    expect(hard.data.every((v) => v === 0 || v === 255)).toBe(true);
    expect(pathToMask({ subpaths: [] }, 50, 50)).toBeNull();
  });

  it("feathering spreads the edge and keeps the middle", () => {
    const m = rectMask(100, 100, { x: 30, y: 30, w: 40, h: 40 });
    const f = featherMask(m, 8)!;
    expect(maskAt(f, 50, 50)).toBe(255);
    expect(maskAt(f, 30, 50)).toBeGreaterThan(100);
    expect(maskAt(f, 30, 50)).toBeLessThan(160);
    expect(maskAt(f, 24, 50)).toBeGreaterThan(0);
    expect(maskAt(f, 24, 50)).toBeLessThan(maskAt(f, 30, 50));
    expect(featherMask(m, 0)).toBe(m);
  });

  it("a selection makes a work path: outlines combine, holes subtract", () => {
    const sel = combine(rectMask(100, 100, { x: 10, y: 10, w: 60, h: 60 }), rectMask(100, 100, { x: 30, y: 30, w: 20, h: 20 }), "subtract");
    const path = maskToPath(sel, 0.5);
    expect(path.subpaths.map((s) => s.op)).toEqual(["combine", "subtract"]);
    expect(path.subpaths[0].knots).toHaveLength(4);
    // Back to a selection, it's the same one.
    const again = pathToMask(path, 100, 100)!;
    expect(again.bounds).toEqual(sel!.bounds);
    expect(maskAt(again, 20, 20)).toBe(255);
    expect(maskAt(again, 40, 40)).toBe(0);
  });

  it("a higher tolerance gives fewer anchor points, and a circle becomes curves close to it", () => {
    const disc = new Uint8Array(81 * 81);
    for (let y = 0; y < 81; y++) for (let x = 0; x < 81; x++) disc[y * 81 + x] = Math.hypot(x - 40, y - 40) <= 30 ? 255 : 0;
    const m = { width: 100, height: 100, bounds: { x: 5, y: 5, w: 81, h: 81 }, data: disc };
    const fine = maskToPath(m, 1);
    const coarse = maskToPath(m, 6);
    expect(coarse.subpaths[0].knots.length).toBeLessThan(fine.subpaths[0].knots.length);
    expect(coarse.subpaths[0].knots.length).toBeLessThan(12);
    for (const p of flattenKnots(fine.subpaths[0].knots, true)) expect(Math.abs(Math.hypot(p.x - 45, p.y - 45) - 30.5)).toBeLessThan(2.5);
    expect(pathArea(fine, undefined, true)).toHaveLength(1);
  });

  it("separate outlines each become a component; nothing selected, an empty path", () => {
    const a = rectMask(100, 100, { x: 5, y: 5, w: 10, h: 10 });
    const sel = combine(a, rectMask(100, 100, { x: 40, y: 40, w: 10, h: 10 }), "add");
    expect(maskToPath(sel, 1).subpaths).toHaveLength(2);
    expect(maskToPath(null, 1).subpaths).toEqual([]);
  });
});
