import { EMPTY_RECT, intersect, isEmpty, rect, union, type Rect } from "./geometry";

/**
 * A layer's pixels ({@link Pixels}): an unbounded image in document space,
 * stored as a sparse grid of fixed-size tiles. The tiling is this module's
 * business (and the GPU renderer's, which uploads it): everything else works
 * in regions — reading and writing rectangles, visiting row spans, bounds,
 * shifts and clips — so no other code computes where a pixel is stored.
 *
 * Tiles are treated as immutable once they are part of a committed document,
 * which lets history snapshots share every tile an edit didn't touch. Edits go
 * through a {@link TileWriter}, which clones a tile on first write and may then
 * mutate its own copy in place (bumping `version` so caches refresh).
 *
 * Pixels are straight (non-premultiplied) RGBA8, matching PSD and ImageData.
 * Word-at-a-time scans assume a little-endian host (every browser engine), so
 * alpha is the top byte of each pixel's u32.
 */
export const TILE_SHIFT = 8;
export const TILE_SIZE = 1 << TILE_SHIFT;
const TILE_PIXELS = TILE_SIZE * TILE_SIZE;
const ALPHA = 0xff000000;

export interface Tile {
  readonly data: Uint8ClampedArray;
  /** Incremented on every in-place mutation. */
  version: number;
}

/** Tile coordinates packed into one integer (±32k tiles, i.e. ±8M pixels, per axis). */
export type TileKey = number;
export type Pixels = ReadonlyMap<TileKey, Tile>;

export const NO_PIXELS: Pixels = new Map();

const OFFSET = 1 << 15;
const SPAN = 1 << 16;
export const tileKey = (tx: number, ty: number): TileKey => (ty + OFFSET) * SPAN + (tx + OFFSET);
export const keyX = (key: TileKey) => (key % SPAN) - OFFSET;
export const keyY = (key: TileKey) => Math.floor(key / SPAN) - OFFSET;
export const parseTileKey = (key: TileKey): [number, number] => [keyX(key), keyY(key)];

/** Tile index containing a pixel coordinate (arithmetic shift floors negatives). */
export const tileOf = (v: number) => v >> TILE_SHIFT;

export const tileRect = (tx: number, ty: number): Rect => rect(tx << TILE_SHIFT, ty << TILE_SHIFT, TILE_SIZE, TILE_SIZE);

export const newTile = (): Tile => ({ data: new Uint8ClampedArray(TILE_PIXELS * 4), version: 0 });

export const cloneTile = (t: Tile): Tile => ({ data: t.data.slice(), version: t.version + 1 });

export const words = (t: Tile) => new Uint32Array(t.data.buffer, t.data.byteOffset, TILE_PIXELS);

/** Tile coordinates of every tile overlapping `r`. */
export function* tilesIn(r: Rect): Generator<[number, number]> {
  if (isEmpty(r)) return;
  const tx1 = tileOf(r.x + r.w - 1);
  const ty1 = tileOf(r.y + r.h - 1);
  for (let ty = tileOf(r.y); ty <= ty1; ty++) for (let tx = tileOf(r.x); tx <= tx1; tx++) yield [tx, ty];
}

export function isTransparent(t: Tile): boolean {
  const w = words(t);
  for (let i = 0; i < w.length; i++) if (w[i] & ALPHA) return false;
  return true;
}

export interface TileWriter {
  /** The working map; readers may iterate it while a stroke is in progress. */
  readonly tiles: Map<TileKey, Tile>;
  /** What the writer started from (untouched by it). */
  readonly base: Pixels;
  get(tx: number, ty: number): Tile | undefined;
  /** A tile that is safe to mutate: cloned (or created) on first request. */
  writable(tx: number, ty: number): Tile;
  /** Inserts an existing (shared, immutable) tile. */
  put(tx: number, ty: number, t: Tile): void;
  delete(tx: number, ty: number): void;
  /** Drops fully transparent tiles this writer created and returns the result. */
  finish(): Pixels;
}

export function tileWriter(base: Pixels): TileWriter {
  const pixels = new Map(base);
  const owned = new Set<Tile>();
  return {
    tiles: pixels,
    base,
    get: (tx, ty) => pixels.get(tileKey(tx, ty)),
    writable(tx, ty) {
      const key = tileKey(tx, ty);
      const existing = pixels.get(key);
      if (existing && owned.has(existing)) return existing;
      const t = existing ? cloneTile(existing) : newTile();
      owned.add(t);
      pixels.set(key, t);
      return t;
    },
    put: (tx, ty, t) => void pixels.set(tileKey(tx, ty), t),
    delete: (tx, ty) => void pixels.delete(tileKey(tx, ty)),
    finish() {
      for (const [key, t] of pixels) if (owned.has(t) && isTransparent(t)) pixels.delete(key);
      return pixels;
    },
  };
}

