import { KERNELS, type BlendMode } from "./blend";
import type { RGB } from "./color";
import { intersect, isEmpty, rect, union, type Rect } from "./geometry";
import type { Mask } from "./selection";
import type { ShapeGeometry, ShapeStyle } from "./shape";
import type { TransformState } from "./transform";
import {
  EMPTY_TILES,
  TILE_SIZE,
  contentBounds,
  tileGridBounds,
  tileKey,
  tileRect,
  tileWriter,
  tilesIn,
  translateTiles,
  words,
  type TileMap,
} from "./tiles";
import { quadOf } from "./warp";

/** Where a smart object's or shape's source box lands in the document. */
export type Placement = Pick<TransformState, "source" | "quad" | "angle" | "patch">;

/** Embedded smart object contents. Immutable; shared between duplicates of the layer. */
export interface SmartSource {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Source pixels, with the top-left at (0, 0). */
  readonly tiles: TileMap;
  /** The original encoded file (PNG, JPEG, PSD…), embedded verbatim when saving to PSD. */
  readonly file: { readonly bytes: Uint8Array; readonly type: string } | null;
}

/**
 * What a layer is. Pixel layers are edited directly; smart objects and
 * shapes are rendered from a source through a placement, so transforming
 * them never loses quality. `Layer.tiles` always holds the rendered pixels.
 */
export type LayerContent =
  | { readonly kind: "pixels" }
  | { readonly kind: "smart"; readonly source: SmartSource; readonly placement: Placement }
  | { readonly kind: "shape"; readonly geometry: ShapeGeometry; readonly style: ShapeStyle; readonly placement: Placement };

export const PIXELS: LayerContent = { kind: "pixels" };

export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** [0, 1] */
  readonly opacity: number;
  readonly blendMode: BlendMode;
  /** Rendered pixels (for smart objects and shapes, a cache of their content clipped to the canvas). */
  readonly tiles: TileMap;
  readonly content: LayerContent;
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

/** Smart object sources are identified by GUIDs, as PSD requires. */
export const newSourceId = (): string => crypto.randomUUID();

export const docRect = (d: Pick<Doc, "width" | "height">): Rect => rect(0, 0, d.width, d.height);

export function createLayer(props: Partial<Layer> & Pick<Layer, "name">): Layer {
  return { id: newId(), visible: true, opacity: 1, blendMode: "normal", tiles: EMPTY_TILES, content: PIXELS, ...props };
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
/** "Rectangle 1", "Rectangle 2"…: the next free number for layers named after a tool. */
export function numberedName(d: Doc, base: string): string {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`);
  let n = 0;
  for (const l of d.layers) n = Math.max(n, Number(re.exec(l.name)?.[1] ?? 0));
  return `${base} ${n + 1}`;
}

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

/** Moves a layer to sit directly above or below another (as dropped in the Layers panel). */
export function moveLayerRelative(d: Doc, id: string, targetId: string, placement: "above" | "below"): Doc {
  const from = layerIndex(d, id);
  const target = layerIndex(d, targetId);
  if (from < 0 || target < 0 || id === targetId) return d;
  // Index of the target once the moved layer has been taken out; layers are stored bottom to top.
  const t = target - (from < target ? 1 : 0);
  return moveLayer(d, id, placement === "above" ? t + 1 : t);
}

/** Rasterize Layer: keeps the rendered pixels, drops the editable content. */
export function rasterizeLayer(d: Doc, id: string): Doc {
  const l = d.layers.find((x) => x.id === id);
  return l && l.content.kind !== "pixels" ? updateLayer(d, id, { content: PIXELS }) : d;
}

/**
 * Convert to Smart Object: the layer's current pixels become the embedded
 * source, placed exactly where they were.
 */
export function convertToSmartObject(d: Doc, id: string, sourceId = newSourceId()): Doc {
  const l = d.layers.find((x) => x.id === id);
  if (!l || l.content.kind === "smart") return d;
  const b = contentBounds(l.tiles);
  if (isEmpty(b)) return d;
  const source: SmartSource = {
    id: sourceId,
    name: l.name,
    width: b.w,
    height: b.h,
    tiles: translateTiles(l.tiles, -b.x, -b.y),
    file: null,
  };
  const placement: Placement = { source: rect(0, 0, b.w, b.h), quad: quadOf(b), angle: 0, patch: null };
  return updateLayer(d, id, { content: { kind: "smart", source, placement } });
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
  layers.splice(i - 1, 2, { ...below, tiles: w.finish(), content: PIXELS });
  return { ...d, layers, activeLayerId: below.id };
}
