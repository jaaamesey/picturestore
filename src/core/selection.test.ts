import { describe, expect, it } from "vitest";
import { rect, vec } from "./geometry";
import { quadOf } from "./warp";
import {
  combine, ellipseMask, invertSelection, magicWand, maskAt, modeFromModifiers, polygonMask, rectMask, selectAll, transformMask,
} from "./selection";
import { pixelsFromImage } from "./pixels";

const W = 20, H = 20;
const sum = (m: { data: Uint8Array } | null) => (m ? m.data.reduce((a, v) => a + v, 0) / 255 : 0);

describe("selection shapes", () => {
  it("snaps rectangles to whole pixels and clips to the canvas", () => {
    const m = rectMask(W, H, rect(15.2, -3, 10, 5))!;
    expect(m.bounds).toEqual(rect(15, 0, 5, 2));
    expect(sum(m)).toBe(10);
  });

  it("returns null for empty shapes", () => {
    expect(rectMask(W, H, rect(30, 30, 5, 5))).toBeNull();
    expect(ellipseMask(W, H, rect(0, 0, 0, 5))).toBeNull();
  });

  it("antialiases ellipses with area ≈ πab", () => {
    const m = ellipseMask(W, H, rect(2, 2, 16, 10))!;
    expect(sum(m)).toBeCloseTo(Math.PI * 8 * 5, 0);
    expect(maskAt(m, 10, 7)).toBe(255);
    expect(maskAt(m, 2, 2)).toBe(0);
  });

  it("fills polygons with exact area for axis-aligned shapes", () => {
    const m = polygonMask(W, H, [vec(2, 2), vec(12, 2), vec(12, 7), vec(2, 7)])!;
    expect(sum(m)).toBeCloseTo(50, 5);
    const tri = polygonMask(W, H, [vec(0, 0), vec(10, 0), vec(0, 10)])!;
    expect(sum(tri)).toBeCloseTo(50, 0);
  });
});

describe("combining", () => {
  const a = rectMask(W, H, rect(0, 0, 10, 10));
  const b = rectMask(W, H, rect(5, 5, 10, 10));
  it.each([
    ["replace", 100],
    ["add", 175],
    ["subtract", 75],
    ["intersect", 25],
  ] as const)("%s", (mode, area) => expect(sum(combine(a, b, mode))).toBe(area));

  it("subtracting everything deselects", () => {
    expect(combine(a, selectAll(W, H), "subtract")).toBeNull();
  });

  it("inverts (no selection inverts to everything)", () => {
    expect(sum(invertSelection(a, W, H))).toBe(W * H - 100);
    expect(sum(invertSelection(null, W, H))).toBe(W * H);
  });

  it("maps modifier keys like Photoshop", () => {
    expect(modeFromModifiers("replace", true, false)).toBe("add");
    expect(modeFromModifiers("replace", false, true)).toBe("subtract");
    expect(modeFromModifiers("replace", true, true)).toBe("intersect");
    expect(modeFromModifiers("add", false, false)).toBe("add");
  });
});

describe("magic wand", () => {
  // Left half red, right half blue, with a red island on the right.
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) img.set(x < 10 || (x === 15 && y === 15) ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * W + x) * 4);
  const tiles = pixelsFromImage(W, H, img);

  it("selects contiguous similar pixels", () => expect(sum(magicWand(tiles, W, H, vec(2, 2), 10))).toBe(200));
  it("selects all similar pixels when not contiguous", () =>
    expect(sum(magicWand(tiles, W, H, vec(2, 2), 10, false))).toBe(201));
  it("respects tolerance", () => expect(sum(magicWand(tiles, W, H, vec(2, 2), 255))).toBe(400));
});

describe("transformMask", () => {
  it("translates and scales through a mapping", () => {
    const src = rectMask(W, H, rect(0, 0, 4, 4))!;
    const moved = transformMask(src, { source: rect(0, 0, 4, 4), quad: quadOf(rect(3, 2, 4, 4)), patch: null })!;
    expect(moved.bounds).toEqual(rect(3, 2, 4, 4));
    expect(sum(moved)).toBe(16);
    const scaled = transformMask(src, { source: rect(0, 0, 4, 4), quad: quadOf(rect(0, 0, 8, 8)), patch: null })!;
    expect(scaled.bounds).toEqual(rect(0, 0, 8, 8));
    expect(maskAt(scaled, 4, 4)).toBe(255);
  });
});

describe("polygon rasterization", () => {
  it("covers exact areas, including fractional edges", () => {
    expect(sum(polygonMask(W, H, [vec(2.5, 2), vec(7.5, 2), vec(7.5, 6), vec(2.5, 6)]))).toBeCloseTo(20, 1);
    expect(sum(polygonMask(W, H, [vec(0, 0), vec(10, 0), vec(0, 10)]))).toBeCloseTo(50, 1);
  });

  it("clips lassos that wander off the canvas", () => {
    const m = polygonMask(W, H, [vec(-50, -50), vec(10, -50), vec(10, 70), vec(-50, 70)])!;
    expect(m.bounds).toEqual(rect(0, 0, 10, 20));
    expect(sum(m)).toBeCloseTo(200, 1);
  });

  it("handles self-intersecting lassos (both lobes of a figure eight)", () => {
    const m = polygonMask(W, H, [vec(0, 0), vec(10, 10), vec(10, 0), vec(0, 10)])!;
    expect(sum(m)).toBeCloseTo(50, 0);
  });

  it("stores only the selection's bounds", () => {
    const m = rectMask(1000, 1000, rect(10, 10, 5, 5))!;
    expect(m.data.length).toBe(25);
  });
});