/** Copies the pixels of `r` out of a tile map into a contiguous RGBA buffer. */
export function readRect(pixels: Pixels, r: Rect, out = new Uint8ClampedArray(r.w * r.h * 4)): Uint8ClampedArray {
  for (const [tx, ty] of tilesIn(r)) {
    const t = pixels.get(tileKey(tx, ty));
    if (!t) continue;
    const part = intersect(r, tileRect(tx, ty));
    const ox = tx << TILE_SHIFT;
    const oy = ty << TILE_SHIFT;
    for (let y = part.y; y < part.y + part.h; y++) {
      const src = ((y - oy) * TILE_SIZE + (part.x - ox)) * 4;
      out.set(t.data.subarray(src, src + part.w * 4), ((y - r.y) * r.w + (part.x - r.x)) * 4);
    }
  }
  return out;
}

/** Replaces the pixels of `r` with `data` (contiguous RGBA, r.w × r.h). */
export function writeRect(w: TileWriter, r: Rect, data: Uint8ClampedArray | Uint8Array): void {
  for (const [tx, ty] of tilesIn(r)) {
    const part = intersect(r, tileRect(tx, ty));
    const t = w.writable(tx, ty);
    const ox = tx << TILE_SHIFT;
    const oy = ty << TILE_SHIFT;
    for (let y = part.y; y < part.y + part.h; y++) {
      const src = ((y - r.y) * r.w + (part.x - r.x)) * 4;
      t.data.set(data.subarray(src, src + part.w * 4), ((y - oy) * TILE_SIZE + (part.x - ox)) * 4);
    }
  }
}

/**
 * One row of a region's pixels, as stored: `n` pixels starting at byte `i`
 * of `data` (straight RGBA), the first at document (x, y). `words` views the
 * same buffer as one u32 per pixel (index i / 4) for word-at-a-time work.
 * For writes, `base` is the same row as it was before the writer touched it
 * (undefined where nothing was stored).
 *
 * Pixel loops go through these visitors rather than walking tiles, so tile
 * geometry stays in this module.
 */
export type SpanVisitor = (data: Uint8ClampedArray, i: number, x: number, y: number, n: number, words: Uint32Array, base: Uint8ClampedArray | undefined) => void;

/** Visits the stored pixels of `tiles` within `r`, row by row (what isn't stored is transparent, and skipped). */
export function readSpans(pixels: Pixels, r: Rect, visit: (data: Uint8ClampedArray, i: number, x: number, y: number, n: number) => void): void {
  for (const [tx, ty] of tilesIn(r)) {
    const t = pixels.get(tileKey(tx, ty));
    if (!t) continue;
    const part = intersect(r, tileRect(tx, ty));
    const ox = tx << TILE_SHIFT, oy = ty << TILE_SHIFT;
    for (let y = part.y; y < part.y + part.h; y++) visit(t.data, ((y - oy) * TILE_SIZE + (part.x - ox)) * 4, part.x, y, part.w);
  }
}

export interface WriteOptions {
  /** Only where the writer's base has pixels (erasing can't add any). */
  readonly stored?: boolean;
  /** Skips parts of the region that won't change (so shared storage isn't copied for nothing). */
  readonly wanted?: (part: Rect) => boolean;
}

/** Visits the pixels of `r` for writing through `w`, row by row: storage is copied on first write, and each written part's version bumped for caches. */
export function writeSpans(w: TileWriter, r: Rect, visit: SpanVisitor, o: WriteOptions = {}): void {
  for (const [tx, ty] of tilesIn(r)) {
    const base = w.base.get(tileKey(tx, ty))?.data;
    if (o.stored && !base) continue;
    const part = intersect(r, tileRect(tx, ty));
    if (o.wanted && !o.wanted(part)) continue;
    const t = w.writable(tx, ty);
    t.version++;
    const u = words(t);
    const ox = tx << TILE_SHIFT, oy = ty << TILE_SHIFT;
    for (let y = part.y; y < part.y + part.h; y++) visit(t.data, ((y - oy) * TILE_SIZE + (part.x - ox)) * 4, part.x, y, part.w, u, base);
  }
}

/**
 * `top` combined into `base`: where both have pixels, `combine` writes into
 * a copy of base's storage from top's (same layout, the whole stored block);
 * where only top has pixels they're shared as they are.
 */
export function combinePixels(base: Pixels, top: Pixels, combine: (dst: Uint8ClampedArray, src: Uint8ClampedArray) => void): Pixels {
  if (base.size === 0) return top;
  const out = tileWriter(base);
  for (const [key, t] of top) {
    const tx = keyX(key), ty = keyY(key);
    if (base.has(key)) combine(out.writable(tx, ty).data, t.data);
    else out.put(tx, ty, t);
  }
  return out.finish();
}

