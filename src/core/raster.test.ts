import { describe, expect, it } from "vitest";
import { compose, rect, scaling, translation } from "./geometry";
import { compositeOver, extractFloating, transformTiles } from "./raster";
import { rectMask } from "./selection";
import { contentBounds, getPixel, tilesFromImage } from "./tiles";

const square = (w: number, rgba: number[], x = 0, y = 0) => {
  const d = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < d.length; i += 4) d.set(rgba, i);
  return tilesFromImage(w, w, d, x, y);
};

describe("floating selections", () => {
  it("lifts selected pixels and leaves a hole", () => {
    const tiles = square(10, [0, 0, 255, 255]);
    const { floating, rest } = extractFloating(tiles, rectMask(10, 10, rect(2, 2, 3, 3)));
    expect(floating.bounds).toEqual(rect(2, 2, 3, 3));
    expect(getPixel(floating.tiles, 3, 3)).toEqual([0, 0, 255, 255]);
    expect(getPixel(rest, 3, 3)[3]).toBe(0);
    expect(getPixel(rest, 0, 0)[3]).toBe(255);
  });

  it("floats the whole layer without a selection", () => {
    const tiles = square(4, [1, 2, 3, 255], 7, 7);
    const { floating, rest } = extractFloating(tiles, null);
    expect(floating.tiles).toBe(tiles);
    expect(rest.size).toBe(0);
  });
});

describe("transformTiles", () => {
  const tiles = square(4, [255, 0, 0, 255], 10, 10);
  const f = { tiles, bounds: contentBounds(tiles) };

  it("translates exactly by whole pixels", () => {
    const out = transformTiles(f, translation(5, -3));
    expect(contentBounds(out)).toEqual(rect(15, 7, 4, 4));
    expect(getPixel(out, 15, 7)).toEqual([255, 0, 0, 255]);
  });

  it("scales with bilinear filtering and no dark fringes", () => {
    const m = compose(translation(-10, -10), scaling(2), translation(10, 10));
    const out = transformTiles(f, m);
    expect(contentBounds(out)).toEqual(rect(10, 10, 8, 8));
    expect(getPixel(out, 13, 13)).toEqual([255, 0, 0, 255]);
    const edge = getPixel(out, 10, 10);
    expect(edge.slice(0, 3)).toEqual([255, 0, 0]); // colour preserved even where alpha < 1
  });
});

it("composites over", () => {
  const base = square(2, [0, 0, 255, 255]);
  const top = square(1, [255, 0, 0, 128]);
  const out = compositeOver(base, top);
  const [r, g, b, a] = getPixel(out, 0, 0);
  expect([r, g, a]).toEqual([128, 0, 255]);
  expect(b).toBe(127);
  expect(getPixel(out, 1, 1)).toEqual([0, 0, 255, 255]);
});
