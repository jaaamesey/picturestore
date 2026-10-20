import { isEmpty, type Rect } from "./geometry";
import { tessellate, type Mapping } from "./warp";

/**
 * CPU rasterization of a {@link Mapping}: the reference implementation for the
 * GPU transform path, and the production path for 1-channel selection masks.
 *
 * - Triangles are scan-converted with edge functions over their bounding box
 *   (clipped to the destination); attributes are interpolated
 *   perspective-correctly (u/w, v/w, 1/w), so homographies are exact.
 * - Each pixel picks its mip level from the analytic derivatives of the
 *   source coordinates — the per-pixel LOD a GPU computes — so strongly
 *   foreshortened regions are prefiltered while magnified ones stay sharp.
 * - RGBA is filtered in premultiplied space.
 */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly data: Uint8ClampedArray | Uint8Array;
}

export type Filter = "nearest" | "bilinear" | "bicubic";

/** Keys cubic (a = −0.5, Catmull–Rom), as used by Photoshop's "Bicubic". */
function cubic(t: number): number {
  const x = Math.abs(t);
  if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
  if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
  return 0;
}

/** Half-resolution 2×2 box filter (alpha-weighted for RGBA). Odd edges clamp. */
export function downsample(src: Raster): Raster {
  const { width: sw, height: sh, channels } = src;
  const w = Math.max(1, Math.ceil(sw / 2));
  const h = Math.max(1, Math.ceil(sh / 2));
  const out = new Uint8ClampedArray(w * h * channels);
  const s = src.data;
  for (let y = 0; y < h; y++) {
    const y0 = 2 * y;
    const y1 = Math.min(sh - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = 2 * x;
      const x1 = Math.min(sw - 1, x0 + 1);
      const i00 = (y0 * sw + x0) * channels;
      const i10 = (y0 * sw + x1) * channels;
      const i01 = (y1 * sw + x0) * channels;
      const i11 = (y1 * sw + x1) * channels;
      const o = (y * w + x) * channels;
      if (channels === 1) {
        out[o] = (s[i00] + s[i10] + s[i01] + s[i11] + 2) >> 2;
        continue;
      }
      const a00 = s[i00 + 3], a10 = s[i10 + 3], a01 = s[i01 + 3], a11 = s[i11 + 3];
      const a = a00 + a10 + a01 + a11;
      if (a === 0) continue;
      out[o] = (s[i00] * a00 + s[i10] * a10 + s[i01] * a01 + s[i11] * a11) / a;
      out[o + 1] = (s[i00 + 1] * a00 + s[i10 + 1] * a10 + s[i01 + 1] * a01 + s[i11 + 1] * a11) / a;
      out[o + 2] = (s[i00 + 2] * a00 + s[i10 + 2] * a10 + s[i01 + 2] * a01 + s[i11 + 2] * a11) / a;
      out[o + 3] = a / 4;
    }
  }
  return { width: w, height: h, channels, data: out };
}

// Scratch weights, reused to keep the inner loop allocation-free.
const wx = new Float64Array(4);
const wy = new Float64Array(4);

/** Weighted sum over an n×n tap grid starting at (x0, y0); taps outside the source are transparent. */
function accumulate(
  s: Uint8ClampedArray | Uint8Array, w: number, h: number, channels: number,
  x0: number, y0: number, n: number, out: Uint8ClampedArray, o: number,
) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < n; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= h) continue;
    const wj = wy[j];
    if (wj === 0) continue;
    const row = yy * w;
    for (let i = 0; i < n; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= w) continue;
      const wt = wx[i] * wj;
      if (wt === 0) continue;
      const k = (row + xx) * channels;
      if (channels === 1) {
        a += s[k] * wt;
        continue;
      }
      const wa = wt * s[k + 3];
      r += s[k] * wa;
      g += s[k + 1] * wa;
      b += s[k + 2] * wa;
      a += wa;
    }
  }
  if (channels === 1) {
    out[o] = a;
    return;
  }
  if (a <= 0.5) return;
  // Cubic overshoot can push premultiplied colour above alpha; clamp after un-premultiplying.
  out[o] = r / a;
  out[o + 1] = g / a;
  out[o + 2] = b / a;
  out[o + 3] = a;
}


type Interp = { a: number; b: number; c: number };

/**
 * Renders `src` (occupying `srcRect` in document space) through `m` into the
 * document-space rectangle `dest`.
 */
