import { createLayer, newSourceId, type Doc, type Layer, type LayerContent, type Placement, type SmartSource } from "./document";
import { rect, vec, type Rect } from "./geometry";
import { translateMask } from "./selection";
import type { Floating } from "./raster";
import type { Filter } from "./rasterize";
import { renderShape } from "./shape";
import { translateTiles, type TileMap } from "./tiles";
import type { TransformState } from "./transform";
import { project, quadOf, reparameterizePatch, squareToQuad, type Mapping, type Quad } from "./warp";

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



/** Where existing content sits within a resized canvas: 0, ½ or 1 of the added (or removed) space on each axis. */
export interface Anchor {
  readonly x: 0 | 0.5 | 1;
  readonly y: 0 | 0.5 | 1;
}

/**
 * Image ▸ Canvas Size: a new canvas with the content placed by `anchor`.
 * Layers keep everything, including what falls outside the new canvas;
 * smart objects and shapes move their placement and re-render.
 */
export async function resizeCanvas(doc: Doc, width: number, height: number, anchor: Anchor, resample: Resample): Promise<Doc> {
  const dx = Math.round((width - doc.width) * anchor.x);
  const dy = Math.round((height - doc.height) * anchor.y);
  const clip = rect(0, 0, width, height);
  const layers = await Promise.all(
    doc.layers.map((l) => {
      if (l.content.kind === "pixels") return { ...l, tiles: translateTiles(l.tiles, dx, dy) };
      const { placement } = l.content;
      const [a, b, c, d] = placement.quad.map((p) => vec(p.x + dx, p.y + dy));
      const moved = { ...placement, quad: [a, b, c, d] as const };
      return withContent(l, { ...l.content, placement: moved }, clip, resample);
    }),
  );
  const sel = doc.selection;
  const selection = sel && translateMask({ ...sel, width, height, bounds: rect(sel.bounds.x + dx, sel.bounds.y + dy, sel.bounds.w, sel.bounds.h) }, 0, 0);
  return { ...doc, width, height, layers, selection };
}
