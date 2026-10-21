import { createLayer, newSourceId, type Doc, type Layer, type LayerContent, type Placement, type SmartSource } from "./document";
import { rect, vec, type Rect, type Vec2 } from "./geometry";
import { transformFloatingCpu, type Floating } from "./raster";
import type { Filter } from "./rasterize";
import { renderShape, type ShapeGeometry, type ShapeStyle } from "./shape";
import type { Pixels } from "./pixels";
import type { TransformState } from "./transform";
import { evalPatch, invert3, isIdentityPatch, project, quadOf, reparameterizePatch, squareToQuad, type Mapping, type Quad } from "./warp";

/** Commit-quality resampling, clipped to `clip` if given (layers may extend past the canvas). */
export type Resample = (f: Floating, m: Mapping, filter: Filter, clip?: Rect) => Promise<Pixels>;
/** A shape's pixels, clipped to `clip`. */
export type ShapeRasterizer = (g: ShapeGeometry, style: ShapeStyle, m: Mapping, clip: Rect) => Promise<Pixels>;

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

/** Samples per side when measuring a warped surface's extent. */
const WARP_SAMPLES = 48;

/**
 * The same placement, framed by what it actually covers. A warp can carry
 * content outside its quad (the box before warping), so transform controls
 * on the quad wouldn't hug what's on screen. With an affine quad, the frame
 * is re-based onto the warped content's tight bounds in the box's own
 * orientation, and the warp re-expressed in it — the same mapping, exactly
 * (affine maps commute with Bézier control points). Unwarped and
 * perspective placements are returned as they are.
 */
export function framedPlacement(p: Placement): Placement {
  if (!p.patch || isIdentityPatch(p.patch)) return p;
  const H = squareToQuad(p.quad);
  if (!H || Math.abs(H[6]) > 1e-12 || Math.abs(H[7]) > 1e-12) return p;
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  // Extent in the box's frame (rotated by -angle).
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j <= WARP_SAMPLES; j++)
    for (let i = 0; i <= WARP_SAMPLES; i++) {
      const u = evalPatch(p.patch, i / WARP_SAMPLES, j / WARP_SAMPLES);
      const q = project(H, u.x, u.y);
      const x = q.x * c + q.y * s, y = -q.x * s + q.y * c;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  if (!(x1 - x0 > 1e-9 && y1 - y0 > 1e-9)) return p;
  const back = (x: number, y: number) => vec(x * c - y * s, x * s + y * c);
  const quad: Quad = [back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)];
  const inv = invert3(squareToQuad(quad)!)!;
  // patch'(s, t) = H'⁻¹(H(patch(s, t))): an affine map, applied to the control points.
  const patch = p.patch.map((u) => {
    const q = project(H, u.x, u.y);
    return project(inv, q.x, q.y);
  });
  return { ...p, quad, patch };
}

/** A transform state over a placement as it is, pivoting about its centre. */
export function placementState(p: Placement): TransformState {
  const H = squareToQuad(p.quad)!;
  return { ...p, reference: project(H, 0.5, 0.5) };
}

/** A transform state framed by the placement's content (see {@link framedPlacement}): what controls show and Free Transform edits. */
export const framedState = (p: Placement): TransformState => placementState(framedPlacement(p));

export const toPlacement = (s: TransformState): Placement => ({ source: s.source, quad: s.quad, angle: s.angle, patch: s.patch });

export const sourceFloating = (s: SmartSource): Floating => ({ pixels: s.pixels, bounds: rect(0, 0, s.width, s.height) });

/** Content rendered through a placement: smart objects and shapes. */
export type PlacedContent = Extract<LayerContent, { kind: "smart" | "shape" }>;
export const isPlaced = (c: LayerContent): c is PlacedContent => c.kind === "smart" || c.kind === "shape";

/** Renders placed content through its placement, clipped to the canvas (null for anything else). */
export async function renderContent(content: LayerContent, clip: Rect, r: Rasterizers, filter: Filter = "bicubic"): Promise<Pixels | null> {
  switch (content.kind) {
    case "pixels":
    case "group":
    case "adjustment":
      return null;
    case "shape":
      return r.shape(content.geometry, content.style, placementMapping(content.placement), clip);
    case "smart":
      return r.resample(sourceFloating(content.source), placementMapping(content.placement), filter, clip);
  }
}

/** The layer with new content, re-rendered. */
export async function withContent(layer: Layer, content: LayerContent, clip: Rect, r: Rasterizers, filter?: Filter): Promise<Layer> {
  const pixels = await renderContent(content, clip, r, filter);
  return { ...layer, content, pixels: pixels ?? layer.pixels };
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

export const smartSource = (name: string, width: number, height: number, pixels: Pixels, file: SmartSource["file"] = null): SmartSource => ({
  id: newSourceId(),
  name,
  width,
  height,
  pixels,
  file,
});

/**
 * If `next` is `prev` moved by whole pixels (a multiple of `step`), the
 * move; else null: same content otherwise, same source and warp, every
 * corner shifted alike. Lets renderers move what they've already
 * rasterized instead of rasterizing again.
 */
export function wholePixelMove<C extends Extract<LayerContent, { placement: Placement }>>(prev: C, next: C, step = 1): Vec2 | null {
  if (prev === next) return { x: 0, y: 0 };
  // Everything but the placement must be the very same (contents are immutable, so identity is equality).
  for (const k of Object.keys(next) as (keyof C)[]) if (k !== "placement" && prev[k] !== next[k]) return null;
  const a = prev.placement, b = next.placement;
  if (a.source.x !== b.source.x || a.source.y !== b.source.y || a.source.w !== b.source.w || a.source.h !== b.source.h) return null;
  if (a.patch !== b.patch && !(a.patch && b.patch && a.patch.every((p, i) => p.x === b.patch![i].x && p.y === b.patch![i].y))) return null;
  const dx = b.quad[0].x - a.quad[0].x, dy = b.quad[0].y - a.quad[0].y;
  const rx = Math.round(dx), ry = Math.round(dy);
  if (Math.abs(dx - rx) > 1e-6 || Math.abs(dy - ry) > 1e-6 || rx % step !== 0 || ry % step !== 0) return null;
  for (let i = 1; i < 4; i++) {
    if (Math.abs(b.quad[i].x - a.quad[i].x - dx) > 1e-6 || Math.abs(b.quad[i].y - a.quad[i].y - dy) > 1e-6) return null;
  }
  return { x: rx, y: ry };
}
