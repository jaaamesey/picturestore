import type { RGB } from "./color";
import { EMPTY_RECT, intersect, isEmpty, rect, roundOut, union, type Rect } from "./geometry";
import type { Mask } from "./selection";
import { TILE_SIZE, tileKey, tileRect, tileWriter, tilesIn, type TileKey, type TileMap } from "./tiles";

export interface BrushSettings {
  /** Diameter in pixels. */
  readonly size: number;
  /** [0, 1]: 1 = hard edge, 0 = soft falloff from the centre. */
  readonly hardness: number;
  /** [0, 1]: the most a single stroke can contribute. */
  readonly opacity: number;
  /** [0, 1]: per-dab contribution, building up towards `opacity`. */
  readonly flow: number;
  /** Dab spacing as a fraction of the diameter. */
  readonly spacing: number;
  /** Scale size with pen pressure. */
  readonly pressureSize: boolean;
}

export const DEFAULT_BRUSH: BrushSettings = {
  size: 20,
  hardness: 0.8,
  opacity: 1,
  flow: 1,
  spacing: 0.15,
  pressureSize: true,
};

export interface StrokePoint {
  readonly x: number;
  readonly y: number;
  /** [0, 1] */
  readonly pressure: number;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Dab coverage at distance `d` from the centre of a dab with the given radius. */
export function dabAlpha(d: number, radius: number, hardness: number): number {
  if (radius <= 0.5) return Math.max(0, 1 - d); // single-pixel brushes
  // Antialiased edge, one pixel wide.
  const edge = Math.min(1, Math.max(0, radius - d + 0.5));
  if (hardness >= 1) return edge;
  const inner = radius * hardness;
  return edge * (1 - smoothstep(inner, radius, d));
}

/**
 * Turns a stream of input points into evenly spaced dab positions, carrying
 * leftover distance across segments so spacing is independent of event rate.
 */
export function createInterpolator(spacingAt: (p: StrokePoint) => number) {
  let last: StrokePoint | null = null;
  let travelled = 0; // distance covered since the most recent dab
  const lerp = (a: StrokePoint, b: StrokePoint, f: number): StrokePoint => ({
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    pressure: a.pressure + (b.pressure - a.pressure) * f,
  });
  return (p: StrokePoint): StrokePoint[] => {
    const from = last;
    last = p;
    if (!from) return [p];
    const seg = Math.hypot(p.x - from.x, p.y - from.y);
    if (seg === 0) return [];
    const dabs: StrokePoint[] = [];
    let pos = 0;
    for (;;) {
      const next = pos + Math.max(0.5, spacingAt(lerp(from, p, pos / seg))) - travelled;
      if (next > seg) break;
      pos = next;
      travelled = 0;
      dabs.push(lerp(from, p, pos / seg));
    }
    travelled += seg - pos;
    return dabs;
  };
}

export interface StrokeOptions {
  readonly brush: BrushSettings;
  readonly color: RGB;
  readonly erase: boolean;
  readonly selection: Mask | null;
  /** Painting is clipped to these bounds (the canvas). */
  readonly clip: Rect;
}

export interface Stroke {
  /** Live working tiles; safe to read for preview while the stroke continues. */
  readonly tiles: TileMap;
  /** Adds a point; returns the area that changed. */
  add(p: StrokePoint): Rect;
  finish(): TileMap;
}

const LUT_SIZE = 4096;
const lutCache = new Map<number, Float32Array>();

/**
 * Soft falloff 1 − smoothstep(hardness, 1, t) sampled over t² ∈ [0, 1], so a
 * dab needs no square root in its interior. Independent of radius; one table
 * per hardness (quantised to 1/256).
 */
function falloffTable(hardness: number): Float32Array {
  const key = Math.round(hardness * 256);
  let lut = lutCache.get(key);
  if (lut) return lut;
  lut = new Float32Array(LUT_SIZE + 2);
  const h = key / 256;
  for (let i = 0; i <= LUT_SIZE + 1; i++) {
    const t = Math.sqrt(Math.min(1, i / LUT_SIZE));
    lut[i] = h >= 1 ? 1 : 1 - smoothstep(h, 1, t);
  }
  lutCache.set(key, lut);
  return lut;
}

/**
 * A paint or erase stroke over `base`.
 *
 * Each pixel tracks how much paint the stroke has deposited (built up by
 * `flow` per dab, capped at 1). The output is always recomputed from the
 * untouched `base` pixel, so overlapping dabs never exceed the stroke's
 * `opacity` — the same model Photoshop uses.
 */
export function beginStroke(base: TileMap, opts: StrokeOptions): Stroke {
  const { brush, color, erase, selection, clip } = opts;
  const { flow, opacity } = brush;
  const { r: cr, g: cg, b: cb } = color;
  const writer = tileWriter(base);
  const deposit = new Map<TileKey, Float32Array>();
  const lut = falloffTable(brush.hardness);
  const radiusAt = (p: StrokePoint) => Math.max(0.5, (brush.size / 2) * (brush.pressureSize ? p.pressure : 1));
  const interpolate = createInterpolator((p) => Math.max(1, radiusAt(p) * 2 * brush.spacing));
  const sel = selection;

  const dab = (p: StrokePoint): Rect => {
    const R = radiusAt(p);
    const outer = R + 0.5;
    const area = intersect(roundOut(rect(p.x - outer, p.y - outer, outer * 2, outer * 2)), clip);
    const region = sel ? intersect(area, sel.bounds) : area;
    if (isEmpty(region)) return EMPTY_RECT;
    const outer2 = outer * outer;
    const inner = Math.max(0, R - 0.5);
    const inner2 = inner * inner; // inside this, the antialiased edge is fully on
    const lutScale = LUT_SIZE / (R * R);
    const pixelBrush = R <= 0.5;

    for (const [tx, ty] of tilesIn(region)) {
      const key = tileKey(tx, ty);
      const part = intersect(region, tileRect(tx, ty));
      const src = base.get(key)?.data;
      if (erase && !src) continue;
      let dep = deposit.get(key);
      if (!dep) deposit.set(key, (dep = new Float32Array(TILE_SIZE * TILE_SIZE)));
      const out = writer.writable(tx, ty);
      out.version++;
      const o = out.data;
      const ox = tx * TILE_SIZE;
      const oy = ty * TILE_SIZE;

      for (let y = part.y; y < part.y + part.h; y++) {
        const dy = y + 0.5 - p.y;
        const dy2 = dy * dy;
        if (dy2 >= outer2) continue;
        // Only the span of this row that lies within the dab's outer radius.
        const half = Math.sqrt(outer2 - dy2);
        const x0 = Math.max(part.x, Math.ceil(p.x - half - 0.5));
        const x1 = Math.min(part.x + part.w - 1, Math.floor(p.x + half - 0.5));
        if (x1 < x0) continue;
        const mrow = sel ? (y - sel.bounds.y) * sel.bounds.w - sel.bounds.x : 0;
        let dx = x0 + 0.5 - p.x;
        let d2 = dx * dx + dy2;
        let pi = (y - oy) * TILE_SIZE + (x0 - ox);
        for (let x = x0; x <= x1; x++, pi++, d2 += 2 * dx + 1, dx += 1) {
          if (d2 >= outer2) continue;
          const q = d2 * lutScale;
          let a: number;
          // Past t = 1 the falloff holds its end value (1 for hard brushes, whose rim extends half a pixel further).
          if (q >= LUT_SIZE) a = lut[LUT_SIZE];
          else {
            const qi = q | 0;
            a = lut[qi] + (lut[qi + 1] - lut[qi]) * (q - qi);
          }
          if (d2 > inner2) a *= Math.min(1, outer - Math.sqrt(d2)); // 1px antialiased rim
          if (pixelBrush) a = Math.max(0, 1 - Math.sqrt(d2));
          if (a <= 0) continue;
          const m = dep[pi] + (1 - dep[pi]) * a * flow;
          dep[pi] = m;
          let eff = m * opacity;
          if (sel) eff *= sel.data[mrow + x] * INV255;
          const i = pi * 4;
          const ba = src ? src[i + 3] * INV255 : 0;
          if (erase) {
            o[i + 3] = ba * (1 - eff) * 255;
            continue;
          }
          const oa = eff + ba * (1 - eff);
          if (oa <= 0) continue;
          const keep = (ba * (1 - eff)) / oa;
          const add = eff / oa;
          if (src) {
            o[i] = cr * add + src[i] * keep;
            o[i + 1] = cg * add + src[i + 1] * keep;
            o[i + 2] = cb * add + src[i + 2] * keep;
          } else {
            o[i] = cr;
            o[i + 1] = cg;
            o[i + 2] = cb;
          }
          o[i + 3] = oa * 255;
        }
      }
    }
    return region;
  };

  return {
    tiles: writer.tiles,
    add(p) {
      let dirty = EMPTY_RECT;
      for (const d of interpolate(p)) dirty = union(dirty, dab(d));
      return dirty;
    },
    finish: () => writer.finish(),
  };
}

const INV255 = 1 / 255;
