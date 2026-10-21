import { addLayer, createLayer, docRect, flatten, nextLayerName, type Doc, type Layer } from "./document";
import { intersect, isEmpty, type Rect, type Vec2 } from "./geometry";
import { extractFloating, type Floating } from "./raster";
import { rectMask } from "./selection";
import { tilesFromImage, translateTiles } from "./tiles";

/**
 * What Copy takes from a layer's pixels: the selection (or, with none, the
 * whole canvas), clipped to the canvas. Null when that area is empty
 * ("Could not complete the Copy command because the selected area is empty").
 */
export function copyPixels(doc: Doc, layer: Layer): Floating | null {
  const mask = doc.selection ?? rectMask(doc.width, doc.height, docRect(doc));
  if (!mask) return null;
  const { floating } = extractFloating(layer.tiles, mask);
  return isEmpty(floating.bounds) ? null : floating;
}

/** Copy Merged: the composite of all visible layers within the selection. */
export function copyMerged(doc: Doc): Floating | null {
  const area = doc.selection ? doc.selection.bounds : docRect(doc);
  const tiles = tilesFromImage(area.w, area.h, flatten(doc, area), area.x, area.y);
  return copyPixels(doc, createLayer({ name: "", tiles }));
}

/**
 * Pastes pixels as a new layer above the active one, centred on `at` (whole
 * pixels), or where they were copied from when `at` is null (Paste in Place).
 * The selection is dropped, as in Photoshop.
 */
export function pasteFloating(doc: Doc, f: Floating, at: Vec2 | null): Doc {
  const dx = at ? Math.round(at.x - (f.bounds.x + f.bounds.w / 2)) : 0;
  const dy = at ? Math.round(at.y - (f.bounds.y + f.bounds.h / 2)) : 0;
  const tiles = dx || dy ? translateTiles(f.tiles, dx, dy) : f.tiles;
  return { ...addLayer(doc, createLayer({ name: nextLayerName(doc), tiles })), selection: null };
}

/**
 * Where Paste centres content: on the selection if there is one, else on the
 * visible part of the canvas (`visible`, in document space), else the canvas.
 */
export function pasteCenter(doc: Doc, visible: Rect | null): Vec2 {
  const r = doc.selection?.bounds ?? (visible && !isEmpty(intersect(visible, docRect(doc))) ? intersect(visible, docRect(doc)) : docRect(doc));
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
