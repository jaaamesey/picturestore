import { withContent, type Rasterizers } from "./content";
import { PIXELS, flatten, type Doc, type Layer, type LayerContent, type Placement } from "./document";
import { boundsOf, integerTranslation, intersect, multiply, rect, rectCorners, roundOut, scaling, translation, type Mat, type Rect, type Vec2 } from "./geometry";
import type { Filter } from "./rasterize";
import { transformMask, translateMask } from "./selection";
import { EMPTY_TILES, clipTiles, contentBounds, translateTiles } from "./tiles";
import { transformGuides } from "./snap";
import { invert3, isConvex, project, type Mat3, type Quad } from "./warp";

/**
 * A change to the whole document as a projective map of its space: Canvas
 * Size (a translation), Image Size (a scale), Crop (a rotation, and a scale
 * for a fixed output size), Perspective Crop (a homography) and, later,
 * Rotate/Flip Canvas. Every kind of layer content says how it follows one,
 * so new kinds (text, effects) only need an entry in {@link CONTENT_TRANSFORMS}.
 */
export interface DocTransform {
  /** Old document space → new. */
  readonly matrix: Mat3;
  readonly width: number;
  readonly height: number;
  /**
   * How lengths that belong to content rather than geometry scale: stroke
   * widths now; effect sizes and the like later. Image Size's "Scale Styles"
   * (proportional resizes only); 1 leaves them as they are.
   */
  readonly lengthScale: number;
  /** Resampling for pixel layers (whole-pixel translations are exact copies regardless). */
  readonly filter: Filter;
  readonly resolution?: number;
  /**
   * Pixel layers keep only what lands on the new canvas (previews, which
   * then resample just that part; Crop's Delete Cropped Pixels). Otherwise
   * they keep everything, off-canvas content included. Smart objects and
   * shapes always keep all their content.
   */
  readonly clipToCanvas?: boolean;
}

/** An affine {@link Mat} as a {@link Mat3}. */
export const affine3 = ([a, b, c, d, e, f]: Mat): Mat3 => [a, c, e, b, d, f, 0, 0, 1];

/** The affine part of `m`, or null when it has perspective. */
export const asAffine = (m: Mat3, eps = 1e-12): Mat | null =>
  Math.abs(m[6]) > eps || Math.abs(m[7]) > eps ? null : [m[0] / m[8], m[3] / m[8], m[1] / m[8], m[4] / m[8], m[2] / m[8], m[5] / m[8]];

export const mapPoint = (m: Mat3, p: Vec2): Vec2 => project(m, p.x, p.y);
const mapRect = (m: Mat3, r: Rect): Quad => rectCorners(r).map((p) => mapPoint(m, p)) as unknown as Quad;

/**
 * Placements map their source box through a homography given by the quad;
 * composing a projective map onto that is exactly the quad's corners mapped.
 * Warps apply before the homography, so they're untouched. The orientation
 * follows the box's top edge.
 */
export function transformPlacement(p: Placement, m: Mat3): Placement {
  const [a, b, c, d] = p.quad.map((q) => mapPoint(m, q));
  // Where the orientation points, at the quad's centre (any point, for an affine map).
  const o = { x: (p.quad[0].x + p.quad[2].x) / 2, y: (p.quad[0].y + p.quad[2].y) / 2 };
  const mo = mapPoint(m, o), md = mapPoint(m, { x: o.x + Math.cos(p.angle), y: o.y + Math.sin(p.angle) });
  return { ...p, quad: [a, b, c, d], angle: Math.atan2(md.y - mo.y, md.x - mo.x) };
}

type NonRaster = Exclude<LayerContent, { kind: "pixels" }>;

/** How each kind of non-raster content follows a document transform. */
const CONTENT_TRANSFORMS: { readonly [K in NonRaster["kind"]]: (c: Extract<NonRaster, { kind: K }>, t: DocTransform) => Extract<NonRaster, { kind: K }> } = {
  smart: (c, t) => ({ ...c, placement: transformPlacement(c.placement, t.matrix) }),
  shape: (c, t) => ({
    ...c,
    placement: transformPlacement(c.placement, t.matrix),
    style: c.style.stroke && t.lengthScale !== 1 ? { ...c.style, stroke: { ...c.style.stroke, width: c.style.stroke.width * t.lengthScale } } : c.style,
  }),
};

