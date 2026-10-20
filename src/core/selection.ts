import { EMPTY_RECT, apply, boundsOf, intersect, invert as invertMat, isEmpty, rect, roundOut, transformRect, type Mat, type Rect, type Vec2 } from "./geometry";
import { readRect, type TileMap } from "./tiles";

/**
 * A document-sized 8-bit selection mask (255 = fully selected), with the
 * tight bounds of its non-zero pixels cached for fast iteration.
 */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly bounds: Rect;
}

export type SelectionMode = "replace" | "add" | "subtract" | "intersect";

export function computeBounds(data: Uint8Array, width: number, height: number): Rect {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      maxY = y;
    }
  }
  return maxX < 0 ? EMPTY_RECT : rect(minX, minY, maxX - minX + 1, maxY - minY + 1);
}

/** Wraps raw data as a mask, or null if nothing is selected. */
export function toMask(data: Uint8Array, width: number, height: number): Mask | null {
  const bounds = computeBounds(data, width, height);
  return isEmpty(bounds) ? null : { width, height, data, bounds };
}

export const maskAt = (m: Mask | null, x: number, y: number) =>
  !m ? 255 : x < 0 || y < 0 || x >= m.width || y >= m.height ? 0 : m.data[y * m.width + x];

export function selectAll(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height).fill(255), bounds: rect(0, 0, width, height) };
}

/** Pixel-aligned rectangle (marquee selections snap to whole pixels). */
export function rectMask(width: number, height: number, r: Rect): Mask | null {
  const data = new Uint8Array(width * height);
  const b = intersect(roundOut(rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h))), rect(0, 0, width, height));
  for (let y = b.y; y < b.y + b.h; y++) data.fill(255, y * width + b.x, y * width + b.x + b.w);
  return toMask(data, width, height);
}

const SUB = 4; // supersampling factor per axis for antialiased shapes

/** Antialiased ellipse inscribed in `r`. */
export function ellipseMask(width: number, height: number, r: Rect): Mask | null {
  const data = new Uint8Array(width * height);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  if (rx <= 0 || ry <= 0) return null;
  const b = intersect(roundOut(r), rect(0, 0, width, height));
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      let hits = 0;
      for (let sy = 0; sy < SUB; sy++) {
        const dy = (y + (sy + 0.5) / SUB - cy) / ry;
        for (let sx = 0; sx < SUB; sx++) {
          const dx = (x + (sx + 0.5) / SUB - cx) / rx;
          if (dx * dx + dy * dy <= 1) hits++;
        }
      }
      data[y * width + x] = Math.round((hits * 255) / (SUB * SUB));
    }
  }
  return toMask(data, width, height);
}

/** Antialiased polygon (even-odd fill), using SUB×SUB coverage sampling. */
export function polygonMask(width: number, height: number, points: readonly Vec2[]): Mask | null {
  if (points.length < 3) return null;
  const data = new Uint8Array(width * height);
  const b = intersect(roundOut(boundsOf(points)), rect(0, 0, width, height));
  if (isEmpty(b)) return null;
  const coverage = new Float32Array(b.w);
  const xs: number[] = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    coverage.fill(0);
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const q = points[(i + 1) % points.length];
        if ((p.y <= sy) !== (q.y <= sy)) xs.push(p.x + ((sy - p.y) / (q.y - p.y)) * (q.x - p.x));
      }
      xs.sort((a, c) => a - c);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        // Accumulate horizontal span [x0, x1) with fractional coverage at the ends.
        const x0 = Math.max(b.x, xs[i]) - b.x;
        const x1 = Math.min(b.x + b.w, xs[i + 1]) - b.x;
        if (x1 <= x0) continue;
        const i0 = Math.floor(x0);
        const i1 = Math.floor(x1);
        if (i0 === i1) {
          coverage[i0] += x1 - x0;
          continue;
        }
        coverage[i0] += i0 + 1 - x0;
        for (let k = i0 + 1; k < i1; k++) coverage[k] += 1;
        if (i1 < b.w) coverage[i1] += x1 - i1;
      }
    }
    const row = y * width + b.x;
    for (let x = 0; x < b.w; x++) data[row + x] = Math.round(Math.min(1, coverage[x] / SUB) * 255);
  }
  return toMask(data, width, height);
}