export function rasterizeMapping(src: Raster, srcRect: Rect, m: Mapping, dest: Rect, filter: Filter): Raster {
  const channels = src.channels;
  const out = new Uint8ClampedArray(dest.w * dest.h * channels);
  const result = { width: dest.w, height: dest.h, channels, data: out };
  if (isEmpty(dest) || isEmpty(srcRect)) return result;

  const pyramid: Raster[] = [src];
  const level = (l: number) => {
    while (pyramid.length <= l) pyramid.push(downsample(pyramid[pyramid.length - 1]));
    return pyramid[l];
  };
  const maxLevel = Math.floor(Math.log2(Math.max(src.width, src.height)));
  // Source texel (level 0) = source.xy + uv·source.wh − srcRect.xy.
  const { source } = m;
  const mesh = tessellate(m);
  const { positions: P, uvs: U, indices } = mesh;

  for (let k = 0; k < indices.length; k += 3) {
    const i0 = indices[k], i1 = indices[k + 1], i2 = indices[k + 2];
    const w0 = P[i0 * 3 + 2], w1 = P[i1 * 3 + 2], w2 = P[i2 * 3 + 2];
    if (w0 <= 0 || w1 <= 0 || w2 <= 0) continue;
    const x0 = P[i0 * 3] / w0, y0 = P[i0 * 3 + 1] / w0;
    const x1 = P[i1 * 3] / w1, y1 = P[i1 * 3 + 1] / w1;
    const x2 = P[i2 * 3] / w2, y2 = P[i2 * 3 + 1] / w2;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-12) continue;

    // Screen-linear plane equations for q/w (q ∈ {u, v, 1}).
    const plane = (q0: number, q1: number, q2: number): Interp => {
      const a = ((q1 - q0) * (y2 - y0) - (q2 - q0) * (y1 - y0)) / area;
      const b = ((q2 - q0) * (x1 - x0) - (q1 - q0) * (x2 - x0)) / area;
      return { a, b, c: q0 - a * x0 - b * y0 };
    };
    const texU = (i: number) => source.x + U[i * 2] * source.w - srcRect.x;
    const texV = (i: number) => source.y + U[i * 2 + 1] * source.h - srcRect.y;
    const su0 = texU(i0), su1 = texU(i1), su2 = texU(i2);
    const sv0 = texV(i0), sv1 = texV(i1), sv2 = texV(i2);
    const PU = plane(su0 / w0, su1 / w1, su2 / w2);
    const PV = plane(sv0 / w0, sv1 / w1, sv2 / w2);
    const PW = plane(1 / w0, 1 / w1, 1 / w2);

    const bx0 = Math.max(dest.x, Math.floor(Math.min(x0, x1, x2)));
    const by0 = Math.max(dest.y, Math.floor(Math.min(y0, y1, y2)));
    const bx1 = Math.min(dest.x + dest.w - 1, Math.ceil(Math.max(x0, x1, x2)));
    const by1 = Math.min(dest.y + dest.h - 1, Math.ceil(Math.max(y0, y1, y2)));
    const sign = area > 0 ? 1 : -1;
    // Edge functions, normalised so inside is ≥ 0; a small epsilon closes seams between triangles.
    const edge = (ax: number, ay: number, bx: number, by: number) => {
      const ea = -(by - ay) * sign, eb = (bx - ax) * sign;
      return { a: ea, b: eb, c: -(ea * ax + eb * ay) };
    };
    const E0 = edge(x1, y1, x2, y2), E1 = edge(x2, y2, x0, y0), E2 = edge(x0, y0, x1, y1);
    const eps = -1e-7 * Math.abs(area);

    for (let y = by0; y <= by1; y++) {
      const py = y + 0.5;
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5;
        if (E0.a * px + E0.b * py + E0.c < eps) continue;
        if (E1.a * px + E1.b * py + E1.c < eps) continue;
        if (E2.a * px + E2.b * py + E2.c < eps) continue;
        const nu = PU.a * px + PU.b * py + PU.c;
        const nv = PV.a * px + PV.b * py + PV.c;
        const d = PW.a * px + PW.b * py + PW.c;
        if (d <= 0) continue;
        const u = nu / d, v = nv / d;
        // d(n/d)/dx = (n_x·d − n·d_x) / d², likewise for y.
        const d2 = d * d;
        const dudx = (PU.a * d - nu * PW.a) / d2, dvdx = (PV.a * d - nv * PW.a) / d2;
        const dudy = (PU.b * d - nu * PW.b) / d2, dvdy = (PV.b * d - nv * PW.b) / d2;
        const rho = Math.max(dudx * dudx + dvdx * dvdx, dudy * dudy + dvdy * dvdy);
        const lod = filter === "nearest" || rho <= 1 ? 0 : Math.min(maxLevel, Math.floor(0.5 * Math.log2(rho)));
        const img = level(lod);
        const sc = img.width / src.width;
        const scy = img.height / src.height;
        const fx = u * sc - 0.5, fy = v * scy - 0.5;
        const o = ((y - dest.y) * dest.w + (x - dest.x)) * channels;
        sample(img, fx, fy, filter, out, o);
      }
    }
  }
  return result;
}

function sample(img: Raster, fx: number, fy: number, filter: Filter, out: Uint8ClampedArray, o: number) {
  const bx = Math.floor(fx), by = Math.floor(fy);
  const tx = fx - bx, ty = fy - by;
  const { data, width, height, channels } = img;
  if (filter === "nearest") {
    const x = Math.round(fx), y = Math.round(fy);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const k = (y * width + x) * channels;
    for (let c = 0; c < channels; c++) out[o + c] = data[k + c];
    return;
  }
  if (filter === "bilinear") {
    wx[0] = 1 - tx; wx[1] = tx;
    wy[0] = 1 - ty; wy[1] = ty;
    accumulate(data, width, height, channels, bx, by, 2, out, o);
    return;
  }
  for (let k = 0; k < 4; k++) {
    wx[k] = cubic(tx - (k - 1));
    wy[k] = cubic(ty - (k - 1));
  }
  accumulate(data, width, height, channels, bx - 1, by - 1, 4, out, o);
}

