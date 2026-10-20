import { EMPTY_RECT, boundsOf, rect, union, vec, type Rect, type Vec2 } from "./geometry";

/**
 * Projective and warp mappings from a source rectangle into document space.
 *
 * A mapping is `doc = H(patch(s, t))` where (s, t) ∈ [0, 1]² are normalised
 * source coordinates, `patch` is an optional bicubic Bézier warp defined in
 * that same unit square, and `H` is the homography taking the unit square onto
 * the transform quad. Keeping the warp *before* the homography means
 * perspective stays exact even when warped, and warp edits stay meaningful
 * after further scaling, rotation or distortion.
 */

/** Row-major 3×3: [x', y', w'] = M · [x, y, 1]. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** Top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

export const quadOf = (r: Rect): Quad => [vec(r.x, r.y), vec(r.x + r.w, r.y), vec(r.x + r.w, r.y + r.h), vec(r.x, r.y + r.h)];

/**
 * Homography taking the unit square's corners (0,0), (1,0), (1,1), (0,1) to
 * the quad's corners (Heckbert, "Fundamentals of Texture Mapping", 1989).
 * Affine quads (parallelograms) yield g = h = 0. Null for degenerate quads.
 */
export function squareToQuad(q: Quad): Mat3 | null {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r as unknown as Mat3;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

export function project(m: Mat3, x: number, y: number): Vec2 {
  const w = m[6] * x + m[7] * y + m[8];
  return vec((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w);
}

/** A quad is usable for a homography when it is strictly convex (no fold, no horizon inside). */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Bicubic Bézier warp patch

/** 16 control points in the unit square, row-major (index = row · 4 + column). */
export type Patch = readonly Vec2[];

export const IDENTITY_PATCH: Patch = Array.from({ length: 16 }, (_, k) => vec((k % 4) / 3, Math.floor(k / 4) / 3));

export const isIdentityPatch = (p: Patch) =>
  p.every((q, k) => Math.abs(q.x - IDENTITY_PATCH[k].x) < 1e-9 && Math.abs(q.y - IDENTITY_PATCH[k].y) < 1e-9);

/** Corner anchors and, for each, its two adjacent Bézier handles. */
export const PATCH_ANCHORS: readonly (readonly [number, number, number])[] = [
  [0, 1, 4],
  [3, 2, 7],
  [15, 14, 11],
  [12, 13, 8],
];

function bernstein(t: number, out: Float64Array) {
  const u = 1 - t;
  out[0] = u * u * u;
  out[1] = 3 * t * u * u;
  out[2] = 3 * t * t * u;
  out[3] = t * t * t;
}

function bernsteinDerivative(t: number, out: Float64Array) {
  const u = 1 - t;
  out[0] = -3 * u * u;
  out[1] = 3 * u * u - 6 * t * u;
  out[2] = 6 * t * u - 3 * t * t;
  out[3] = 3 * t * t;
}

const bs = new Float64Array(4), bt = new Float64Array(4), ds = new Float64Array(4), dt = new Float64Array(4);

export function evalPatch(p: Patch, s: number, t: number): Vec2 {
  bernstein(s, bs);
  bernstein(t, bt);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++) {
      const w = bs[i] * bt[j];
      x += p[j * 4 + i].x * w;
      y += p[j * 4 + i].y * w;
    }
  return vec(x, y);
}

/** Basis weights B_i(s)·B_j(t) for each control point. */
export function patchWeights(s: number, t: number): number[] {
  bernstein(s, bs);
  bernstein(t, bt);
  return Array.from({ length: 16 }, (_, k) => bs[k % 4] * bt[Math.floor(k / 4)]);
}

/**
 * Domain coordinates (s, t) whose patch point is `q`, by Newton's method from
 * the best sample of a coarse grid. Null when `q` is not on the surface.
 */
export function invertPatch(p: Patch, q: Vec2): { s: number; t: number } | null {
  let best = { s: 0.5, t: 0.5, d: Infinity };
  const N = 16;
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      const v = evalPatch(p, i / N, j / N);
      const d = (v.x - q.x) ** 2 + (v.y - q.y) ** 2;
      if (d < best.d) best = { s: i / N, t: j / N, d };
    }
  let { s, t } = best;
  for (let iter = 0; iter < 12; iter++) {
    bernstein(s, bs);
    bernstein(t, bt);
    bernsteinDerivative(s, ds);
    bernsteinDerivative(t, dt);
    let x = 0, y = 0, xs = 0, ys = 0, xt = 0, yt = 0;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const c = p[j * 4 + i];
        x += c.x * bs[i] * bt[j];
        y += c.y * bs[i] * bt[j];
        xs += c.x * ds[i] * bt[j];
        ys += c.y * ds[i] * bt[j];
        xt += c.x * bs[i] * dt[j];
        yt += c.y * bs[i] * dt[j];
      }
    const fx = x - q.x, fy = y - q.y;
    if (fx * fx + fy * fy < 1e-14) break;
    const det = xs * yt - xt * ys;
    if (Math.abs(det) < 1e-14) break;
    s -= (fx * yt - fy * xt) / det;
    t -= (fy * xs - fx * ys) / det;
    s = Math.min(1.1, Math.max(-0.1, s));
    t = Math.min(1.1, Math.max(-0.1, t));
  }
  const back = evalPatch(p, s, t);
  const eps = 1e-6;
  if (s < -eps || s > 1 + eps || t < -eps || t > 1 + eps) return null;
  if (Math.hypot(back.x - q.x, back.y - q.y) > 1e-4) return null;
  return { s: Math.min(1, Math.max(0, s)), t: Math.min(1, Math.max(0, t)) };
}

