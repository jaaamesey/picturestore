import { createLayer, newSourceId, type Doc, type Layer, type LayerContent, type Placement, type SmartSource } from "./document";
import { rect, type Rect } from "./geometry";
import { transformFloatingCpu, type Floating } from "./raster";
import type { Filter } from "./rasterize";
import { renderShape, type ShapeGeometry, type ShapeStyle } from "./shape";
import type { TileMap } from "./tiles";
import type { TransformState } from "./transform";
import { project, quadOf, reparameterizePatch, squareToQuad, type Mapping, type Quad } from "./warp";

/** Commit-quality resampling, clipped to `clip` if given (layers may extend past the canvas). */
export type Resample = (f: Floating, m: Mapping, filter: Filter, clip?: Rect) => Promise<TileMap>;
/** A shape's pixels, clipped to `clip`. */
export type ShapeRasterizer = (g: ShapeGeometry, style: ShapeStyle, m: Mapping, clip: Rect) => Promise<TileMap>;

/** How content becomes pixels: on the GPU in the app; {@link CPU_RASTERIZERS} are the reference. */
export interface Rasterizers {
  readonly resample: Resample;
  readonly shape: ShapeRasterizer;
}

/** CPU reference implementations: for tests, GPU parity checks, and fallback. */
export const CPU_RASTERIZERS: Rasterizers = {
  resample: async (f, m, filter, clip) => transformFloatingCpu(f, m, filter, clip),
  shape: async (g, style, m, clip) => renderShape(g, style, m, clip),
};

export const placementMapping = (p: Placement): Mapping => ({ source: p.source, quad: p.quad, patch: p.patch });

/** A Free Transform session over an existing placement, pivoting about its centre. */
export function placementState(p: Placement): TransformState {
  const H = squareToQuad(p.quad)!;
  return { ...p, reference: project(H, 0.5, 0.5) };
}

export const toPlacement = (s: TransformState): Placement => ({ source: s.source, quad: s.quad, angle: s.angle, patch: s.patch });

export const sourceFloating = (s: SmartSource): Floating => ({ tiles: s.tiles, bounds: rect(0, 0, s.width, s.height) });

/** Renders non-pixel content through its placement, clipped to the canvas. */
export async function renderContent(content: LayerContent, clip: Rect, r: Rasterizers, filter: Filter = "bicubic"): Promise<TileMap | null> {
  switch (content.kind) {
    case "pixels":
      return null;
    case "shape":
      return r.shape(content.geometry, content.style, placementMapping(content.placement), clip);
    case "smart":
      return r.resample(sourceFloating(content.source), placementMapping(content.placement), filter, clip);
  }
}

/** The layer with new content, re-rendered. */
export async function withContent(layer: Layer, content: LayerContent, clip: Rect, r: Rasterizers, filter?: Filter): Promise<Layer> {
  const tiles = await renderContent(content, clip, r, filter);
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

/**
 * The placement for contents resized to `width × height` (e.g. Canvas Size
 * inside Edit Contents), as Photoshop does it: the layer's transform is kept
 * — same scale, rotation, skew, perspective and warp — and the new contents
 * are centred where the old ones were, so pixels keep their size on the
 * canvas instead of being stretched into the old frame.
 */
export function resizedPlacement(p: Placement, width: number, height: number): Placement {
  const { w, h } = p.source;
  if (width === w && height === h) return p;
  // The new contents span [s0, s1] × [t0, t1] in the old source's unit square.
  const s0 = (w - width) / 2 / w, s1 = s0 + width / w;
  const t0 = (h - height) / 2 / h, t1 = t0 + height / h;
  const H = squareToQuad(p.quad)!;
  const source = rect(0, 0, width, height);
  if (!p.patch) {
    const quad: Quad = [project(H, s0, t0), project(H, s1, t0), project(H, s1, t1), project(H, s0, t1)];
    return { ...p, source, quad };
  }
  // Warped: re-express the same surface over the new domain. The quad is
  // left as is and the patch (in its unit square) is extended, which keeps
  // the mapping exact.
  return { ...p, source, patch: reparameterizePatch(p.patch, s0, s1, t0, t1) };
}

/** A new smart object layer for a decoded image. */
export async function smartObjectLayer(doc: Doc, source: SmartSource, r: Rasterizers, placement?: Placement): Promise<Layer> {
  const p = placement ?? initialPlacement(source.width, source.height, doc.width, doc.height);
  const layer = createLayer({ name: source.name });
  return withContent(layer, { kind: "smart", source, placement: p }, rect(0, 0, doc.width, doc.height), r);
}

export const smartSource = (name: string, width: number, height: number, tiles: TileMap, file: SmartSource["file"] = null): SmartSource => ({
  id: newSourceId(),
  name,
  width,
  height,
  tiles,
  file,
});
