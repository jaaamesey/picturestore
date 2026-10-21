import { beginStroke, type Stroke, type StrokePoint } from "../../core/brush";
import { docRect, fillPixels, maskTone, withTargetPixels, type EditTarget } from "../../core/document";
import { combine, magicWand } from "../../core/selection";
import { maskValues } from "../../core/composite";
import type { Tool, ToolEvent } from "../types";

const point = (e: ToolEvent): StrokePoint => ({ x: e.x, y: e.y, pressure: e.pressure });

/**
 * Brush and Eraser: one stroke per press, previewed live, committed on
 * release. On a layer mask they paint in grey: the brush with the
 * foreground colour's, the eraser with the background colour's.
 */
export function createPaintTool(id: "brush" | "eraser"): Tool {
  let stroke: Stroke | null = null;
  let target: EditTarget | null = null;
  let last: StrokePoint | null = null; // end of the previous stroke, for shift-click lines

  return {
    id,
    cursor: () => "none", // the viewport draws a brush outline instead
    down(ctx, e) {
      const t = ctx.editTarget();
      if (!t || !t.layer.visible) return;
      const eraser = id === "eraser";
      target = t;
      stroke = beginStroke(t.pixels, {
        brush: eraser ? ctx.settings.eraser : ctx.settings.brush,
        color: !t.mask ? ctx.foreground : maskTone(eraser ? ctx.background : ctx.foreground),
        erase: eraser && !t.mask,
        selection: ctx.doc.selection,
        clip: docRect(ctx.doc),
      });
      ctx.preview(withTargetPixels(ctx.doc, t, stroke.pixels));
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
      const pixels = stroke.finish();
      stroke = null;
      last = point(e);
      ctx.commit(id === "eraser" ? "Eraser" : "Brush Tool", withTargetPixels(ctx.doc, target!, pixels));
    },
    cancel(ctx) {
      if (!stroke) return;
      stroke = null;
      ctx.preview(null);
    },
  };
}

/** Paint Bucket: fills similar contiguous pixels of the edit target with the foreground colour (its grey, on a mask). */
export const bucketTool: Tool = {
  id: "bucket",
  down(ctx, e) {
    const { doc, settings } = ctx;
    // A single click: after rasterizing, it fills (as Photoshop does).
    const t = ctx.editTarget((c) => bucketTool.down!(c, e));
    if (!t || !t.layer.visible) return;
    const region = combine(
      doc.selection,
      // On a mask, similar values of the whole mask (not just what's been painted on it).
      magicWand(t.mask ? maskValues(t.layer.mask!, docRect(doc)) : t.pixels, doc.width, doc.height, e, settings.tolerance, settings.contiguous),
      doc.selection ? "intersect" : "replace",
    );
    if (!region) return;
    const color = t.mask ? maskTone(ctx.foreground) : ctx.foreground;
    ctx.commit("Paint Bucket", withTargetPixels(doc, t, fillPixels(t.pixels, region.bounds, color, region)));
  },
};
