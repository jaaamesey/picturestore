import type { Adjustment } from "./adjustments";
import type { LayerBlendMode } from "./blend";
import type { RGB } from "./color";
import { intersect, isEmpty, rect, type Rect } from "./geometry";
import { allLayers, childrenOf, findLayer, hasPixels, insertAt, isGroup, locate, removeFrom, treeShape, updateIn, type Placement as TreePlacement } from "./layers";
import type { Mask } from "./selection";
import type { ShapeGeometry, ShapeStyle } from "./shape";
import type { TransformState } from "./transform";
import { NO_PIXELS, clipPixels, contentBounds, tileWriter, translatePixels, writeSpans, type Pixels } from "./pixels";
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
  readonly pixels: Pixels;
  /** The original encoded file (PNG, JPEG, PSD…), embedded verbatim when saving to PSD. */
  readonly file: { readonly bytes: Uint8Array; readonly type: string } | null;
}

/**
 * What a layer is. Pixel layers are edited directly; smart objects and
 * shapes are rendered from a source through a placement, so transforming
 * them never loses quality; for these `Layer.pixels` holds the rendered
 * pixels. Groups hold layers (bottom to top); adjustment layers change the
 * colours of what's below them. Neither has pixels of its own.
 */
export type LayerContent =
  | { readonly kind: "pixels" }
  | { readonly kind: "smart"; readonly source: SmartSource; readonly placement: Placement }
  | { readonly kind: "shape"; readonly geometry: ShapeGeometry; readonly style: ShapeStyle; readonly placement: Placement }
  | { readonly kind: "group"; readonly layers: readonly Layer[]; readonly open: boolean }
  | { readonly kind: "adjustment"; readonly adjustment: Adjustment };

/**
 * A layer mask: greyscale coverage, white revealing the layer and black
 * hiding it. Stored as pixels whose grey value (red) over `background`
 * gives the mask, so a mask is painted exactly like a layer; beyond what's
 * stored it's all `background`.
 */
export interface LayerMask {
  readonly pixels: Pixels;
  /** The mask's value where nothing is stored: 255 (reveal) or 0 (hide). */
  readonly background: 0 | 255;
  /** Disabled masks are kept but have no effect (Photoshop's red cross). */
  readonly enabled: boolean;
  /** Linked masks move and transform with their layer. */
  readonly linked: boolean;
  /** Density [0, 1] (default 1, Properties ▸ Masks): how much the mask hides; at 0.5 its black hides half. */
  readonly density?: number;
}

export const PIXELS: LayerContent = { kind: "pixels" };

export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** [0, 1] */
  readonly opacity: number;
  readonly blendMode: LayerBlendMode;
  /** Rendered pixels (for smart objects and shapes, a cache of their content clipped to the canvas; none for groups and adjustments). */
  readonly pixels: Pixels;
  readonly content: LayerContent;
  /** Clipped to the layer below (Create Clipping Mask): shown only where the clipping group's base layer is. */
  readonly clipped: boolean;
  readonly mask: LayerMask | null;
}

/** A guide: a vertical line at x = `position`, or a horizontal one at y, in document pixels (it may lie off the canvas). */
export interface Guide {
  readonly orientation: "vertical" | "horizontal";
  readonly position: number;
}

/**
 * An immutable document snapshot. Every edit produces a new Doc that shares
 * unchanged layers and pixel storage with its predecessor, so history is just a list
 * of snapshots.
 */
export interface Doc {
  readonly width: number;
  readonly height: number;
  /** The top-level layers, bottom to top (groups hold the rest; see `layers.ts`). */
  readonly layers: readonly Layer[];
  readonly activeLayerId: string;
  /** The active layer's mask, not its pixels, is what edits change (its thumbnail was clicked in the Layers panel). */
  readonly maskTargeted?: boolean;
  /** null = nothing selected (operations apply to the whole layer). */
  readonly selection: Mask | null;
  /** Pixels per inch; only affects physical sizes (print, Image Size's units). Default {@link DEFAULT_RESOLUTION}. */
  readonly resolution?: number;
  /** Ruler guides (View ▸ Guides): part of the document, saved with it and undoable. */
  readonly guides?: readonly Guide[];
}