/**
 * Moves control points so the surface point at (s, t) moves by `delta`, with
 * the minimum total control-point displacement (least-norm solution of
 * Σ wₖ·Δₖ = delta, i.e. Δₖ = wₖ·delta / Σ wₖ²).
 */
export function dragPatchSurface(p: Patch, s: number, t: number, delta: Vec2): Patch {
  const w = patchWeights(s, t);
  const norm = w.reduce((a, v) => a + v * v, 0);
  return p.map((c, k) => vec(c.x + (w[k] * delta.x) / norm, c.y + (w[k] * delta.y) / norm));
}

// ---------------------------------------------------------------------------
// Mappings and meshes

export interface Mapping {
  /** Source rectangle, in document space before transformation. */
  readonly source: Rect;
  /** Where the source's corners land. */
  readonly quad: Quad;
  /** Optional warp, in the unit square before the homography. */
  readonly patch: Patch | null;
}

export interface Mesh {
  /** Homogeneous document-space positions (x·w, y·w, w) per vertex. */
  readonly positions: Float32Array;
  /** Normalised source coordinates per vertex. */
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

/** Grid resolution for a warp patch: fine enough that segments stay ≲ 8px. */
export function warpSegments(m: Mapping): number {
  if (!m.patch) return 1;
  const b = mappingBounds(m, 8);
  return Math.max(8, Math.min(96, Math.ceil(Math.max(b.w, b.h) / 8)));
}

/**
 * Triangulates a mapping. Positions are emitted homogeneously so that
 * perspective-correct interpolation (on the GPU, and in the CPU rasterizer)
 * reproduces the homography exactly; only the warp is piecewise linear.
 */
export function tessellate(m: Mapping, segments = warpSegments(m)): Mesh {
  const H = squareToQuad(m.quad);
  if (!H) throw new Error("Degenerate transform");
  const n = m.patch ? segments : 1;
  const verts = (n + 1) * (n + 1);
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  for (let j = 0, v = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++, v++) {
      const s = i / n, t = j / n;
      const q = m.patch ? evalPatch(m.patch, s, t) : vec(s, t);
      positions[v * 3] = H[0] * q.x + H[1] * q.y + H[2];
      positions[v * 3 + 1] = H[3] * q.x + H[4] * q.y + H[5];
      positions[v * 3 + 2] = H[6] * q.x + H[7] * q.y + H[8];
      uvs[v * 2] = s;
      uvs[v * 2 + 1] = t;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  for (let j = 0, k = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1, c = a + n + 1, d = c + 1;
      indices.set([a, b, d, a, d, c], k);
      k += 6;
    }
  }
  return { positions, uvs, indices };
}

/** Document-space bounds of a mapping's image. */
export function mappingBounds(m: Mapping, segments = 16): Rect {
  const H = squareToQuad(m.quad);
  if (!H) return EMPTY_RECT;
  if (!m.patch) return boundsOf([...m.quad]);
  // A Bézier surface lies within its control net's convex hull, and the
  // homography (with w > 0 inside a convex quad) preserves that.
  let b = boundsOf(m.patch.map((c) => project(H, c.x, c.y)));
  const pts: Vec2[] = [];
  for (let j = 0; j <= segments; j++)
    for (let i = 0; i <= segments; i++) {
      const q = evalPatch(m.patch, i / segments, j / segments);
      pts.push(project(H, q.x, q.y));
    }
  b = union(b, boundsOf(pts));
  return rect(b.x, b.y, b.w, b.h);
}

/** Maps a normalised source point to the document. */
export function mapPoint(m: Mapping, s: number, t: number): Vec2 {
  const H = squareToQuad(m.quad)!;
  const q = m.patch ? evalPatch(m.patch, s, t) : vec(s, t);
  return project(H, q.x, q.y);
}
