import type { RGB } from "./color";
import { EMPTY_RECT, intersect, isEmpty, rect, roundOut, union, type Rect } from "./geometry";
import { maskAt, type Mask } from "./selection";
import { TILE_SIZE, tileKey, tileRect, tileWriter, tilesIn, type TileMap } from "./tiles";

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
  const writer = tileWriter(base);
  const deposit = new Map<string, Float32Array>();
  const radiusAt = (p: StrokePoint) => Math.max(0.5, (brush.size / 2) * (brush.pressureSize ? p.pressure : 1));
  const interpolate = createInterpolator((p) => Math.max(1, radiusAt(p) * 2 * brush.spacing));

  const dab = (p: StrokePoint): Rect => {
    const radius = radiusAt(p);
    const area = intersect(roundOut(rect(p.x - radius - 1, p.y - radius - 1, radius * 2 + 2, radius * 2 + 2)), clip);
    const region = selection ? intersect(area, selection.bounds) : area;
    if (isEmpty(region)) return EMPTY_RECT;
    for (const [tx, ty] of tilesIn(region)) {
      const key = tileKey(tx, ty);
      const part = intersect(region, tileRect(tx, ty));
      let dep = deposit.get(key);
      if (!dep) deposit.set(key, (dep = new Float32Array(TILE_SIZE * TILE_SIZE)));
      const src = base.get(key)?.data;
      if (erase && !src) continue;
      const out = writer.writable(tx, ty);
      out.version++;
      const ox = tx * TILE_SIZE;
      const oy = ty * TILE_SIZE;
      for (let y = part.y; y < part.y + part.h; y++) {
        for (let x = part.x; x < part.x + part.w; x++) {
          const a = dabAlpha(Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y), radius, brush.hardness);
          if (a <= 0) continue;
          const pi = (y - oy) * TILE_SIZE + (x - ox);
          const m = dep[pi] + (1 - dep[pi]) * a * brush.flow;
          dep[pi] = m;
          const eff = m * brush.opacity * (maskAt(selection, x, y) / 255);
          const i = pi * 4;
          const ba = src ? src[i + 3] / 255 : 0;
          if (erase) {
            out.data[i + 3] = ba * (1 - eff) * 255;
            continue;
          }
          const oa = eff + ba * (1 - eff);
          if (oa <= 0) continue;
          const keep = (ba * (1 - eff)) / oa;
          const add = eff / oa;
          out.data[i] = color.r * add + (src ? src[i] : 0) * keep;
          out.data[i + 1] = color.g * add + (src ? src[i + 1] : 0) * keep;
          out.data[i + 2] = color.b * add + (src ? src[i + 2] : 0) * keep;
          out.data[i + 3] = oa * 255;
        }
      }
    }
    return region;
  };

  return {
    tiles: writer.tiles,
    add: (p) => interpolate(p).reduce((dirty, d) => union(dirty, dab(d)), EMPTY_RECT),
    finish: () => writer.finish(),
  };
}