/** Photoshop's default for screen documents. */
export const DEFAULT_RESOLUTION = 72;
export const resolutionOf = (d: Pick<Doc, "resolution">) => d.resolution ?? DEFAULT_RESOLUTION;

let idCounter = 0;
export const newId = () => `l${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** Smart object sources are identified by GUIDs, as PSD requires. */
export const newSourceId = (): string => crypto.randomUUID();

export const docRect = (d: Pick<Doc, "width" | "height">): Rect => rect(0, 0, d.width, d.height);

export function createLayer(props: Partial<Layer> & Pick<Layer, "name">): Layer {
  return { id: newId(), visible: true, opacity: 1, blendMode: "normal", pixels: NO_PIXELS, content: PIXELS, clipped: false, mask: null, ...props };
}

/** A new, expanded group. Groups pass through by default, as in Photoshop. */
export const createGroup = (name: string, layers: readonly Layer[] = []): Layer =>
  createLayer({ name, blendMode: "pass through", content: { kind: "group", layers, open: true } });

/** Reveal All: a white mask. */
export const REVEAL_ALL: LayerMask = { pixels: NO_PIXELS, background: 255, enabled: true, linked: true };
export const HIDE_ALL: LayerMask = { ...REVEAL_ALL, background: 0 };

/** Packs an opaque colour as a little-endian RGBA u32. */
const packOpaque = (c: RGB) => ((255 << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0;

/**
 * Fills `area` with a colour, composited over existing pixels with `opacity`
 * and the selection's coverage. Fully covered opaque spans are written a
 * word at a time.
 */
export function fillPixels(base: Pixels, area: Rect, color: RGB, mask: Mask | null = null, opacity = 1): Pixels {
  const w = tileWriter(base);
  const region = mask ? intersect(area, mask.bounds) : area;
  const word = packOpaque(color);
  if (!mask && opacity >= 1) {
    writeSpans(w, region, (_d, i, _x, _y, n, u) => u.fill(word, i >> 2, (i >> 2) + n));
    return w.finish();
  }
  const mb = mask?.bounds;
  writeSpans(w, region, (d, i, x, y, n) => blendColorSpan(d, i, n, color, opacity, mask ? mask.data : null, mb ? (y - mb.y) * mb.w + (x - mb.x) : 0));
  return w.finish();
}

/** Composites `color` over `n` pixels from byte `i` of `d`, at `opacity` times the coverage in `mask` from index `m`. */
export function blendColorSpan(d: Uint8ClampedArray, i: number, n: number, color: RGB, opacity: number, mask: Uint8Array | null, m: number) {
  const { r, g, b } = color;
  for (let end = i + n * 4; i < end; i += 4, m++) {
    const a = mask ? opacity * mask[m] * INV255 : opacity;
    if (a <= 0) continue;
    const da = d[i + 3] * INV255;
    const oa = a + da * (1 - a);
    const keep = (da * (1 - a)) / oa;
    const add = a / oa;
    d[i] = r * add + d[i] * keep;
    d[i + 1] = g * add + d[i + 1] * keep;
    d[i + 2] = b * add + d[i + 2] * keep;
    d[i + 3] = oa * 255;
  }
}

/** Erases pixels under `mask` (or everything). */
export function clearPixels(base: Pixels, mask: Mask | null): Pixels {
  return mask ? maskPixels(base, mask, "outside") : NO_PIXELS;
}

/**
 * Keeps pixels by the mask's coverage: "inside" scales alpha by it (what a
 * selection lifts), "outside" by its inverse (what's left behind).
 */
export function maskPixels(base: Pixels, mask: Mask, keep: "inside" | "outside"): Pixels {
  const b = mask.bounds;
  // Inside, nothing beyond the mask survives.
  const w = tileWriter(keep === "inside" ? clipPixels(base, b) : base);
  writeSpans(
    w,
    b,
    (d, i, x0, y, n) => {
      const mrow = (y - b.y) * b.w - b.x;
      for (let x = x0, a = i + 3; x < x0 + n; x++, a += 4) {
        const m = keep === "inside" ? mask.data[mrow + x] : 255 - mask.data[mrow + x];
        if (m !== 255) d[a] = (d[a] * m) / 255;
      }
    },
    { stored: true },
  );
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
    pixels: background ? fillPixels(NO_PIXELS, rect(0, 0, width, height), background) : NO_PIXELS,
  });
  return { width, height, layers: [layer], activeLayerId: layer.id, selection: null };
}

export const activeLayer = (d: Doc): Layer | undefined => findLayer(d.layers, d.activeLayerId);
export const layerById = (d: Doc, id: string): Layer | undefined => findLayer(d.layers, id);

export function updateLayer(d: Doc, id: string, patch: Partial<Omit<Layer, "id">>): Doc {
  return { ...d, layers: updateIn(d.layers, id, (l) => ({ ...l, ...patch })) };
}

/**
 * What pixel edits (painting, fills, Move, Free Transform) change: the
 * active layer's mask when it's targeted, or always for groups and
 * adjustment layers that have one (they have no pixels of their own);
 * otherwise the layer's pixels (whether they can be edited directly is the
 * caller's question: smart objects and shapes must be rasterized first).
 */
export interface EditTarget {
  readonly layer: Layer;
  readonly mask: boolean;
  readonly pixels: Pixels;
}

export function editTarget(d: Doc): EditTarget | null {
  const layer = activeLayer(d);
  if (!layer) return null;
  if (layer.mask && (d.maskTargeted || !hasPixels(layer))) return { layer, mask: true, pixels: layer.mask.pixels };
  return { layer, mask: false, pixels: layer.pixels };
}

/** The document with the edit target's pixels replaced. */
export const withTargetPixels = (d: Doc, t: EditTarget, pixels: Pixels): Doc =>
  updateLayer(d, t.layer.id, t.mask ? { mask: { ...t.layer.mask!, pixels } } : { pixels });

/** A colour as painted onto a mask: its grey (luminosity), as Photoshop shows the swatches while a mask is targeted. */
export function maskTone({ r, g, b }: RGB): RGB {
  const v = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
  return { r: v, g: v, b: v };
}

/** Next free "Layer N" name. */
export function nextLayerName(d: Doc): string {
  const used = new Set(allLayers(d.layers).map((l) => l.name));
  let n = 1;
  while (used.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}

/** "Rectangle 1", "Rectangle 2"…: the next free number for layers named after a tool. */
export function numberedName(d: Doc, base: string): string {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`);
  let n = 0;
  for (const l of allLayers(d.layers)) n = Math.max(n, Number(re.exec(l.name)?.[1] ?? 0));
  return `${base} ${n + 1}`;
}

