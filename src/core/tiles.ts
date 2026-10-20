import { EMPTY_RECT, intersect, isEmpty, rect, union, type Rect } from "./geometry";

/**
 * Layer pixels live in a sparse grid of fixed-size tiles in document space.
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
export type TileMap = ReadonlyMap<TileKey, Tile>;

export const EMPTY_TILES: TileMap = new Map();

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
  get(tx: number, ty: number): Tile | undefined;
  /** A tile that is safe to mutate: cloned (or created) on first request. */
  writable(tx: number, ty: number): Tile;
  /** Inserts an existing (shared, immutable) tile. */
  put(tx: number, ty: number, t: Tile): void;
  delete(tx: number, ty: number): void;
  /** Drops fully transparent tiles this writer created and returns the result. */
  finish(): TileMap;
}

export function tileWriter(base: TileMap): TileWriter {
  const tiles = new Map(base);
  const owned = new Set<Tile>();
  return {
    tiles,
    get: (tx, ty) => tiles.get(tileKey(tx, ty)),
    writable(tx, ty) {
      const key = tileKey(tx, ty);
      const existing = tiles.get(key);
      if (existing && owned.has(existing)) return existing;
      const t = existing ? cloneTile(existing) : newTile();
      owned.add(t);
      tiles.set(key, t);
      return t;
    },
    put: (tx, ty, t) => void tiles.set(tileKey(tx, ty), t),
    delete: (tx, ty) => void tiles.delete(tileKey(tx, ty)),
    finish() {
      for (const [key, t] of tiles) if (owned.has(t) && isTransparent(t)) tiles.delete(key);
      return tiles;
    },
  };
}

/** Copies the pixels of `r` out of a tile map into a contiguous RGBA buffer. */
export function readRect(tiles: TileMap, r: Rect, out = new Uint8ClampedArray(r.w * r.h * 4)): Uint8ClampedArray {
  for (const [tx, ty] of tilesIn(r)) {
    const t = tiles.get(tileKey(tx, ty));
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

/** Builds a tile map from an RGBA image positioned at (x, y). Transparent tiles are omitted. */
export function tilesFromImage(
  width: number,
  height: number,
  data: Uint8ClampedArray | Uint8Array,
  x = 0,
  y = 0,
): TileMap {
  const w = tileWriter(EMPTY_TILES);
  writeRect(w, rect(x, y, width, height), data);
  return w.finish();
}

/** Bounds of the allocated tiles (cheap, but not tight). */
export function tileGridBounds(tiles: TileMap): Rect {
  let bounds = EMPTY_RECT;
  for (const key of tiles.keys()) bounds = union(bounds, tileRect(keyX(key), keyY(key)));
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
export function contentBounds(tiles: TileMap): Rect {
  let bounds = EMPTY_RECT;
  for (const [key, t] of tiles) {
    const b = tileContentBounds(t);
    if (!isEmpty(b)) bounds = union(bounds, rect((keyX(key) << TILE_SHIFT) + b.x, (keyY(key) << TILE_SHIFT) + b.y, b.w, b.h));
  }
  return bounds;
}

/** Downsampling factor of {@link tilePreview}. */
export const PREVIEW_FACTOR = 16;
const PREVIEW_SIZE = TILE_SIZE / PREVIEW_FACTOR;
const previewCache = new WeakMap<Tile, { version: number; data: Uint8ClampedArray }>();

/**
 * Area-averaged (box filtered, alpha-weighted) 1/16-scale copy of a tile,
 * cached per tile version. Thumbnails are assembled from these, so updating
 * one after an edit only re-filters the tiles that changed.
 */
export function tilePreview(t: Tile): Uint8ClampedArray {
  const cached = previewCache.get(t);
  if (cached && cached.version === t.version) return cached.data;
  const out = new Uint8ClampedArray(PREVIEW_SIZE * PREVIEW_SIZE * 4);
  const d = t.data;
  const n = PREVIEW_FACTOR * PREVIEW_FACTOR;
  for (let py = 0; py < PREVIEW_SIZE; py++) {
    for (let px = 0; px < PREVIEW_SIZE; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = py * PREVIEW_FACTOR; y < (py + 1) * PREVIEW_FACTOR; y++) {
        for (let i = (y * TILE_SIZE + px * PREVIEW_FACTOR) * 4, end = i + PREVIEW_FACTOR * 4; i < end; i += 4) {
          const al = d[i + 3];
          r += d[i] * al;
          g += d[i + 1] * al;
          b += d[i + 2] * al;
          a += al;
        }
      }
      const o = (py * PREVIEW_SIZE + px) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a / n;
      }
    }
  }
  previewCache.set(t, { version: t.version, data: out });
  return out;
}

/** Shifts every pixel by an integer offset. Tile-aligned shifts share tiles instead of copying. */
export function translateTiles(tiles: TileMap, dx: number, dy: number): TileMap {
  if (dx === 0 && dy === 0) return tiles;
  if (dx % TILE_SIZE === 0 && dy % TILE_SIZE === 0) {
    const out = new Map<TileKey, Tile>();
    for (const [key, t] of tiles) out.set(tileKey(keyX(key) + dx / TILE_SIZE, keyY(key) + dy / TILE_SIZE), t);
    return out;
  }
  const w = tileWriter(EMPTY_TILES);
  for (const [key, t] of tiles) {
    writeRect(w, rect((keyX(key) << TILE_SHIFT) + dx, (keyY(key) << TILE_SHIFT) + dy, TILE_SIZE, TILE_SIZE), t.data);
  }
  return w.finish();
}

/** Byte offset of a pixel within its tile. */
export const pixelIndex = (x: number, y: number) => ((y & (TILE_SIZE - 1)) * TILE_SIZE + (x & (TILE_SIZE - 1))) * 4;

/** Reads a single pixel; transparent black where no tile exists. */
export function getPixel(tiles: TileMap, x: number, y: number): [number, number, number, number] {
  const t = tiles.get(tileKey(tileOf(x), tileOf(y)));
  if (!t) return [0, 0, 0, 0];
  const i = pixelIndex(x, y);
  return [t.data[i], t.data[i + 1], t.data[i + 2], t.data[i + 3]];
}
