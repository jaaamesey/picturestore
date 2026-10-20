export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
export const EMPTY_RECT: Rect = rect(0, 0, 0, 0);

export const isEmpty = (r: Rect) => r.w <= 0 || r.h <= 0;

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? rect(x, y, w, h) : EMPTY_RECT;
}

export function union(a: Rect, b: Rect): Rect {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return rect(x, y, Math.max(a.x + a.w, b.x + b.w) - x, Math.max(a.y + a.h, b.y + b.h) - y);
}

/** Normalised rect spanning two corner points (in any order). */
export function rectFromPoints(a: Vec2, b: Vec2): Rect {
  return rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
}

/** Smallest integer-aligned rect containing `r`. */
export function roundOut(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return rect(x, y, Math.ceil(r.x + r.w) - x, Math.ceil(r.y + r.h) - y);
}

export function boundsOf(points: readonly Vec2[]): Rect {
  if (points.length === 0) return EMPTY_RECT;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return rect(minX, minY, maxX - minX, maxY - minY);
}

export const rectCorners = (r: Rect): Vec2[] => [
  vec(r.x, r.y),
  vec(r.x + r.w, r.y),
  vec(r.x + r.w, r.y + r.h),
  vec(r.x, r.y + r.h),
];

export const containsPoint = (r: Rect, p: Vec2) =>
  p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;

export const distance = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * 2D affine matrix in the same layout as DOMMatrix / canvas `setTransform`:
 * x' = a·x + c·y + e,  y' = b·x + d·y + f.
 */
export type Mat = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** Composition: the result applies `n` first, then `m`. */
export function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Composes left-to-right in application order: `compose(a, b)` applies a then b. */
export const compose = (...ms: Mat[]): Mat => ms.reduce((acc, m) => multiply(m, acc), IDENTITY);

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error("Matrix is not invertible");
  const id = 1 / det;
  return [
    m[3] * id,
    -m[1] * id,
    -m[2] * id,
    m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id,
  ];
}

export const apply = (m: Mat, p: Vec2): Vec2 =>
  vec(m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]);

export const translation = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scaling = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotation(radians: number): Mat {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c, s, -s, c, 0, 0];
}

export const isIdentity = (m: Mat, eps = 1e-9) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < eps);

/** If `m` is a pure integer translation, returns it; otherwise null. */
export function integerTranslation(m: Mat, eps = 1e-6): Vec2 | null {
  const [a, b, c, d, e, f] = m;
  const isTranslate = Math.abs(a - 1) < eps && Math.abs(b) < eps && Math.abs(c) < eps && Math.abs(d - 1) < eps;
  if (!isTranslate || Math.abs(e - Math.round(e)) > eps || Math.abs(f - Math.round(f)) > eps) return null;
  return vec(Math.round(e), Math.round(f));
}

export const transformRect = (m: Mat, r: Rect): Rect => boundsOf(rectCorners(r).map((p) => apply(m, p)));

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
