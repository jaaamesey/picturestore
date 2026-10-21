import { intersect, isEmpty, rect, roundOut, union, vec, type Rect, type Vec2 } from "./geometry";
import { rasterizeContours } from "./coverage";
import { rasterizeMapping } from "./rasterize";
import { pixelReader, type Pixels } from "./pixels";
import { mappingBounds, type Mapping } from "./warp";

/**
 * An 8-bit selection mask (255 = fully selected) for a document of
 * `width × height`. Only the tight `bounds` of the non-zero pixels are stored
 * (`data` is `bounds.w × bounds.h`), so history snapshots of small selections
 * on large documents stay small.
 */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly bounds: Rect;
  readonly data: Uint8Array;
}

export type SelectionMode = "replace" | "add" | "subtract" | "intersect";

/** Exact for 0 ≤ x ≤ 255², i.e. products of two bytes: round(x / 255). */
const div255 = (x: number) => (x + 128 + ((x + 128) >> 8)) >> 8;

export const maskAt = (m: Mask | null, x: number, y: number) => {
  if (!m) return 255;
  const { bounds: b } = m;
  const lx = x - b.x, ly = y - b.y;
  return lx < 0 || ly < 0 || lx >= b.w || ly >= b.h ? 0 : m.data[ly * b.w + lx];
};

/**
 * Wraps `data` covering `region` as a mask, cropping to the tight bounds of
 * its non-zero pixels. Null if nothing is selected.
 */
export function toMask(data: Uint8Array, region: Rect, width: number, height: number): Mask | null {
  let minX = region.w, minY = region.h, maxX = -1, maxY = -1;
  for (let y = 0; y < region.h; y++) {
    const row = y * region.w;
    let x = 0;
    while (x < region.w && data[row + x] === 0) x++;
    if (x === region.w) continue;
    let x1 = region.w - 1;
    while (data[row + x1] === 0) x1--;
    if (x < minX) minX = x;
    if (x1 > maxX) maxX = x1;
    if (y < minY) minY = y;
    maxY = y;
  }
  if (maxX < 0) return null;
  const bounds = rect(region.x + minX, region.y + minY, maxX - minX + 1, maxY - minY + 1);
  if (bounds.w === region.w && bounds.h === region.h) return { width, height, bounds, data };
  const out = new Uint8Array(bounds.w * bounds.h);
  for (let y = 0; y < bounds.h; y++) {
    const src = (y + minY) * region.w + minX;
    out.set(data.subarray(src, src + bounds.w), y * bounds.w);
  }
  return { width, height, bounds, data: out };
}

const docRect = (w: number, h: number) => rect(0, 0, w, h);

export function selectAll(width: number, height: number): Mask {
  return { width, height, bounds: docRect(width, height), data: new Uint8Array(width * height).fill(255) };
}

/** Pixel-aligned rectangle (marquee selections snap to whole pixels). */
export function rectMask(width: number, height: number, r: Rect): Mask | null {
  const b = intersect(rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)), docRect(width, height));
  return isEmpty(b) ? null : { width, height, bounds: b, data: new Uint8Array(b.w * b.h).fill(255) };
}

/** Exact-area antialiased polygon selection (non-zero winding); see {@link rasterizeContours}. */
export function polygonMask(width: number, height: number, points: readonly Vec2[]): Mask | null {
  const c = rasterizeContours([points], docRect(width, height));
  return c && toMask(c.data, c.region, width, height);
}

/** Antialiased ellipse inscribed in `r`, flattened finely enough that the error stays below 1/20 px. */
export function ellipseMask(width: number, height: number, r: Rect): Mask | null {
  const rx = r.w / 2, ry = r.h / 2;
  if (rx <= 0 || ry <= 0) return null;
  const cx = r.x + rx, cy = r.y + ry;
  // Chord sagitta R(1 − cos(π/n)) ≤ ε  ⇒  n ≥ π / acos(1 − ε/R).
  const R = Math.max(rx, ry);
  const n = Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.05 / R))));
  // An inscribed polygon under-covers; scale it so its area equals the ellipse's (πab).
  const k = Math.sqrt((2 * Math.PI) / (n * Math.sin((2 * Math.PI) / n)));
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return vec(cx + k * rx * Math.cos(a), cy + k * ry * Math.sin(a));
  });
  return polygonMask(width, height, pts);
}

/** Copies a mask's coverage of `region` into a region-sized buffer (row memcpy; zero elsewhere). */
function blit(m: Mask, region: Rect): Uint8Array {
  const out = new Uint8Array(region.w * region.h);
  const part = intersect(m.bounds, region);
  for (let y = part.y; y < part.y + part.h; y++) {
    const src = (y - m.bounds.y) * m.bounds.w + (part.x - m.bounds.x);
    out.set(m.data.subarray(src, src + part.w), (y - region.y) * region.w + (part.x - region.x));
  }
  return out;
}