/**
 * Places a layer that's just been inserted or moved: one landing inside a
 * clipping group (under a clipped layer) joins it, as in Photoshop; a
 * clipped layer landing outside any is released.
 */
function settleClipping(layers: readonly Layer[], id: string): readonly Layer[] {
  const p = locate(layers, id)!;
  const l = p.siblings[p.index];
  const above = p.siblings[p.index + 1], below = p.siblings[p.index - 1];
  const clipped = !!above?.clipped || (l.clipped && !!below && (below.clipped || false));
  return clipped === l.clipped ? layers : updateIn(layers, id, (x) => ({ ...x, clipped }));
}

/**
 * Inserts `layer` relative to `targetId` and makes it active. Without a
 * placement it goes where Photoshop puts new layers: above the active
 * layer, or at the top of the active group.
 */
export function addLayer(d: Doc, layer: Layer = createLayer({ name: nextLayerName(d) }), targetId = d.activeLayerId, placement?: TreePlacement): Doc {
  const target = findLayer(d.layers, targetId);
  const where = placement ?? (target && isGroup(target) ? "inside" : "above");
  const layers = insertAt(d.layers, layer, target ? targetId : null, where);
  return { ...d, layers: layer.clipped ? layers : settleClipping(layers, layer.id), activeLayerId: layer.id };
}

/** Deletes a layer (a group with its contents). The document always keeps at least one layer. */
export function removeLayer(d: Doc, id: string): Doc {
  const p = locate(d.layers, id);
  if (!p || (!p.parent && d.layers.length <= 1)) return d;
  const layers = removeFrom(d.layers, id);
  const stillThere = findLayer(layers, d.activeLayerId);
  if (stillThere) return { ...d, layers };
  // The next active layer: the one below, else above, else the containing group.
  const next = p.siblings[p.index - 1] ?? p.siblings[p.index + 1] ?? p.parent;
  return { ...d, layers, activeLayerId: next!.id };
}