export function combine(current: Mask | null, shape: Mask | null, mode: SelectionMode): Mask | null {
  if (mode === "replace") return shape;
  if (!current) return mode === "add" ? shape : null;
  if (!shape) return mode === "intersect" ? null : current;
  const { width, height } = current;
  const out = new Uint8Array(current.data);
  const a = current.data;
  const s = shape.data;
  const n = width * height;
  if (mode === "add") for (let i = 0; i < n; i++) out[i] = Math.max(a[i], s[i]);
  else if (mode === "subtract") for (let i = 0; i < n; i++) out[i] = (a[i] * (255 - s[i])) / 255;
  else for (let i = 0; i < n; i++) out[i] = (a[i] * s[i]) / 255;
  return toMask(out, width, height);
}

export function invertSelection(m: Mask | null, width: number, height: number): Mask | null {
  if (!m) return selectAll(width, height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = 255 - m.data[i];
  return toMask(out, width, height);
}

/**
 * Flood-selects pixels whose colour is within `tolerance` (0–255, per channel
 * max difference) of the seed pixel, like Photoshop's Magic Wand.
 */
export function magicWand(
  tiles: TileMap,
  width: number,
  height: number,
  seed: Vec2,
  tolerance: number,
  contiguous = true,
): Mask | null {
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const pixels = readRect(tiles, rect(0, 0, width, height));
  const s0 = (sy * width + sx) * 4;
  const [r0, g0, b0, a0] = pixels.subarray(s0, s0 + 4);
  const matches = (i: number) => {
    const j = i * 4;
    return (
      Math.abs(pixels[j + 3] - a0) <= tolerance &&
      (a0 === 0 && pixels[j + 3] === 0
        ? true
        : Math.abs(pixels[j] - r0) <= tolerance &&
          Math.abs(pixels[j + 1] - g0) <= tolerance &&
          Math.abs(pixels[j + 2] - b0) <= tolerance)
    );
  };
  const data = new Uint8Array(width * height);
  if (!contiguous) {
    for (let i = 0; i < data.length; i++) if (matches(i)) data[i] = 255;
    return toMask(data, width, height);
  }
  const stack = [sy * width + sx];
  data[stack[0]] = 255;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const visit = (j: number) => {
      if (data[j] === 0 && matches(j)) {
        data[j] = 255;
        stack.push(j);
      }
    };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < width * (height - 1)) visit(i + width);
  }
  return toMask(data, width, height);
}

/** Resamples the mask through an affine transform (bilinear). */
export function transformMask(m: Mask, mat: Mat): Mask | null {
  const { width, height } = m;
  const inv = invertMat(mat);
  const out = new Uint8Array(width * height);
  const b = intersect(roundOut(transformRect(mat, m.bounds)), rect(0, 0, width, height));
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      const p = apply(inv, { x: x + 0.5, y: y + 0.5 });
      const fx = p.x - 0.5;
      const fy = p.y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const v =
        maskAt(m, x0, y0) * (1 - tx) * (1 - ty) +
        maskAt(m, x0 + 1, y0) * tx * (1 - ty) +
        maskAt(m, x0, y0 + 1) * (1 - tx) * ty +
        maskAt(m, x0 + 1, y0 + 1) * tx * ty;
      out[y * width + x] = Math.round(v);
    }
  }
  return toMask(out, width, height);
}

/** Selection mode implied by modifier keys, Photoshop-style. */
export function modeFromModifiers(base: SelectionMode, shift: boolean, alt: boolean): SelectionMode {
  if (shift && alt) return "intersect";
  if (shift) return "add";
  if (alt) return "subtract";
  return base;
}