export function transformContent(c: NonRaster, t: DocTransform): NonRaster {
  return (CONTENT_TRANSFORMS[c.kind] as (c: NonRaster, t: DocTransform) => NonRaster)(c, t);
}

/**
 * One layer through a document transform. Pixel layers are resampled
 * (everything they hold, including what's off the canvas); non-raster
 * content is transformed exactly and re-rendered for the new canvas.
 */
export async function transformLayer(l: Layer, t: DocTransform, r: Rasterizers): Promise<Layer> {
  const clip = rect(0, 0, t.width, t.height);
  if (l.content.kind !== "pixels") {
    const content = transformContent(l.content, t);
    // Content crossing a perspective's horizon has no exact transform: it's rasterized, as it looks.
    if (isConvex(content.placement.quad)) return withContent(l, content, clip, r, t.filter);
    l = { ...l, content: PIXELS };
  }
  const affine = asAffine(t.matrix);
  const shift = affine && integerTranslation(affine);
  if (shift) {
    const tiles = translateTiles(l.tiles, shift.x, shift.y);
    return { ...l, tiles: t.clipToCanvas ? clipTiles(tiles, clip) : tiles };
  }
  let bounds = contentBounds(l.tiles);
  if (t.clipToCanvas && affine) {
    // The source that lands on the canvas, with room for the filter's support (wider when reducing).
    const src = boundsOf(mapRect(invert3(t.matrix)!, clip));
    const k = Math.max(Math.hypot(affine[0], affine[1]), Math.hypot(affine[2], affine[3]));
    const pad = Math.ceil(Math.max(3, 3 / k));
    bounds = intersect(bounds, roundOut(rect(src.x - pad, src.y - pad, src.w + pad * 2, src.h + pad * 2)));
  }
  if (bounds.w <= 0 || bounds.h <= 0) return { ...l, tiles: EMPTY_TILES };
  // Under perspective only the canvas is kept: content beyond the horizon has nowhere to go.
  const clipTo = t.clipToCanvas || !affine ? clip : undefined;
  const tiles = await r.resample({ tiles: l.tiles, bounds }, { source: bounds, quad: mapRect(t.matrix, bounds), patch: null }, t.filter, clipTo);
  return { ...l, tiles };
}

/** The whole document through a transform: every layer, the selection, the canvas and resolution. */
export async function transformDocument(doc: Doc, t: DocTransform, r: Rasterizers): Promise<Doc> {
  const layers = await Promise.all(doc.layers.map((l) => transformLayer(l, t, r)));
  const sel = doc.selection && { ...doc.selection, width: t.width, height: t.height };
  const affine = asAffine(t.matrix);
  const shift = affine && integerTranslation(affine);
  const selection =
    sel &&
    (shift
      ? translateMask(sel, shift.x, shift.y)
      : transformMask(sel, {
          source: sel.bounds,
          quad: mapRect(t.matrix, sel.bounds),
          patch: null,
        }));
  const guides = transformGuides(doc.guides, t.matrix);
  return { ...doc, width: t.width, height: t.height, layers, selection, resolution: t.resolution ?? doc.resolution, guides };
}

/** Where existing content sits within a resized canvas: 0, ½ or 1 of the added (or removed) space on each axis. */
export interface Anchor {
  readonly x: 0 | 0.5 | 1;
  readonly y: 0 | 0.5 | 1;
}

/** Where existing content moves to (whole pixels) in a canvas resized around `anchor`. */
export const canvasOffset = (doc: Pick<Doc, "width" | "height">, width: number, height: number, anchor: Anchor) => ({
  x: Math.round((width - doc.width) * anchor.x),
  y: Math.round((height - doc.height) * anchor.y),
});