/**
 * Random access to single pixels, as packed little-endian RGBA u32s (0 where
 * nothing is stored), for algorithms that wander (flood fills).
 */
export function pixelReader(pixels: Pixels): (x: number, y: number) => number {
  let lastKey = NaN, last: Uint32Array | undefined;
  return (x, y) => {
    const key = tileKey(x >> TILE_SHIFT, y >> TILE_SHIFT);
    if (key !== lastKey) {
      lastKey = key;
      const t = pixels.get(key);
      last = t && words(t);
    }
    return last ? last[((y & (TILE_SIZE - 1)) << TILE_SHIFT) + (x & (TILE_SIZE - 1))] : 0;
  };
}

/**
 * A 1/2^level-scale image of the `width × height` area at the origin,
 * assembled from cached reduced tiles (only changed tiles are filtered
 * again): what layer thumbnails are drawn from.
 */
export function previewImage(pixels: Pixels, width: number, height: number, level: number): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const n = TILE_SIZE >> level;
  const pw = Math.ceil(width / (1 << level)), ph = Math.ceil(height / (1 << level));
  const data = new Uint8ClampedArray(pw * ph * 4);
  for (const [key, tile] of pixels) {
    const ox = keyX(key) * n, oy = keyY(key) * n;
    if (ox >= pw || oy >= ph || ox + n <= 0 || oy + n <= 0) continue;
    const preview = reducedTile(tile, level);
    const x0 = Math.max(0, -ox), x1 = Math.min(n, pw - ox);
    for (let y = Math.max(0, -oy); y < n && oy + y < ph; y++) data.set(preview.subarray((y * n + x0) * 4, (y * n + x1) * 4), ((oy + y) * pw + ox + x0) * 4);
  }
  return { width: pw, height: ph, data };
}

/** Builds a tile map from an RGBA image positioned at (x, y). Transparent tiles are omitted. */
export function pixelsFromImage(
  width: number,
  height: number,
  data: Uint8ClampedArray | Uint8Array,
  x = 0,
  y = 0,
): Pixels {
  const w = tileWriter(NO_PIXELS);
  writeRect(w, rect(x, y, width, height), data);
  return w.finish();
}

/** Bounds of the allocated tiles (cheap, but not tight). */
export function storedBounds(pixels: Pixels): Rect {
  let bounds = EMPTY_RECT;
  for (const key of pixels.keys()) bounds = union(bounds, tileRect(keyX(key), keyY(key)));
  return bounds;
}

const boundsCache = new WeakMap<Tile, { version: number; bounds: Rect }>();

/** Tight bounds of a tile's non-transparent pixels, in tile-local coordinates. Cached per tile version. */
export function tileContentBounds(t: Tile): Rect {
  const cached = boundsCache.get(t);
  if (cached && cached.version === t.version) return cached.bounds;
  const w = words(t);
  const rowEmpty = (y: number) => {
    for (let i = y * TILE_SIZE, end = i + TILE_SIZE; i < end; i++) if (w[i] & ALPHA) return false;
    return true;
  };
  let y0 = 0;
  while (y0 < TILE_SIZE && rowEmpty(y0)) y0++;
  let bounds = EMPTY_RECT;
  if (y0 < TILE_SIZE) {
    let y1 = TILE_SIZE - 1;
    while (rowEmpty(y1)) y1--;
    // Each row only needs scanning outside the columns already known to be covered.
    let x0 = TILE_SIZE;
    let x1 = -1;
    for (let y = y0; y <= y1; y++) {
      const row = y * TILE_SIZE;
      for (let x = 0; x < x0; x++) if (w[row + x] & ALPHA) { x0 = x; break; }
      for (let x = TILE_SIZE - 1; x > x1; x--) if (w[row + x] & ALPHA) { x1 = x; break; }
    }
    bounds = rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }
  boundsCache.set(t, { version: t.version, bounds });
  return bounds;
}

/** Tight bounds of non-transparent pixels. */
export function contentBounds(pixels: Pixels): Rect {
  let bounds = EMPTY_RECT;
  for (const [key, t] of pixels) {
    const b = tileContentBounds(t);
    if (!isEmpty(b)) bounds = union(bounds, rect((keyX(key) << TILE_SHIFT) + b.x, (keyY(key) << TILE_SHIFT) + b.y, b.w, b.h));
  }
  return bounds;
}

const reducedCache = new WeakMap<Tile, { version: number; levels: Map<number, Uint8ClampedArray<ArrayBuffer>> }>();

/**
 * A tile at 1/2^level scale, area-averaged (an alpha-weighted box filter),
 * cached per tile version and level. Thumbnails and the GPU's reduced views
 * are assembled from these, so after an edit only the tiles that changed
 * are filtered again.
 */