export function combine(current: Mask | null, shape: Mask | null, mode: SelectionMode): Mask | null {
  if (mode === "replace") return shape;
  if (!current) return mode === "add" ? shape : null;
  if (!shape) return mode === "intersect" ? null : current;
  const { width, height } = current;
  const region =
    mode === "add" ? union(current.bounds, shape.bounds)
    : mode === "subtract" ? current.bounds
    : intersect(current.bounds, shape.bounds);
  if (isEmpty(region)) return null;
  const a = blit(current, region);
  const b = blit(shape, region);
  const n = a.length;
  if (mode === "add") for (let i = 0; i < n; i++) a[i] = a[i] > b[i] ? a[i] : b[i];
  else if (mode === "subtract") for (let i = 0; i < n; i++) a[i] = div255(a[i] * (255 - b[i]));
  else for (let i = 0; i < n; i++) a[i] = div255(a[i] * b[i]);
  return toMask(a, region, width, height);
}

export function invertSelection(m: Mask | null, width: number, height: number): Mask | null {
  if (!m) return selectAll(width, height);
  const region = docRect(width, height);
  const out = blit(m, region);
  for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
  return toMask(out, region, width, height);
}

/**
 * Magic Wand: selects pixels whose channels are all within `tolerance` of the
 * seed pixel. Contiguous mode is a scanline span fill (each pixel is tested
 * and written once per span, not pushed per pixel), reading pixels directly.
 */
export function magicWand(
  pixels: Pixels,
  width: number,
  height: number,
  seed: Vec2,
  tolerance: number,
  contiguous = true,
): Mask | null {
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;

  // Packed RGBA, little-endian: red in the low byte, alpha in the high one.
  const pixel = pixelReader(pixels);
  const s0 = pixel(sx, sy);
  const r0 = s0 & 255, g0 = (s0 >>> 8) & 255, b0 = (s0 >>> 16) & 255, a0 = s0 >>> 24;
  const matches = (x: number, y: number) => {
    const p = pixel(x, y);
    const a = p >>> 24;
    if (Math.abs(a - a0) > tolerance) return false;
    if (a0 === 0 && a === 0) return true;
    return Math.abs((p & 255) - r0) <= tolerance && Math.abs(((p >>> 8) & 255) - g0) <= tolerance && Math.abs(((p >>> 16) & 255) - b0) <= tolerance;
  };

  const data = new Uint8Array(width * height);
  const region = docRect(width, height);
  if (!contiguous) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (matches(x, y)) data[y * width + x] = 255;
    return toMask(data, region, width, height);
  }

  let stack = new Int32Array(1024);
  let top = 0;
  const push = (x: number, y: number) => {
    if (top + 2 > stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[top++] = x;
    stack[top++] = y;
  };
  /** Pushes one seed per run of fillable pixels on row `y` within [x0, x1]. */
  const scanRow = (x0: number, x1: number, y: number) => {
    let inRun = false;
    for (let x = x0; x <= x1; x++) {
      const fillable = data[y * width + x] === 0 && matches(x, y);
      if (fillable && !inRun) push(x, y);
      inRun = fillable;
    }
  };

  push(sx, sy);
  while (top > 0) {
    const y = stack[--top];
    const x = stack[--top];
    const row = y * width;
    if (data[row + x]) continue;
    let left = x;
    while (left > 0 && !data[row + left - 1] && matches(left - 1, y)) left--;
    let right = x;
    while (right < width - 1 && !data[row + right + 1] && matches(right + 1, y)) right++;
    data.fill(255, row + left, row + right + 1);
    if (y > 0) scanRow(left, right, y - 1);
    if (y < height - 1) scanRow(left, right, y + 1);
  }
  return toMask(data, region, width, height);
}

/** Transforms a selection mask through a mapping (bilinear, mip-prefiltered when shrinking). */
export function transformMask(m: Mask, mapping: Mapping): Mask | null {
  const dest = intersect(roundOut(mappingBounds(mapping)), docRect(m.width, m.height));
  if (isEmpty(dest)) return null;
  const out = rasterizeMapping({ width: m.bounds.w, height: m.bounds.h, channels: 1, data: m.data }, m.bounds, mapping, dest, "bilinear");
  return toMask(new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.length), dest, m.width, m.height);
}

/** Selection mode implied by modifier keys, Photoshop-style. */
export function modeFromModifiers(base: SelectionMode, shift: boolean, alt: boolean): SelectionMode {
  if (shift && alt) return "intersect";
  if (shift) return "add";
  if (alt) return "subtract";
  return base;
}


/** Shifts a mask by whole pixels (exact), clipping to the document. */
export function translateMask(m: Mask, dx: number, dy: number): Mask | null {
  const b = m.bounds;
  const moved = rect(b.x + dx, b.y + dy, b.w, b.h);
  const clipped = intersect(moved, docRect(m.width, m.height));
  if (isEmpty(clipped)) return null;
  if (clipped.w === b.w && clipped.h === b.h) return { ...m, bounds: moved };
  const out = new Uint8Array(clipped.w * clipped.h);
  for (let y = 0; y < clipped.h; y++) {
    const src = (clipped.y - moved.y + y) * b.w + (clipped.x - moved.x);
    out.set(m.data.subarray(src, src + clipped.w), y * clipped.w);
  }
  return toMask(out, clipped, m.width, m.height);
}
