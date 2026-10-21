import type { Doc, Layer, LayerContent, LayerMask, SmartSource } from "../core/document";
import type { Tile, TileKey, Pixels } from "../core/pixels";

/**
 * Documents as sent to the preview worker: tiles by id instead of by value.
 * Tiles are immutable, so each is copied to the worker once and referenced
 * by id after that.
 */
export type WireTiles = readonly (readonly [key: TileKey, id: number])[];
export type WireSource = Omit<SmartSource, "pixels" | "file"> & { readonly tiles: WireTiles };
export type WireContent =
  | Exclude<LayerContent, { kind: "smart" | "group" }>
  | (Omit<Extract<LayerContent, { kind: "smart" }>, "source"> & { readonly source: WireSource })
  | (Omit<Extract<LayerContent, { kind: "group" }>, "layers"> & { readonly layers: readonly WireLayer[] });
export type WireMask = Omit<LayerMask, "pixels"> & { readonly tiles: WireTiles };
export type WireLayer = Omit<Layer, "pixels" | "content" | "mask"> & { readonly tiles: WireTiles; readonly content: WireContent; readonly mask: WireMask | null };
export type WireDoc = Omit<Doc, "layers" | "selection"> & { readonly layers: readonly WireLayer[] };

/** Encodes a document, calling `tileId` for each tile (which records tiles the worker doesn't have yet). */
export function toWire(doc: Doc, tileId: (t: Tile) => number): WireDoc {
  const tiles = (m: Pixels): WireTiles => [...m].map(([k, t]) => [k, tileId(t)] as const);
  const content = (c: LayerContent): WireContent => {
    if (c.kind === "group") return { ...c, layers: c.layers.map(layer) };
    if (c.kind !== "smart") return c;
    const { pixels: t, file: _file, ...rest } = c.source;
    return { ...c, source: { ...rest, tiles: tiles(t) } };
  };
  const layer = ({ pixels, mask, ...l }: Layer): WireLayer => ({
    ...l,
    tiles: tiles(pixels),
    content: content(l.content),
    mask: mask && (({ pixels: p, ...m }) => ({ ...m, tiles: tiles(p) }))(mask),
  });
  const { layers, selection: _selection, ...rest } = doc;
  return { ...rest, layers: layers.map(layer) };
}

/** Decodes a document from tiles the worker holds. */
export function fromWire(w: WireDoc, tile: (id: number) => Tile): Doc {
  const tiles = (t: WireTiles): Pixels => new Map(t.map(([k, id]) => [k, tile(id)]));
  const content = (c: WireContent): LayerContent =>
    c.kind === "smart" ? { ...c, source: (({ tiles: t, ...s }) => ({ ...s, pixels: tiles(t), file: null }))(c.source) }
    : c.kind === "group" ? { ...c, layers: c.layers.map(layer) }
    : c;
  const layer = ({ tiles: t, mask, ...l }: WireLayer): Layer => ({
    ...l,
    pixels: tiles(t),
    content: content(l.content),
    mask: mask && (({ tiles: mt, ...m }) => ({ ...m, pixels: tiles(mt) }))(mask),
  });
  return { ...w, selection: null, layers: w.layers.map(layer) };
}

export type Request =
  | { readonly op: "tiles"; readonly ids: readonly number[]; readonly data: readonly Uint8ClampedArray[] }
  | {
      readonly op: "render";
      readonly id: number;
      readonly doc: WireDoc;
      readonly options: import("../core/documentTransform").ImageSizeOptions & { readonly resample: boolean };
      readonly window: import("../core/geometry").Rect;
      readonly scale: number;
    }
  | { readonly op: "clear" };

export type Response =
  | { readonly id: number; readonly ok: true; readonly width: number; readonly height: number; readonly pixels: Uint8ClampedArray }
  | { readonly id: number; readonly ok: false; readonly error: string };
