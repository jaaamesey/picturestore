import { describe, expect, it } from "vitest";
import { createEdges, traceEdge } from "./livewire";

/** An image of `w × h` whose pixels are `f(x, y)` greys. */
const image = (f: (x: number, y: number) => number) => (area: { x: number; y: number; w: number; h: number }) => {
  const out = new Uint8ClampedArray(area.w * area.h * 4);
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) out.set([f(area.x + x, area.y + y), f(area.x + x, area.y + y), f(area.x + x, area.y + y), 255], (y * area.w + x) * 4);
  return out;
};

describe("live-wire", () => {
  const bounds = { width: 200, height: 200 };
  it("measures edges: a black/white step is 255, flat colour 0", () => {
    const e = createEdges(200, 200, image((x) => (x < 100 ? 0 : 255)));
    expect(e.at(99, 50)).toBe(255);
    expect(e.at(100, 50)).toBe(255);
    expect(e.at(98, 50)).toBe(0);
    expect(e.at(20, 50)).toBe(0);
    expect(e.at(-1, 0)).toBe(0);
  });

  it("follows an edge between two points that are off it", () => {
    const e = createEdges(200, 200, image((x) => (x < 100 ? 0 : 255)));
    const route = traceEdge(e, { x: 96, y: 20 }, { x: 104, y: 120 }, { width: 10, contrast: 10 }, bounds);
    const mid = route.slice(10, -10);
    expect(mid.length).toBeGreaterThan(50);
    for (const p of mid) expect(Math.abs(p.x - 100)).toBeLessThan(1.6);
    expect(route[0]).toEqual({ x: 96, y: 20 });
    expect(route[route.length - 1]).toEqual({ x: 104, y: 120 });
  });

  it("takes the straight way across flat colour", () => {
    const e = createEdges(200, 200, image(() => 128));
    const route = traceEdge(e, { x: 20, y: 20 }, { x: 120, y: 70 }, { width: 20, contrast: 10 }, bounds);
    for (const p of route) expect(Math.abs(p.y - (20 + (p.x - 20) / 2))).toBeLessThan(3);
  });

  it("does not stray farther than the width, and a higher contrast needs a stronger edge", () => {
    // A faint edge (a step of 20 grey levels) 15 px from the straight line.
    const e = createEdges(200, 200, image((x) => (x < 85 ? 100 : 120)));
    const near = traceEdge(e, { x: 100, y: 20 }, { x: 100, y: 120 }, { width: 5, contrast: 5 }, bounds);
    for (const p of near) expect(Math.abs(p.x - 100)).toBeLessThan(7);
    const far = traceEdge(e, { x: 100, y: 20 }, { x: 100, y: 120 }, { width: 30, contrast: 5 }, bounds);
    expect(far.slice(10, -10).some((p) => Math.abs(p.x - 85) < 3)).toBe(true);
    const strict = traceEdge(e, { x: 100, y: 20 }, { x: 100, y: 120 }, { width: 30, contrast: 80 }, bounds);
    for (const p of strict) expect(Math.abs(p.x - 100)).toBeLessThan(3);
  });
});
