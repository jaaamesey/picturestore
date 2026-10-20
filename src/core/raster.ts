import { apply, integerTranslation, intersect, invert, isEmpty, roundOut, transformRect, type Mat, type Rect } from "./geometry";
import type { Mask } from "./selection";
import {
  EMPTY_TILES,
  TILE_SIZE,
  contentBounds,
  parseTileKey,
  readRect,
  tileRect,
  tileWriter,
  tilesIn,
  translateTiles,
  type TileMap,
} from "./tiles";

/** Pixels lifted off a layer, e.g. for moving or transforming a selection. */
export interface Floating {
  readonly tiles: TileMap;
  /** Tight bounds of `tiles`' content. */
  readonly bounds: Rect;
}

/**
 * Splits a layer into the part covered by `mask` (scaled by mask coverage) and
 * the remainder. With no mask the whole layer floats.
 */
export function extractFloating(tiles: TileMap, mask: Mask | null): { floating: Floating; rest: TileMap } {
  if (!mask) return { floating: { tiles, bounds: contentBounds(tiles) }, rest: EMPTY_TILES };
  const lifted = tileWriter(EMPTY_TILES);
  const rest = tileWriter(tiles);
  for (const [tx, ty] of tilesIn(mask.bounds)) {
    const src = tiles.get(`${tx},${ty}`);
    if (!src) continue;
    const part = intersect(mask.bounds, tileRect(tx, ty));
    const f = lifted.writable(tx, ty);
    const r = rest.writable(tx, ty);
    for (let y = part.y; y < part.y + part.h; y++) {
      for (let x = part.x; x < part.x + part.w; x++) {
        const m = mask.data[y * mask.width + x] / 255;
        if (m === 0) continue;
        const i = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4;
        f.data.set(src.data.subarray(i, i + 3), i);
        f.data[i + 3] = src.data[i + 3] * m;
        r.data[i + 3] = src.data[i + 3] * (1 - m);
      }
    }
  }
  const floatingTiles = lifted.finish();
  return { floating: { tiles: floatingTiles, bounds: contentBounds(floatingTiles) }, rest: rest.finish() };
}

/**
 * Resamples floating pixels through `m` with bilinear filtering in
 * premultiplied space (so transparent edges don't darken).
 */
export function transformTiles(f: Floating, m: Mat): TileMap {
  if (isEmpty(f.bounds)) return EMPTY_TILES;
  const shift = integerTranslation(m);
  if (shift) return translateTiles(f.tiles, shift.x, shift.y);

  const src = readRect(f.tiles, f.bounds);
  const sw = f.bounds.w;
  const sh = f.bounds.h;
  const inv = invert(m);
  const dest = roundOut(transformRect(m, f.bounds));
  const out = tileWriter(EMPTY_TILES);
  const tap = (x: number, y: number) => (x < 0 || y < 0 || x >= sw || y >= sh ? -1 : (y * sw + x) * 4);

  for (const [tx, ty] of tilesIn(dest)) {
    const part = intersect(dest, tileRect(tx, ty));
    const t = out.writable(tx, ty);
    for (let y = part.y; y < part.y + part.h; y++) {
      for (let x = part.x; x < part.x + part.w; x++) {
        const p = apply(inv, { x: x + 0.5, y: y + 0.5 });
        const fx = p.x - 0.5 - f.bounds.x;
        const fy = p.y - 0.5 - f.bounds.y;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) continue;
        const ax = fx - x0;
        const ay = fy - y0;
        let r = 0, g = 0, b = 0, a = 0;
        const taps = [
          [tap(x0, y0), (1 - ax) * (1 - ay)],
          [tap(x0 + 1, y0), ax * (1 - ay)],
          [tap(x0, y0 + 1), (1 - ax) * ay],
          [tap(x0 + 1, y0 + 1), ax * ay],
        ] as const;
        for (const [i, w] of taps) {
          if (i < 0 || w === 0) continue;
          const wa = w * src[i + 3];
          r += src[i] * wa;
          g += src[i + 1] * wa;
          b += src[i + 2] * wa;
          a += wa;
        }
        if (a <= 0) continue;
        const i = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4;
        t.data[i] = r / a;
        t.data[i + 1] = g / a;
        t.data[i + 2] = b / a;
        t.data[i + 3] = a;
      }
    }
  }
  return out.finish();
}

/** Normal-mode "over" of `top` onto `base`, both straight RGBA. */
export function compositeOver(base: TileMap, top: TileMap): TileMap {
  if (base.size === 0) return top;
  const out = tileWriter(base);
  for (const [key, t] of top) {
    const existing = base.get(key);
    if (!existing) {
      out.tiles.set(key, t);
      continue;
    }
    const [tx, ty] = parseTileKey(key);
    const d = out.writable(tx, ty).data;
    const s = t.data;
    for (let i = 0; i < s.length; i += 4) {
      const sa = s[i + 3] / 255;
      if (sa === 0) continue;
      const da = d[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      const k = (da * (1 - sa)) / oa;
      d[i] = s[i] * (sa / oa) + d[i] * k;
      d[i + 1] = s[i + 1] * (sa / oa) + d[i + 1] * k;
      d[i + 2] = s[i + 2] * (sa / oa) + d[i + 2] * k;
      d[i + 3] = oa * 255;
    }
  }
  return out.finish();
}
