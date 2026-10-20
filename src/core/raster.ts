import { intersect, isEmpty, roundOut, type Rect } from "./geometry";
import { rasterizeMapping, type Filter } from "./rasterize";
import type { Mask } from "./selection";
import { EMPTY_TILES, TILE_SIZE, contentBounds, keyX, keyY, readRect, tileKey, tileRect, tileWriter, tilesIn, tilesFromImage, type TileMap } from "./tiles";
import { mappingBounds, type Mapping } from "./warp";

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
  const b = mask.bounds;
  for (const [tx, ty] of tilesIn(b)) {
    const src = tiles.get(tileKey(tx, ty));
    if (!src) continue;
    const part = intersect(b, tileRect(tx, ty));
    const f = lifted.writable(tx, ty).data;
    const r = rest.writable(tx, ty).data;
    const s = src.data;
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    for (let y = part.y; y < part.y + part.h; y++) {
      const mrow = (y - b.y) * b.w - b.x;
      let i = ((y - oy) * TILE_SIZE + (part.x - ox)) * 4;
      for (let x = part.x; x < part.x + part.w; x++, i += 4) {
        const m = mask.data[mrow + x];
        if (m === 0 || s[i + 3] === 0) continue;
        f[i] = s[i];
        f[i + 1] = s[i + 1];
        f[i + 2] = s[i + 2];
        f[i + 3] = (s[i + 3] * m) / 255;
        r[i + 3] = (s[i + 3] * (255 - m)) / 255;
      }
    }
  }
  const floatingTiles = lifted.finish();
  return { floating: { tiles: floatingTiles, bounds: contentBounds(floatingTiles) }, rest: rest.finish() };
}


/**
 * CPU reference for transforming floating pixels through a mapping. The editor
 * renders this on the GPU (see `gpu/renderer.ts`); unit tests and the GPU
 * parity test use this.
 */
export function transformFloatingCpu(f: Floating, m: Mapping, filter: Filter = "bicubic"): TileMap {
  if (isEmpty(f.bounds)) return EMPTY_TILES;
  const dest = roundOut(mappingBounds(m));
  if (isEmpty(dest)) return EMPTY_TILES;
  const src = { width: f.bounds.w, height: f.bounds.h, channels: 4 as const, data: readRect(f.tiles, f.bounds) };
  const out = rasterizeMapping(src, f.bounds, m, dest, filter);
  return tilesFromImage(dest.w, dest.h, out.data, dest.x, dest.y);
}

/** Normal-mode "over" of `top` onto `base`, both straight RGBA. */
export function compositeOver(base: TileMap, top: TileMap): TileMap {
  if (base.size === 0) return top;
  const out = tileWriter(base);
  for (const [key, t] of top) {
    const tx = keyX(key), ty = keyY(key);
    if (!base.has(key)) {
      out.put(tx, ty, t);
      continue;
    }
    const d = out.writable(tx, ty).data;
    const s = t.data;
    for (let i = 0; i < s.length; i += 4) {
      const sa = s[i + 3];
      if (sa === 0) continue;
      if (sa === 255) {
        d[i] = s[i];
        d[i + 1] = s[i + 1];
        d[i + 2] = s[i + 2];
        d[i + 3] = 255;
        continue;
      }
      const a = sa / 255;
      const da = d[i + 3] / 255;
      const oa = a + da * (1 - a);
      const k = (da * (1 - a)) / oa;
      d[i] = s[i] * (a / oa) + d[i] * k;
      d[i + 1] = s[i + 1] * (a / oa) + d[i + 1] * k;
      d[i + 2] = s[i + 2] * (a / oa) + d[i + 2] * k;
      d[i + 3] = oa * 255;
    }
  }
  return out.finish();
}
