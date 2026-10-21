import { beginStroke, type Stroke, type StrokePoint } from "../../core/brush";
import { activeLayer, docRect, fillTiles, updateLayer } from "../../core/document";
import { combine, magicWand } from "../../core/selection";
import type { Tool, ToolEvent } from "../types";

const point = (e: ToolEvent): StrokePoint => ({ x: e.x, y: e.y, pressure: e.pressure });

/** Brush and Eraser: one stroke per press, previewed live, committed on release. */
export function createPaintTool(id: "brush" | "eraser"): Tool {
  let stroke: Stroke | null = null;
  let layerId = "";
  let last: StrokePoint | null = null; // end of the previous stroke, for shift-click lines

  return {
    id,
    cursor: () => "none", // the viewport draws a brush outline instead
    down(ctx, e) {
      const layer = activeLayer(ctx.doc);
      if (!layer || !layer.visible || !ctx.requireEditable(layer)) return;
      const erase = id === "eraser";
      layerId = layer.id;
      stroke = beginStroke(layer.tiles, {
        brush: erase ? ctx.settings.eraser : ctx.settings.brush,
        color: ctx.foreground,
        erase,
        selection: ctx.doc.selection,
        clip: docRect(ctx.doc),
      });
      ctx.preview(updateLayer(ctx.doc, layerId, { tiles: stroke.tiles }));
      if (e.shift && last) stroke.add(last);
      stroke.add(point(e));
      ctx.requestRender();
    },
    move(ctx, e) {
      if (!stroke) return;
      stroke.add(point(e));
      ctx.requestRender();
    },
    up(ctx, e) {
      if (!stroke) return;
      const tiles = stroke.finish();
      stroke = null;
      last = point(e);
      ctx.commit(id === "eraser" ? "Eraser" : "Brush Tool", updateLayer(ctx.doc, layerId, { tiles }));
    },
    cancel(ctx) {
      if (!stroke) return;
      stroke = null;
      ctx.preview(null);
    },
  };
}

/** Paint Bucket: fills similar contiguous pixels of the active layer with the foreground colour. */
export const bucketTool: Tool = {
  id: "bucket",
  down(ctx, e) {
    const { doc, settings } = ctx;
    const layer = activeLayer(doc);
    // A single click: after rasterizing, it fills (as Photoshop does).
    if (!layer || !layer.visible || !ctx.requireEditable(layer, (c) => bucketTool.down!(c, e))) return;
    const region = combine(
      doc.selection,
      magicWand(layer.tiles, doc.width, doc.height, e, settings.tolerance, settings.contiguous),
      doc.selection ? "intersect" : "replace",
    );
    if (!region) return;
    ctx.commit("Paint Bucket", updateLayer(doc, layer.id, { tiles: fillTiles(layer.tiles, region.bounds, ctx.foreground, region) }));
  },
};
