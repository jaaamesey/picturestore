import { EMPTY_RECT, intersect, isEmpty, rect, union, type Rect } from "./geometry";

/**
 * Layer pixels live in a sparse grid of fixed-size tiles in document space.
 *
 * Tiles are treated as immutable once they are part of a committed document,
 * which lets history snapshots share every tile an edit didn't touch. Edits go
 * through a {@link TileWriter}, which clones a tile on first write and may then
 * mutate its own copy in place (bumping `version` so the GPU cache re-uploads).
 *
 * Pixels are straight (non-premultiplied) RGBA8, matching PSD and ImageData.
 */
export const TILE_SIZE = 256;
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;

export interface Tile {
  readonly data: Uint8ClampedArray;
  /** Incremented on every in-place mutation. */
  version: number;
}

export type TileKey = string;
export type TileMap = ReadonlyMap<TileKey, Tile>;

export const EMPTY_TILES: TileMap = new Map();

export const tileKey = (tx: number, ty: number): TileKey => `${tx},${ty}`;

export function parseTileKey(key: TileKey): [number, number] {
  const i = key.indexOf(",");
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

export const tileRect = (tx: number, ty: number): Rect => rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);

export const newTile = (): Tile => ({ data: new Uint8ClampedArray(TILE_BYTES), version: 0 });

export const cloneTile = (t: Tile): Tile => ({ data: t.data.slice(), version: t.version + 1 });

/** Tile coordinates of every tile overlapping `r`. */
export function* tilesIn(r: Rect): Generator<[number, number]> {
  if (isEmpty(r)) return;
  const tx0 = Math.floor(r.x / TILE_SIZE);
  const ty0 = Math.floor(r.y / TILE_SIZE);
  const tx1 = Math.floor((r.x + r.w - 1) / TILE_SIZE);
  const ty1 = Math.floor((r.y + r.h - 1) / TILE_SIZE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) yield [tx, ty];
}

export function isTransparent(t: Tile): boolean {
  const d = t.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
}

export interface TileWriter {
  /** The working map; readers may iterate it while a stroke is in progress. */
  readonly tiles: Map<TileKey, Tile>;
  get(tx: number, ty: number): Tile | undefined;
  /** A tile that is safe to mutate: cloned (or created) on first request. */
  writable(tx: number, ty: number): Tile;
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
    delete: (tx, ty) => void tiles.delete(tileKey(tx, ty)),
    finish() {
      for (const [key, t] of tiles) if (owned.has(t) && isTransparent(t)) tiles.delete(key);
      return tiles;
    },
  };
}

/** Copies the pixels of `r` out of a tile map into a contiguous RGBA buffer. */
export function readRect(tiles: TileMap, r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (const [tx, ty] of tilesIn(r)) {
    const t = tiles.get(tileKey(tx, ty));
    if (!t) continue;
    const part = intersect(r, tileRect(tx, ty));
    const ox = tx * TILE_SIZE;
    const oy = ty * TILE_SIZE;
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
    const ox = tx * TILE_SIZE;
    const oy = ty * TILE_SIZE;
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
  for (const key of tiles.keys()) bounds = union(bounds, tileRect(...parseTileKey(key)));
  return bounds;
}

/** Tight bounds of non-transparent pixels. */
export function contentBounds(tiles: TileMap): Rect {
  let bounds = EMPTY_RECT;
  for (const [key, t] of tiles) {
    const [tx, ty] = parseTileKey(key);
    let minX = TILE_SIZE, minY = TILE_SIZE, maxX = -1, maxY = -1;
    const d = t.data;
    for (let y = 0; y < TILE_SIZE; y++) {
      const row = y * TILE_SIZE * 4;
      for (let x = 0; x < TILE_SIZE; x++) {
        if (d[row + x * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
    if (maxX >= 0) {
      bounds = union(bounds, rect(tx * TILE_SIZE + minX, ty * TILE_SIZE + minY, maxX - minX + 1, maxY - minY + 1));
    }
  }
  return bounds;
}

/** Shifts every pixel by an integer offset. */
export function translateTiles(tiles: TileMap, dx: number, dy: number): TileMap {
  if (dx === 0 && dy === 0) return tiles;
  if (dx % TILE_SIZE === 0 && dy % TILE_SIZE === 0) {
    const out = new Map<TileKey, Tile>();
    for (const [key, t] of tiles) {
      const [tx, ty] = parseTileKey(key);
      out.set(tileKey(tx + dx / TILE_SIZE, ty + dy / TILE_SIZE), t);
    }
    return out;
  }
  const w = tileWriter(EMPTY_TILES);
  for (const [key, t] of tiles) {
    const [tx, ty] = parseTileKey(key);
    writeRect(w, rect(tx * TILE_SIZE + dx, ty * TILE_SIZE + dy, TILE_SIZE, TILE_SIZE), t.data);
  }
  return w.finish();
}

export const pixelIndex = (x: number, y: number) =>
  (((y % TILE_SIZE) + TILE_SIZE) % TILE_SIZE) * TILE_SIZE * 4 + (((x % TILE_SIZE) + TILE_SIZE) % TILE_SIZE) * 4;

/** Reads a single pixel; transparent black where no tile exists. */
export function getPixel(tiles: TileMap, x: number, y: number): [number, number, number, number] {
  const t = tiles.get(tileKey(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE)));
  if (!t) return [0, 0, 0, 0];
  const i = pixelIndex(x, y);
  return [t.data[i], t.data[i + 1], t.data[i + 2], t.data[i + 3]];
}