/** Moves a layer within its container to `toIndex` (Arrange). */
export function moveLayer(d: Doc, id: string, toIndex: number): Doc {
  const p = locate(d.layers, id);
  if (!p) return d;
  const to = Math.max(0, Math.min(p.siblings.length - 1, toIndex));
  if (to === p.index) return d;
  const target = p.siblings[to];
  return moveLayerRelative(d, id, target.id, to > p.index ? "above" : "below");
}

/** Moves a layer next to another, or into a group (at its top or bottom), as dropped in the Layers panel. Unchanged if it's already there. */
export function moveLayerRelative(d: Doc, id: string, targetId: string, placement: TreePlacement): Doc {
  const l = findLayer(d.layers, id);
  const target = findLayer(d.layers, targetId);
  // A group can't go inside itself.
  if (!l || !target || id === targetId || findLayer(childrenOf(l), targetId)) return d;
  const layers = insertAt(removeFrom(d.layers, id), l, targetId, placement);
  return treeShape(layers) === treeShape(d.layers) ? d : { ...d, layers: settleClipping(layers, id) };
}

/** Group Layers (Ctrl+G): puts layers (in their stacking order) into a new group where the topmost one was. */
export function groupLayers(d: Doc, ids: readonly string[], name = numberedName(d, "Group")): Doc {
  const order = allLayers(d.layers).filter((l) => ids.includes(l.id));
  // Only outermost picks: a group brings its contents along.
  const picked = order.filter((l) => !order.some((g) => g !== l && findLayer(childrenOf(g), l.id)));
  if (!picked.length) return d;
  const group = createGroup(name);
  let layers = insertAt(d.layers, group, picked[picked.length - 1].id, "above");
  for (const l of picked) layers = removeFrom(layers, l.id);
  layers = updateIn(layers, group.id, (g) => ({ ...g, content: { kind: "group", layers: picked, open: true } }));
  return { ...d, layers, activeLayerId: group.id };
}

/** Ungroup Layers (Shift+Ctrl+G), or deleting a group but not its contents: the group's layers take its place. */
export function ungroup(d: Doc, id: string): Doc {
  const p = locate(d.layers, id);
  const g = p?.siblings[p.index];
  if (!p || !g || !isGroup(g)) return d;
  const kids = g.content.layers;
  if (!kids.length) return removeLayer(d, id);
  let layers = d.layers;
  for (const k of kids) layers = insertAt(layers, k, id, "below");
  layers = removeFrom(layers, id);
  return { ...d, layers, activeLayerId: d.activeLayerId === id ? kids[kids.length - 1].id : d.activeLayerId };
}

/** Rasterize Layer: keeps the rendered pixels, drops the editable content. */
export function rasterizeLayer(d: Doc, id: string): Doc {
  const l = findLayer(d.layers, id);
  return l && (l.content.kind === "smart" || l.content.kind === "shape") ? updateLayer(d, id, { content: PIXELS }) : d;
}

/**
 * Convert to Smart Object: the layer's current pixels become the embedded
 * source, placed exactly where they were.
 */
export function convertToSmartObject(d: Doc, id: string, sourceId = newSourceId()): Doc {
  const l = findLayer(d.layers, id);
  if (!l || !hasPixels(l) || l.content.kind === "smart") return d;
  const b = contentBounds(l.pixels);
  if (isEmpty(b)) return d;
  const source: SmartSource = {
    id: sourceId,
    name: l.name,
    width: b.w,
    height: b.h,
    pixels: translatePixels(l.pixels, -b.x, -b.y),
    file: null,
  };
  const placement: Placement = { source: rect(0, 0, b.w, b.h), quad: quadOf(b), angle: 0, patch: null };
  return updateLayer(d, id, { content: { kind: "smart", source, placement } });
}

/** A copy of a layer (and a group's contents) with new ids. */
export function cloneLayer(l: Layer, name = l.name): Layer {
  const content = isGroup(l) ? { ...l.content, layers: l.content.layers.map((c) => cloneLayer(c)) } : l.content;
  return { ...l, id: newId(), name, content };
}

export function duplicateLayer(d: Doc, id: string): Doc {
  const src = findLayer(d.layers, id);
  return src ? addLayer(d, cloneLayer(src, `${src.name} copy`), id, "above") : d;
}
