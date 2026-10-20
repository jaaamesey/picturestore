import { KERNELS, type BlendMode } from "./blend";
import type { RGB } from "./color";
import { intersect, rect, union, type Rect } from "./geometry";
import type { Mask } from "./selection";
import { EMPTY_TILES, TILE_SIZE, tileGridBounds, tileKey, tileRect, tileWriter, tilesIn, words, type TileMap } from "./tiles";

export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** [0, 1] */
  readonly opacity: number;
  readonly blendMode: BlendMode;
  readonly tiles: TileMap;
}

/**
 * An immutable document snapshot. Every edit produces a new Doc that shares
 * unchanged layers and tiles with its predecessor, so history is just a list
 * of snapshots.
 */
export interface Doc {
  readonly width: number;
  readonly height: number;
  /** Bottom to top. */
  readonly layers: readonly Layer[];
  readonly activeLayerId: string;
  /** null = nothing selected (operations apply to the whole layer). */
  readonly selection: Mask | null;
}

let idCounter = 0;
export const newId = () => `l${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export const docRect = (d: Pick<Doc, "width" | "height">): Rect => rect(0, 0, d.width, d.height);

export function createLayer(props: Partial<Layer> & Pick<Layer, "name">): Layer {
  return { id: newId(), visible: true, opacity: 1, blendMode: "normal", tiles: EMPTY_TILES, ...props };
}

/** Packs an opaque colour as a little-endian RGBA u32. */
const packOpaque = (c: RGB) => ((255 << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0;

/**
 * Fills `area` with a colour, composited over existing pixels with `opacity`
 * and the selection's coverage. Fully covered opaque spans are written a
 * word at a time.
 */
export function fillTiles(base: TileMap, area: Rect, color: RGB, mask: Mask | null = null, opacity = 1): TileMap {
  const w = tileWriter(base);
  const region = mask ? intersect(area, mask.bounds) : area;
  const word = packOpaque(color);
  for (const [tx, ty] of tilesIn(region)) {
    const part = intersect(region, tileRect(tx, ty));
    const t = w.writable(tx, ty);
    const d = t.data;
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    if (!mask && opacity >= 1) {
      const u = words(t);
      for (let y = part.y; y < part.y + part.h; y++) {
        const i = (y - oy) * TILE_SIZE + (part.x - ox);
        u.fill(word, i, i + part.w);
      }
      continue;
    }
    for (let y = part.y; y < part.y + part.h; y++) {
      const mrow = mask ? (y - mask.bounds.y) * mask.bounds.w - mask.bounds.x : 0;
      let i = ((y - oy) * TILE_SIZE + (part.x - ox)) * 4;
      for (let x = part.x; x < part.x + part.w; x++, i += 4) {
        const a = opacity * (mask ? mask.data[mrow + x] * INV255 : 1);
        if (a <= 0) continue;
        const da = d[i + 3] * INV255;
        const oa = a + da * (1 - a);
        const keep = (da * (1 - a)) / oa;
        const add = a / oa;
        d[i] = color.r * add + d[i] * keep;
        d[i + 1] = color.g * add + d[i + 1] * keep;
        d[i + 2] = color.b * add + d[i + 2] * keep;
        d[i + 3] = oa * 255;
      }
    }
  }
  return w.finish();
}

/** Erases pixels under `mask` (or everything). */
export function clearTiles(base: TileMap, mask: Mask | null): TileMap {
  if (!mask) return EMPTY_TILES;
  const w = tileWriter(base);
  const b = mask.bounds;
  for (const [tx, ty] of tilesIn(b)) {
    if (!w.get(tx, ty)) continue;
    const part = intersect(b, tileRect(tx, ty));
    const d = w.writable(tx, ty).data;
    const ox = tx * TILE_SIZE, oy = ty * TILE_SIZE;
    for (let y = part.y; y < part.y + part.h; y++) {
      const mrow = (y - b.y) * b.w - b.x;
      let i = ((y - oy) * TILE_SIZE + (part.x - ox)) * 4 + 3;
      for (let x = part.x; x < part.x + part.w; x++, i += 4) {
        const m = mask.data[mrow + x];
        if (m) d[i] = (d[i] * (255 - m)) / 255;
      }
    }
  }
  return w.finish();
}

const INV255 = 1 / 255;

export interface NewDocumentOptions {
  width: number;
  height: number;
  /** null → transparent. */
  background?: RGB | null;
}

export function createDocument({ width, height, background = { r: 255, g: 255, b: 255 } }: NewDocumentOptions): Doc {
  const layer = createLayer({
    name: "Background",
    tiles: background ? fillTiles(EMPTY_TILES, rect(0, 0, width, height), background) : EMPTY_TILES,
  });
  return { width, height, layers: [layer], activeLayerId: layer.id, selection: null };
}

export const activeLayer = (d: Doc): Layer | undefined => d.layers.find((l) => l.id === d.activeLayerId);
export const layerIndex = (d: Doc, id: string) => d.layers.findIndex((l) => l.id === id);

export function updateLayer(d: Doc, id: string, patch: Partial<Omit<Layer, "id">>): Doc {
  return { ...d, layers: d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

/** Next free "Layer N" name. */
export function nextLayerName(d: Doc): string {
  const used = new Set(d.layers.map((l) => l.name));
  let n = 1;
  while (used.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

/** Inserts `layer` above the active layer and makes it active. */
export function addLayer(d: Doc, layer: Layer = createLayer({ name: nextLayerName(d) })): Doc {
  const at = layerIndex(d, d.activeLayerId) + 1;
  const layers = [...d.layers.slice(0, at), layer, ...d.layers.slice(at)];
  return { ...d, layers, activeLayerId: layer.id };
}

export function removeLayer(d: Doc, id: string): Doc {
  if (d.layers.length <= 1) return d;
  const i = layerIndex(d, id);
  if (i < 0) return d;
  const layers = d.layers.filter((l) => l.id !== id);
  const activeLayerId = d.activeLayerId === id ? layers[Math.max(0, i - 1)].id : d.activeLayerId;
  return { ...d, layers, activeLayerId };
}

export function moveLayer(d: Doc, id: string, toIndex: number): Doc {
  const from = layerIndex(d, id);
  const to = Math.max(0, Math.min(d.layers.length - 1, toIndex));
  if (from < 0 || from === to) return d;
  const layers = [...d.layers];
  const [l] = layers.splice(from, 1);
  layers.splice(to, 0, l);
  return { ...d, layers };
}

export function duplicateLayer(d: Doc, id: string): Doc {
  const src = d.layers.find((l) => l.id === id);
  if (!src) return d;
  return addLayer({ ...d, activeLayerId: id }, { ...src, id: newId(), name: `${src.name} copy` });
}

/**
 * Composites layers into straight RGBA8. This is the reference compositor,
 * used for export and as the oracle for GPU rendering tests. Each layer is
 * applied a tile row at a time through its blend mode's row kernel.
 */
export function flatten(d: Doc, area: Rect = docRect(d), layers: readonly Layer[] = d.layers): Uint8ClampedArray {
  const acc = new Float32Array(area.w * area.h * 4);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    const kernel = KERNELS[layer.blendMode];
    for (const [tx, ty] of tilesIn(area)) {
      const t = layer.tiles.get(tileKey(tx, ty));
      if (!t) continue;
      const part = intersect(area, tileRect(tx, ty));
      for (let y = part.y; y < part.y + part.h; y++) {
        const si = ((y - ty * TILE_SIZE) * TILE_SIZE + (part.x - tx * TILE_SIZE)) * 4;
        const di = ((y - area.y) * area.w + (part.x - area.x)) * 4;
        kernel(acc, di, t.data, si, part.w, layer.opacity);
      }
    }
  }
  const out = new Uint8ClampedArray(acc.length);
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3];
    if (a <= 0) continue;
    const k = 255 / a;
    out[i] = acc[i] * k;
    out[i + 1] = acc[i + 1] * k;
    out[i + 2] = acc[i + 2] * k;
    out[i + 3] = a * 255;
  }
  return out;
}

/** Merges the layer into the one below it, keeping the lower layer's identity. */
export function mergeDown(d: Doc, id: string): Doc {
  const i = layerIndex(d, id);
  if (i <= 0) return d;
  const below = d.layers[i - 1];
  const top = d.layers[i];
  // Merge over the union of both layers' tiles, which may extend past the canvas.
  const area = union(tileGridBounds(below.tiles), tileGridBounds(top.tiles));
  const merged = flatten(d, area, [{ ...below, opacity: 1, visible: true, blendMode: "normal" }, top]);
  const w = tileWriter(EMPTY_TILES);
  for (const [tx, ty] of tilesIn(area)) {
    const part = tileRect(tx, ty);
    const t = w.writable(tx, ty);
    for (let y = 0; y < TILE_SIZE; y++) {
      const src = ((part.y + y - area.y) * area.w + (part.x - area.x)) * 4;
      t.data.set(merged.subarray(src, src + TILE_SIZE * 4), y * TILE_SIZE * 4);
    }
  }
  const layers = [...d.layers];
  layers.splice(i - 1, 2, { ...below, tiles: w.finish() });
  return { ...d, layers, activeLayerId: below.id };
}