export function reducedTile(t: Tile, level: number): Uint8ClampedArray {
  if (level === 0) return t.data;
  let c = reducedCache.get(t);
  if (!c || c.version !== t.version) reducedCache.set(t, (c = { version: t.version, levels: new Map() }));
  let data = c.levels.get(level);
  if (!data) {
    // One colour throughout (a fill, a background) needs no filtering.
    const w = words(t), first = w[0];
    let uniform = true;
    for (let i = 1; i < w.length && uniform; i++) uniform = w[i] === first;
    const n = TILE_SIZE >> level;
    data = uniform ? new Uint8ClampedArray(new Uint32Array(n * n).fill(first).buffer) : downsampleTile(t, level);
    c.levels.set(level, data);
  }
  return data;
}

/** Shifts every pixel by an integer offset. Tile-aligned shifts share tiles instead of copying. */
export function translatePixels(pixels: Pixels, dx: number, dy: number): Pixels {
  if (dx === 0 && dy === 0) return pixels;
  if (dx % TILE_SIZE === 0 && dy % TILE_SIZE === 0) {
    const out = new Map<TileKey, Tile>();
    for (const [key, t] of pixels) out.set(tileKey(keyX(key) + dx / TILE_SIZE, keyY(key) + dy / TILE_SIZE), t);
    return out;
  }
  const w = tileWriter(NO_PIXELS);
  for (const [key, t] of pixels) {
    writeRect(w, rect((keyX(key) << TILE_SHIFT) + dx, (keyY(key) << TILE_SHIFT) + dy, TILE_SIZE, TILE_SIZE), t.data);
  }
  return w.finish();
}

/** Only the pixels within `r` (whole pixels): tiles inside are shared, tiles across its edge are copied and cleared outside it. */
export function clipPixels(pixels: Pixels, r: Rect): Pixels {
  const out = new Map<TileKey, Tile>();
  for (const [key, t] of pixels) {
    const tr = tileRect(keyX(key), keyY(key));
    const x0 = Math.max(r.x, tr.x), y0 = Math.max(r.y, tr.y), x1 = Math.min(r.x + r.w, tr.x + TILE_SIZE), y1 = Math.min(r.y + r.h, tr.y + TILE_SIZE);
    if (x0 >= x1 || y0 >= y1) continue;
    if (x0 === tr.x && y0 === tr.y && x1 === tr.x + TILE_SIZE && y1 === tr.y + TILE_SIZE) {
      out.set(key, t);
      continue;
    }
    const c = cloneTile(t);
    const px = words(c);
    for (let y = 0; y < TILE_SIZE; y++) {
      const row = y * TILE_SIZE, inY = y + tr.y >= y0 && y + tr.y < y1;
      if (!inY) px.fill(0, row, row + TILE_SIZE);
      else {
        px.fill(0, row, row + (x0 - tr.x));
        px.fill(0, row + (x1 - tr.x), row + TILE_SIZE);
      }
    }
    out.set(key, c);
  }
  return out;
}

/** Byte offset of a pixel within its tile. */
export const pixelIndex = (x: number, y: number) => ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;

/** Reads a single pixel; transparent black where no tile exists. */
export function getPixel(pixels: Pixels, x: number, y: number): [number, number, number, number] {
  const t = pixels.get(tileKey(tileOf(x), tileOf(y)));
  if (!t) return [0, 0, 0, 0];
  const i = pixelIndex(x, y);
  return [t.data[i], t.data[i + 1], t.data[i + 2], t.data[i + 3]];
}

/**
 * A tile at 1/2^level resolution: each output pixel is the alpha-weighted
 * mean of its 2^level × 2^level block (so transparent pixels don't darken
 * edges). For reduced-quality display under GPU memory pressure.
 */
export function downsampleTile(t: Tile, level: number): Uint8ClampedArray<ArrayBuffer> {
  return downsample(t.data, TILE_SIZE, TILE_SIZE, level);
}

/** {@link downsampleTile} for any straight-RGBA image; partial blocks at the edges average what they cover. */
export function downsample(src: Uint8ClampedArray, w: number, h: number, level: number): Uint8ClampedArray<ArrayBuffer> {
  const k = 1 << level;
  const ow = Math.ceil(w / k), oh = Math.ceil(h / k);
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    const y1 = Math.min(h, (oy + 1) * k);
    for (let ox = 0; ox < ow; ox++) {
      const x1 = Math.min(w, (ox + 1) * k);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = oy * k; y < y1; y++) {
        for (let x = ox * k, i = (y * w + x) * 4; x < x1; x++, i += 4) {
          const al = src[i + 3];
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a / n;
      }
    }
  }
  return out;
}
