import { withContent, type Rasterizers } from "./content";
import { flatten, type Doc, type Layer, type LayerContent, type Placement } from "./document";
import { apply, integerTranslation, intersect, invert, multiply, rect, roundOut, scaling, transformRect, translation, type Mat, type Rect } from "./geometry";
import type { Filter } from "./rasterize";
import { transformMask, translateMask } from "./selection";
import { EMPTY_TILES, contentBounds, translateTiles } from "./tiles";

/**
 * A change to the whole document as an affine map of its space: Canvas
 * Size (a translation), Image Size (a scale) and, later, Rotate/Flip Canvas
 * and Crop. Every kind of layer content says how it follows one, so new
 * kinds (text, effects) only need an entry in {@link CONTENT_TRANSFORMS}.
 */
export interface DocTransform {
  /** Old document space → new. */
  readonly matrix: Mat;
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
   * Only the result within the new canvas is needed (previews): pixel layers
   * resample just the part of their content that lands on it. Otherwise
   * layers keep everything, off-canvas content included.
   */
  readonly clipToCanvas?: boolean;
}

/**
 * Placements map their source box through a homography given by the quad;
 * composing an affine map onto that is exactly the quad's corners mapped.
 * Warps apply before the homography, so they're untouched. The orientation
 * follows the box's top edge.
 */
export function transformPlacement(p: Placement, m: Mat): Placement {
  const [a, b, c, d] = p.quad.map((q) => apply(m, q));
  const dir = apply([m[0], m[1], m[2], m[3], 0, 0], { x: Math.cos(p.angle), y: Math.sin(p.angle) });
  return { ...p, quad: [a, b, c, d], angle: Math.atan2(dir.y, dir.x) };
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
  if (l.content.kind !== "pixels") return withContent(l, transformContent(l.content, t), clip, r, t.filter);
  const shift = integerTranslation(t.matrix);
  if (shift) return { ...l, tiles: translateTiles(l.tiles, shift.x, shift.y) };
  let bounds = contentBounds(l.tiles);
  if (t.clipToCanvas) {
    // The source that lands on the canvas, with room for the filter's support (wider when reducing).
    const src = transformRect(invert(t.matrix), clip);
    const k = Math.max(Math.hypot(t.matrix[0], t.matrix[1]), Math.hypot(t.matrix[2], t.matrix[3]));
    const pad = Math.ceil(Math.max(3, 3 / k));
    bounds = intersect(bounds, roundOut(rect(src.x - pad, src.y - pad, src.w + pad * 2, src.h + pad * 2)));
  }
  if (bounds.w <= 0 || bounds.h <= 0) return { ...l, tiles: EMPTY_TILES };
  const corners = [
    apply(t.matrix, { x: bounds.x, y: bounds.y }),
    apply(t.matrix, { x: bounds.x + bounds.w, y: bounds.y }),
    apply(t.matrix, { x: bounds.x + bounds.w, y: bounds.y + bounds.h }),
    apply(t.matrix, { x: bounds.x, y: bounds.y + bounds.h }),
  ] as const;
  const tiles = await r.resample({ tiles: l.tiles, bounds }, { source: bounds, quad: corners, patch: null }, t.filter, t.clipToCanvas ? clip : undefined);
  return { ...l, tiles };
}

/** The whole document through a transform: every layer, the selection, the canvas and resolution. */
export async function transformDocument(doc: Doc, t: DocTransform, r: Rasterizers): Promise<Doc> {
  const layers = await Promise.all(doc.layers.map((l) => transformLayer(l, t, r)));
  const sel = doc.selection && { ...doc.selection, width: t.width, height: t.height };
  const shift = integerTranslation(t.matrix);
  const selection =
    sel &&
    (shift
      ? translateMask(sel, shift.x, shift.y)
      : transformMask(sel, {
          source: sel.bounds,
          quad: [
            apply(t.matrix, { x: sel.bounds.x, y: sel.bounds.y }),
            apply(t.matrix, { x: sel.bounds.x + sel.bounds.w, y: sel.bounds.y }),
            apply(t.matrix, { x: sel.bounds.x + sel.bounds.w, y: sel.bounds.y + sel.bounds.h }),
            apply(t.matrix, { x: sel.bounds.x, y: sel.bounds.y + sel.bounds.h }),
          ],
          patch: null,
        }));
  return { ...doc, width: t.width, height: t.height, layers, selection, resolution: t.resolution ?? doc.resolution };
}

/** Where existing content sits within a resized canvas: 0, ½ or 1 of the added (or removed) space on each axis. */
export interface Anchor {
  readonly x: 0 | 0.5 | 1;
  readonly y: 0 | 0.5 | 1;
}

/**
 * Image ▸ Canvas Size: a new canvas with the content placed by `anchor`.
 * Layers keep everything, including what falls outside the new canvas.
 */
export function resizeCanvas(doc: Doc, width: number, height: number, anchor: Anchor, r: Rasterizers): Promise<Doc> {
  const dx = Math.round((width - doc.width) * anchor.x);
  const dy = Math.round((height - doc.height) * anchor.y);
  return transformDocument(doc, { matrix: translation(dx, dy), width, height, lengthScale: 1, filter: "nearest" }, r);
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
    { matrix: scaling(sx, sy), width: o.width, height: o.height, lengthScale, filter: o.filter, resolution: o.resolution },
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
    { matrix, width, height, lengthScale: lengthScale * scale, filter: o.filter, clipToCanvas: true },
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
