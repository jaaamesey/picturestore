import { describe, expect, it } from "vitest";
import { DEFAULT_BRUSH, beginStroke, createInterpolator, dabAlpha, type BrushSettings } from "./brush";
import { rect } from "./geometry";
import { rectMask } from "./selection";
import { EMPTY_TILES, getPixel, tilesFromImage } from "./tiles";

const red = { r: 255, g: 0, b: 0 };
const clip = rect(0, 0, 100, 100);
const brush = (b: Partial<BrushSettings> = {}): BrushSettings => ({ ...DEFAULT_BRUSH, pressureSize: false, ...b });

describe("dabs", () => {
  it("is opaque inside a hard brush and antialiased at the edge", () => {
    expect(dabAlpha(0, 10, 1)).toBe(1);
    expect(dabAlpha(9, 10, 1)).toBe(1);
    expect(dabAlpha(10, 10, 1)).toBe(0.5);
    expect(dabAlpha(11, 10, 1)).toBe(0);
  });
  it("falls off smoothly for soft brushes", () => {
    expect(dabAlpha(0, 10, 0)).toBe(1);
    const mid = dabAlpha(5, 10, 0);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });
});

describe("interpolation", () => {
  it("places dabs at even spacing regardless of event granularity", () => {
    const coarse = createInterpolator(() => 2);
    const fine = createInterpolator(() => 2);
    const a = [{ x: 0, y: 0, pressure: 1 }, { x: 10, y: 0, pressure: 1 }].flatMap(coarse);
    const b = Array.from({ length: 11 }, (_, i) => ({ x: i, y: 0, pressure: 1 })).flatMap(fine);
    const xs = (d: { x: number }[]) => d.map((p) => +p.x.toFixed(6));
    expect(xs(a)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(xs(b)).toEqual(xs(a));
  });
  it("emits nothing for stationary input after the first point", () => {
    const f = createInterpolator(() => 2);
    expect(f({ x: 1, y: 1, pressure: 1 })).toHaveLength(1);
    expect(f({ x: 1, y: 1, pressure: 1 })).toHaveLength(0);
  });
});

describe("strokes", () => {
  it("paints the brush colour", () => {
    const s = beginStroke(EMPTY_TILES, { brush: brush({ size: 10, hardness: 1 }), color: red, erase: false, selection: null, clip });
    s.add({ x: 50, y: 50, pressure: 1 });
    const tiles = s.finish();
    expect(getPixel(tiles, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(getPixel(tiles, 60, 50)[3]).toBe(0);
  });

  it("never exceeds stroke opacity where dabs overlap", () => {
    const s = beginStroke(EMPTY_TILES, { brush: brush({ size: 10, opacity: 0.5, flow: 1 }), color: red, erase: false, selection: null, clip });
    for (let x = 40; x <= 60; x++) s.add({ x, y: 50, pressure: 1 });
    expect(getPixel(s.finish(), 50, 50)[3]).toBe(128);
  });

  it("builds up with low flow", () => {
    const one = beginStroke(EMPTY_TILES, { brush: brush({ size: 10, flow: 0.2 }), color: red, erase: false, selection: null, clip });
    one.add({ x: 50, y: 50, pressure: 1 });
    const many = beginStroke(EMPTY_TILES, { brush: brush({ size: 10, flow: 0.2 }), color: red, erase: false, selection: null, clip });
    for (let x = 45; x <= 55; x++) many.add({ x, y: 50, pressure: 1 });
    expect(getPixel(many.finish(), 50, 50)[3]).toBeGreaterThan(getPixel(one.finish(), 50, 50)[3]);
  });

  it("is clipped by the selection and the canvas", () => {
    const sel = rectMask(100, 100, rect(0, 0, 50, 100));
    const s = beginStroke(EMPTY_TILES, { brush: brush({ size: 20, hardness: 1 }), color: red, erase: false, selection: sel, clip });
    s.add({ x: 50, y: 50, pressure: 1 });
    s.add({ x: 99, y: 99, pressure: 1 });
    const t = s.finish();
    expect(getPixel(t, 45, 50)[3]).toBe(255);
    expect(getPixel(t, 55, 50)[3]).toBe(0);
    expect(getPixel(t, 100, 100)[3]).toBe(0);
  });

  it("erases, leaving the base untouched", () => {
    const base = tilesFromImage(100, 100, new Uint8ClampedArray(100 * 100 * 4).fill(255));
    const s = beginStroke(base, { brush: brush({ size: 10, hardness: 1 }), color: red, erase: true, selection: null, clip });
    s.add({ x: 50, y: 50, pressure: 1 });
    expect(getPixel(s.finish(), 50, 50)[3]).toBe(0);
    expect(getPixel(base, 50, 50)[3]).toBe(255);
  });

  it("scales size with pressure", () => {
    const s = beginStroke(EMPTY_TILES, { brush: { ...brush({ size: 20, hardness: 1 }), pressureSize: true }, color: red, erase: false, selection: null, clip });
    s.add({ x: 50, y: 50, pressure: 0.25 });
    const t = s.finish();
    expect(getPixel(t, 50, 50)[3]).toBe(255);
    expect(getPixel(t, 50, 56)[3]).toBe(0);
  });
});
