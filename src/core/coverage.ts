import { intersect, isEmpty, rect, roundOut, type Rect, type Vec2 } from "./geometry";

/** 8-bit coverage over `region` (row-major, region.w × region.h). */
export interface Coverage {
  readonly region: Rect;
  readonly data: Uint8Array;
}

/**
 * Exact-area antialiased fill of closed contours with the non-zero winding
 * rule, after the signed-area accumulation technique of font-rs /
 * stb_truetype: every edge deposits its exact coverage contribution into a
 * per-pixel accumulator, and a running sum along each row turns that into
 * coverage. O(perimeter + area), independent of vertex count per scanline.
 * Overlapping contours of the same orientation union; opposite ones cut holes.
 */
export function rasterizeContours(contours: readonly (readonly Vec2[])[], clip: Rect): Coverage | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) {
    if (c.length < 3) continue;
    for (const p of c) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (minX === Infinity) return null;
  const region = intersect(roundOut(rect(minX, minY, maxX - minX, maxY - minY)), clip);
  if (isEmpty(region)) return null;
  const w = region.w, h = region.h;
  const stride = w + 2;
  const acc = new Float32Array(stride * h);

  const line = (ax: number, ay: number, bx: number, by: number) => {
    if (ay === by) return;
    let dir = 1;
    if (ay > by) {
      dir = -1;
      [ax, ay, bx, by] = [bx, by, ax, ay];
    }
    const dxdy = (bx - ax) / (by - ay);
    let x = ax;
    let y0 = Math.floor(ay);
    if (ay < 0) {
      x -= ay * dxdy;
      y0 = 0;
    }
    const yEnd = Math.min(h, Math.ceil(by));
    for (let y = Math.max(0, y0); y < yEnd; y++) {
      const row = y * stride;
      const dy = Math.min(y + 1, by) - Math.max(y, ay);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = Math.min(x, xnext), xb = Math.max(x, xnext);
      const x0f = Math.floor(xa), x0i = x0f;
      const x1c = Math.ceil(xb), x1i = x1c;
      if (x1i <= x0i + 1) {
        const xmf = 0.5 * (x + xnext) - x0f;
        acc[row + x0i] += d - d * xmf;
        acc[row + x0i + 1] += d * xmf;
      } else {
        const s = 1 / (xb - xa);
        const x0frac = xa - x0f;
        const a0 = 0.5 * s * (1 - x0frac) * (1 - x0frac);
        const x1frac = xb - x1c + 1;
        const am = 0.5 * s * x1frac * x1frac;
        acc[row + x0i] += d * a0;
        if (x1i === x0i + 2) {
          acc[row + x0i + 1] += d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - x0frac);
          acc[row + x0i + 1] += d * (a1 - a0);
          for (let xi = x0i + 2; xi < x1i - 1; xi++) acc[row + xi] += d * s;
          const a2 = a1 + (x1i - x0i - 3) * s;
          acc[row + x1i - 1] += d * (1 - a2 - am);
        }
        acc[row + x1i] += d * am;
      }
      x = xnext;
    }
  };

  // Clip horizontally: geometry left of the region collapses onto x = 0 (it
  // still affects winding to its right); geometry right of it is irrelevant
  // and lands in the spare columns.
  const clampX = (x: number) => Math.min(w, Math.max(0, x));
  for (const points of contours) {
    if (points.length < 3) continue;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      const ax = p.x - region.x, ay = p.y - region.y;
      const bx = q.x - region.x, by = q.y - region.y;
      // Split at x = 0 and x = w so clamping never bends a sloped edge.
      const cuts = [0, 1];
      for (const edge of [0, w]) {
        if ((ax - edge) * (bx - edge) < 0) cuts.push((edge - ax) / (bx - ax));
      }
      cuts.sort((a, b) => a - b);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const t0 = cuts[k], t1 = cuts[k + 1];
        line(clampX(ax + (bx - ax) * t0), ay + (by - ay) * t0, clampX(ax + (bx - ax) * t1), ay + (by - ay) * t1);
      }
    }
  }

  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      sum += acc[row + x];
      data[y * w + x] = Math.round(Math.min(1, Math.abs(sum)) * 255);
    }
  }
  return { region, data };
}
