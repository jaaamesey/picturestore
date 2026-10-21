import { createLayer, newSourceId, type Doc, type Layer, type LayerContent, type Placement, type SmartSource } from "./document";
import { rect, type Rect } from "./geometry";
import type { Floating } from "./raster";
import type { Filter } from "./rasterize";
import { renderShape } from "./shape";
import type { TileMap } from "./tiles";
import type { TransformState } from "./transform";
import { project, quadOf, squareToQuad, type Mapping } from "./warp";

/** Commit-quality resampling (GPU in the app, CPU reference in tests), clipped to `clip`. */
export type Resample = (f: Floating, m: Mapping, filter: Filter, clip: Rect) => Promise<TileMap>;

export const placementMapping = (p: Placement): Mapping => ({ source: p.source, quad: p.quad, patch: p.patch });

/** A Free Transform session over an existing placement, pivoting about its centre. */
export function placementState(p: Placement): TransformState {
  const H = squareToQuad(p.quad)!;
  return { ...p, reference: project(H, 0.5, 0.5) };
}

export const toPlacement = (s: TransformState): Placement => ({ source: s.source, quad: s.quad, angle: s.angle, patch: s.patch });

export const sourceFloating = (s: SmartSource): Floating => ({ tiles: s.tiles, bounds: rect(0, 0, s.width, s.height) });

/** Renders non-pixel content through its placement, clipped to the canvas. */
export async function renderContent(content: LayerContent, clip: Rect, resample: Resample, filter: Filter = "bicubic"): Promise<TileMap | null> {
  switch (content.kind) {
    case "pixels":
      return null;
    case "shape":
      return renderShape(content.geometry, content.style, placementMapping(content.placement), clip);
    case "smart":
      return resample(sourceFloating(content.source), placementMapping(content.placement), filter, clip);
  }
}

/** The layer with new content, re-rendered. */
export async function withContent(layer: Layer, content: LayerContent, clip: Rect, resample: Resample, filter?: Filter): Promise<Layer> {
  const tiles = await renderContent(content, clip, resample, filter);
  return { ...layer, content, tiles: tiles ?? layer.tiles };
}

/**
 * Photoshop's placing default: centred, and scaled down to fit the canvas
 * when larger ("Resize image during place").
 */
export function initialPlacement(width: number, height: number, docW: number, docH: number): Placement {
  const k = Math.min(1, docW / width, docH / height);
  const w = width * k, h = height * k;
  return {
    source: rect(0, 0, width, height),
    quad: quadOf(rect((docW - w) / 2, (docH - h) / 2, w, h)),
    angle: 0,
    patch: null,
  };
}

/** A new smart object layer for a decoded image. */
export async function smartObjectLayer(doc: Doc, source: SmartSource, resample: Resample, placement?: Placement): Promise<Layer> {
  const p = placement ?? initialPlacement(source.width, source.height, doc.width, doc.height);
  const layer = createLayer({ name: source.name });
  return withContent(layer, { kind: "smart", source, placement: p }, rect(0, 0, doc.width, doc.height), resample);
}

export const smartSource = (name: string, width: number, height: number, tiles: TileMap, file: SmartSource["file"] = null): SmartSource => ({
  id: newSourceId(),
  name,
  width,
  height,
  tiles,
  file,
});