/**
 * Image ▸ Canvas Size: a new canvas with the content placed by `anchor`.
 * Layers keep everything, including what falls outside the new canvas.
 */
export function resizeCanvas(doc: Doc, width: number, height: number, anchor: Anchor, r: Rasterizers): Promise<Doc> {
  const { x: dx, y: dy } = canvasOffset(doc, width, height, anchor);
  return transformDocument(doc, { matrix: affine3(translation(dx, dy)), width, height, lengthScale: 1, filter: "nearest" }, r);
}

export interface ImageSizeOptions {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly filter: Filter;
  /**
   * Photoshop's "Scale Styles": lengths inside content (stroke widths,
   * later effects) scale with the image. Only meaningful for proportional
   * resizes, as in Photoshop.
   */
  readonly scaleStyles: boolean;
}

/**
 * Image ▸ Image Size with Resample: everything scales — pixel layers are
 * resampled, smart objects and shapes are scaled exactly as vectors and
 * re-rendered (smart objects from their full-resolution contents), and the
 * selection follows. Without resampling only the resolution changes (see
 * {@link setResolution}).
 */
export function imageSize(doc: Doc, o: ImageSizeOptions, r: Rasterizers): Promise<Doc> {
  const { sx, sy, lengthScale } = imageSizeScales(doc, o);
  return transformDocument(
    doc,
    { matrix: affine3(scaling(sx, sy)), width: o.width, height: o.height, lengthScale, filter: o.filter, resolution: o.resolution },
    r,
  );
}

/** The scale factors of an Image Size, and how lengths in content follow (Scale Styles; proportional resizes only). */
function imageSizeScales(doc: Doc, o: Pick<ImageSizeOptions, "width" | "height" | "scaleStyles">) {
  const sx = o.width / doc.width, sy = o.height / doc.height;
  // Rounding to whole pixels makes a constrained resize very slightly non-uniform.
  const proportional = Math.abs(sx - sy) <= 1.01 / Math.min(doc.width, doc.height);
  return { sx, sy, lengthScale: o.scaleStyles && proportional ? Math.sqrt(sx * sy) : 1 };
}

/**
 * What Image Size would produce within `window` (a rectangle of the new
 * image), as its own small document, drawn at `scale` (≤ 1: a preview needs
 * no more pixels than its screen area). The real transform, so shapes and
 * smart objects re-render as they will, restricted to the window so the
 * cost depends on the output, not the document.
 */
export function imageSizeWindow(doc: Doc, o: ImageSizeOptions, window: Rect, r: Rasterizers, scale = 1): Promise<Doc> {
  const { sx, sy, lengthScale } = imageSizeScales(doc, o);
  const matrix = multiply(scaling(scale), multiply(translation(-window.x, -window.y), scaling(sx, sy)));
  const width = Math.max(1, Math.round(window.w * scale)), height = Math.max(1, Math.round(window.h * scale));
  return transformDocument(
    { ...doc, selection: null },
    { matrix: affine3(matrix), width, height, lengthScale: lengthScale * scale, filter: o.filter, clipToCanvas: true },
    r,
  );
}

/** A preview of Image Size: `window` of the result, at `scale`, composited (straight RGBA). */
export async function imageSizePreview(
  doc: Doc,
  o: ImageSizeOptions & { readonly resample: boolean },
  window: Rect,
  scale: number,
  r: Rasterizers,
): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
  // Without resampling the pixels stay as they are: the preview shows the document itself.
  const size = o.resample ? o : { ...o, width: doc.width, height: doc.height };
  if (scale === 1 && size.width === doc.width && size.height === doc.height) {
    return { width: window.w, height: window.h, pixels: flatten(doc, window) };
  }
  const part = await imageSizeWindow(doc, size, window, r, scale);
  return { width: part.width, height: part.height, pixels: flatten(part) };
}

/** Image Size without Resample: same pixels, different physical size. */
export const setResolution = (doc: Doc, resolution: number): Doc => ({ ...doc, resolution });
