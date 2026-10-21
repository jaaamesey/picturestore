import type { Doc, Layer, LayerContent, SmartSource } from "../core/document";
import type { Tile, TileKey, TileMap } from "../core/tiles";

/**
 * Documents as sent to the preview worker: tiles by id instead of by value.
 * Tiles are immutable, so each is copied to the worker once and referenced
 * by id after that.
 */
export type WireTiles = readonly (readonly [key: TileKey, id: number])[];
export type WireSource = Omit<SmartSource, "tiles" | "file"> & { readonly tiles: WireTiles };
export type WireContent = Exclude<LayerContent, { kind: "smart" }> | (Omit<Extract<LayerContent, { kind: "smart" }>, "source"> & { readonly source: WireSource });
export type WireLayer = Omit<Layer, "tiles" | "content"> & { readonly tiles: WireTiles; readonly content: WireContent };
export type WireDoc = Omit<Doc, "layers" | "selection"> & { readonly layers: readonly WireLayer[] };

/** Encodes a document, calling `tileId` for each tile (which records tiles the worker doesn't have yet). */
export function toWire(doc: Doc, tileId: (t: Tile) => number): WireDoc {
  const tiles = (m: TileMap): WireTiles => [...m].map(([k, t]) => [k, tileId(t)] as const);
  const content = (c: LayerContent): WireContent => {
    if (c.kind !== "smart") return c;
    const { tiles: t, file: _file, ...rest } = c.source;
    return { ...c, source: { ...rest, tiles: tiles(t) } };
  };
  const { layers, selection: _selection, ...rest } = doc;
  return { ...rest, layers: layers.map((l) => ({ ...l, tiles: tiles(l.tiles), content: content(l.content) })) };
}

/** Decodes a document from tiles the worker holds. */
export function fromWire(w: WireDoc, tile: (id: number) => Tile): Doc {
  const tiles = (t: WireTiles): TileMap => new Map(t.map(([k, id]) => [k, tile(id)]));
  const content = (c: WireContent): LayerContent =>
    c.kind === "smart" ? { ...c, source: { ...c.source, tiles: tiles(c.source.tiles), file: null } } : c;
  return {
    ...w,
    selection: null,
    layers: w.layers.map((l) => ({ ...l, tiles: tiles(l.tiles), content: content(l.content) })),
  };
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
