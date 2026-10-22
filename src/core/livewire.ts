import { rect, vec, type Rect, type Vec2 } from "./geometry";

/**
 * Live-wire edge tracing (Mortensen & Barrett, "Intelligent Scissors", 1995)
 * for the Magnetic Pen: the cheapest route between two points, where
 * stepping over a strong edge in the image costs little and over flat
 * colour costs the full distance. The route is found by Dijkstra's
 * algorithm over just the pixels near the line between the two points.
 */

/** How strongly the image changes at each pixel, 0–255 (a black/white step is 255); computed in tiles as they're needed. */
export interface Edges {
  at(x: number, y: number): number;
}

const TILE = 128;

/** Edges of an image of `width × height` that `read` supplies (straight RGBA of an area). */
export function createEdges(width: number, height: number, read: (area: Rect) => Uint8ClampedArray): Edges {
  const tiles = new Map<number, Float32Array>();
  const tileAt = (tx: number, ty: number): Float32Array => {
    const key = ty * 1e5 + tx;
    let t = tiles.get(key);
    if (t) return t;
    // The tile and a pixel around it, for the gradient at its edges.
    const x0 = Math.max(0, tx * TILE - 1), y0 = Math.max(0, ty * TILE - 1);
    const x1 = Math.min(width, (tx + 1) * TILE + 1), y1 = Math.min(height, (ty + 1) * TILE + 1);
    const w = x1 - x0, h = y1 - y0;
    const px = read(rect(x0, y0, w, h));
    t = new Float32Array(TILE * TILE);
    const sample = (x: number, y: number, c: number) => px[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
    for (let y = ty * TILE; y < Math.min(height, (ty + 1) * TILE); y++)
      for (let x = tx * TILE; x < Math.min(width, (tx + 1) * TILE); x++) {
        const lx = x - x0, ly = y - y0;
        let best = 0;
        for (let c = 0; c < 4; c++) {
          const gx = sample(lx + 1, ly - 1, c) + 2 * sample(lx + 1, ly, c) + sample(lx + 1, ly + 1, c) - sample(lx - 1, ly - 1, c) - 2 * sample(lx - 1, ly, c) - sample(lx - 1, ly + 1, c);
          const gy = sample(lx - 1, ly + 1, c) + 2 * sample(lx, ly + 1, c) + sample(lx + 1, ly + 1, c) - sample(lx - 1, ly - 1, c) - 2 * sample(lx, ly - 1, c) - sample(lx + 1, ly - 1, c);
          best = Math.max(best, Math.hypot(gx, gy) / 4);
        }
        t[(y - ty * TILE) * TILE + (x - tx * TILE)] = best;
      }
    tiles.set(key, t);
    return t;
  };
  return {
    at(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return 0;
      return tileAt(Math.floor(x / TILE), Math.floor(y / TILE))[(y % TILE) * TILE + (x % TILE)];
    },
  };
}

export interface TraceOptions {
  /** How far from the line between the points the route may stray, in pixels. */
  readonly width: number;
  /** The change (percent of the full range) that counts as an edge. */
  readonly contrast: number;
}

/** What a step costs when it crosses no edge at all (so that flat colour takes the straight way). */
const FLOOR = 0.03;
/** What straying the full width from the line adds to a step. */
const STRAY = 0.02;

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys, v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  /** The value with the least key. */
  pop(): number {
    const k = this.keys, v = this.vals;
    const top = v[0];
    const key = k.pop()!, val = v.pop()!;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = key;
      v[i] = val;
    }
    return top;
  }
}

/** The route from `from` to `to`, as points: the two ends and the centres of the pixels between. */
export function traceEdge(edges: Edges, from: Vec2, to: Vec2, o: TraceOptions, bounds: { width: number; height: number }): Vec2[] {
  const pad = Math.max(1, Math.ceil(o.width));
  const x0 = Math.max(0, Math.floor(Math.min(from.x, to.x)) - pad), y0 = Math.max(0, Math.floor(Math.min(from.y, to.y)) - pad);
  const x1 = Math.min(bounds.width, Math.ceil(Math.max(from.x, to.x)) + pad + 1), y1 = Math.min(bounds.height, Math.ceil(Math.max(from.y, to.y)) + pad + 1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return [from, to];
  const clampX = (x: number) => Math.min(x1 - 1, Math.max(x0, Math.floor(x)));
  const clampY = (y: number) => Math.min(y1 - 1, Math.max(y0, Math.floor(y)));
  const start = (clampY(from.y) - y0) * w + (clampX(from.x) - x0);
  const goal = (clampY(to.y) - y0) * w + (clampX(to.x) - x0);
  if (start === goal) return [from, to];

  const threshold = Math.max(1, (o.contrast / 100) * 255);
  const cost = new Float32Array(w * h).fill(Infinity);
  const from_ = new Int32Array(w * h).fill(-1);
  const done = new Uint8Array(w * h);
  // Nodes farther from the line than the width are out of reach.
  const dx = to.x - from.x, dy = to.y - from.y, len2 = dx * dx + dy * dy;
  const offLine = (x: number, y: number) => {
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x + 0.5 - from.x) * dx + (y + 0.5 - from.y) * dy) / len2));
    return Math.hypot(x + 0.5 - from.x - dx * t, y + 0.5 - from.y - dy * t);
  };
  const reach = (x: number, y: number) => offLine(x, y) <= o.width + 1;
  // Stepping onto a pixel costs by how weak its edge is, and a little for straying (so flat colour is crossed straight).
  const step = (x: number, y: number) => FLOOR + (1 - FLOOR) * (1 - Math.min(1, edges.at(x, y) / threshold)) + (STRAY * offLine(x, y)) / (o.width + 1);
  const heap = new MinHeap();
  cost[start] = 0;
  heap.push(0, start);
  while (heap.size) {
    const n = heap.pop();
    if (done[n]) continue;
    done[n] = 1;
    if (n === goal) break;
    const nx = n % w, ny = (n - nx) / w;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const mx = nx + ox, my = ny + oy;
        if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
        const m = my * w + mx;
        if (done[m] || !reach(x0 + mx, y0 + my)) continue;
        const c = cost[n] + step(x0 + mx, y0 + my) * (ox && oy ? Math.SQRT2 : 1);
        if (c < cost[m]) {
          cost[m] = c;
          from_[m] = n;
          heap.push(c, m);
        }
      }
  }
  if (!done[goal]) return [from, to];
  const route: Vec2[] = [];
  for (let n = goal; n !== -1 && n !== start; n = from_[n]) route.push(vec(x0 + (n % w) + 0.5, y0 + Math.floor(n / w) + 0.5));
  route.reverse();
  return [from, ...route.slice(0, -1), to];
}
