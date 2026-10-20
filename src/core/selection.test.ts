import { describe, expect, it } from "vitest";
import { rect, translation, vec } from "./geometry";
import {
  combine, ellipseMask, invertSelection, magicWand, maskAt, modeFromModifiers, polygonMask, rectMask, selectAll, transformMask,
} from "./selection";
import { tilesFromImage } from "./tiles";

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
  const tiles = tilesFromImage(W, H, img);

  it("selects contiguous similar pixels", () => expect(sum(magicWand(tiles, W, H, vec(2, 2), 10))).toBe(200));
  it("selects all similar pixels when not contiguous", () =>
    expect(sum(magicWand(tiles, W, H, vec(2, 2), 10, false))).toBe(201));
  it("respects tolerance", () => expect(sum(magicWand(tiles, W, H, vec(2, 2), 255))).toBe(400));
});

it("transforms masks", () => {
  const m = transformMask(rectMask(W, H, rect(0, 0, 4, 4))!, translation(3, 2))!;
  expect(m.bounds).toEqual(rect(3, 2, 4, 4));
  expect(sum(m)).toBe(16);
});
