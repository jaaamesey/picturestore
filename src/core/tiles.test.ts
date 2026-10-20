import { describe, expect, it } from "vitest";
import { rect } from "./geometry";
import {
  EMPTY_TILES, TILE_SIZE, contentBounds, getPixel, readRect, tileWriter, tilesFromImage, tilesIn, translateTiles, writeRect,
} from "./tiles";

const solid = (w: number, h: number, rgba: number[]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) d.set(rgba, i);
  return d;
};

describe("tiles", () => {
  it("enumerates tiles overlapping a rect, including negative coordinates", () => {
    expect([...tilesIn(rect(-1, 0, 2, TILE_SIZE + 1))]).toEqual([[-1, 0], [0, 0], [-1, 1], [0, 1]]);
  });

  it("round-trips pixels across tile boundaries", () => {
    const r = rect(TILE_SIZE - 3, -2, 7, 5);
    const data = new Uint8ClampedArray(r.w * r.h * 4).map((_, i) => i % 251);
    const w = tileWriter(EMPTY_TILES);
    writeRect(w, r, data);
    const tiles = w.finish();
    expect(tiles.size).toBe(4);
    expect(readRect(tiles, r)).toEqual(data);
  });

  it("is copy-on-write: writers never mutate tiles they did not create", () => {
    const base = tilesFromImage(2, 2, solid(2, 2, [255, 0, 0, 255]));
    const before = getPixel(base, 0, 0);
    const w = tileWriter(base);
    writeRect(w, rect(0, 0, 1, 1), new Uint8ClampedArray([0, 255, 0, 255]));
    const after = w.finish();
    expect(getPixel(base, 0, 0)).toEqual(before);
    expect(getPixel(after, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(getPixel(after, 1, 0)).toEqual([255, 0, 0, 255]);
  });

  it("drops fully transparent tiles on finish", () => {
    const w = tileWriter(EMPTY_TILES);
    w.writable(3, 3);
    expect(w.finish().size).toBe(0);
  });

  it("computes tight content bounds", () => {
    const tiles = tilesFromImage(3, 2, solid(3, 2, [1, 2, 3, 255]), 300, -5);
    expect(contentBounds(tiles)).toEqual(rect(300, -5, 3, 2));
  });

  it("translates by integer offsets, with a tile-aligned fast path", () => {
    const tiles = tilesFromImage(1, 1, new Uint8ClampedArray([9, 9, 9, 255]), 5, 5);
    expect(getPixel(translateTiles(tiles, 3, -7), 8, -2)).toEqual([9, 9, 9, 255]);
    const moved = translateTiles(tiles, TILE_SIZE, 0);
    expect(getPixel(moved, 5 + TILE_SIZE, 5)).toEqual([9, 9, 9, 255]);
    expect([...moved.values()][0]).toBe([...tiles.values()][0]); // shared, not copied
  });
});
