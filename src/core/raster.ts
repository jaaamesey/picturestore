import { intersect, isEmpty, roundOut, type Rect } from "./geometry";
import { rasterizeMapping, type Filter } from "./rasterize";
import type { Mask } from "./selection";
import { maskPixels } from "./document";
import { NO_PIXELS, combinePixels, contentBounds, readRect, pixelsFromImage, type Pixels } from "./pixels";
import { mappingBounds, type Mapping } from "./warp";

/** Pixels lifted off a layer, e.g. for moving or transforming a selection. */
export interface Floating {
  readonly pixels: Pixels;
  /** Tight bounds of the pixels' content. */
  readonly bounds: Rect;
}

/**
 * Splits a layer into the part covered by `mask` (scaled by mask coverage) and
 * the remainder. With no mask the whole layer floats.
 */
export function extractFloating(pixels: Pixels, mask: Mask | null): { floating: Floating; rest: Pixels } {
  if (!mask) return { floating: { pixels, bounds: contentBounds(pixels) }, rest: NO_PIXELS };
  const lifted = maskPixels(pixels, mask, "inside");
  return { floating: { pixels: lifted, bounds: contentBounds(lifted) }, rest: maskPixels(pixels, mask, "outside") };
}


/**
 * CPU reference for transforming floating pixels through a mapping. The editor
 * renders this on the GPU (see `gpu/renderer.ts`); unit tests and the GPU
 * parity test use this.
 */
export function transformFloatingCpu(f: Floating, m: Mapping, filter: Filter = "bicubic", clip?: Rect): Pixels {
  if (isEmpty(f.bounds)) return NO_PIXELS;
  const bounds = roundOut(mappingBounds(m));
  const dest = clip ? intersect(bounds, clip) : bounds;
  if (isEmpty(dest)) return NO_PIXELS;
  const src = { width: f.bounds.w, height: f.bounds.h, channels: 4 as const, data: readRect(f.pixels, f.bounds) };
  const out = rasterizeMapping(src, f.bounds, m, dest, filter);
  return pixelsFromImage(dest.w, dest.h, out.data, dest.x, dest.y);
}

/** Normal-mode "over" of `top` onto `base`, both straight RGBA. */
export function compositeOver(base: Pixels, top: Pixels): Pixels {
  return combinePixels(base, top, (d, s) => {
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
  });
}
