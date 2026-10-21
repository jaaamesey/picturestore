import { flatten } from "../../core/composite";
import { rect, vec, type Vec2 } from "../../core/geometry";
import type { View } from "../../gpu/renderer";
import { nextZoomStep, prevZoomStep, zoomAt } from "../view";
import type { Tool } from "../types";

export function createHandTool(): Tool {
  let start: { p: Vec2; view: View } | null = null;
  return {
    id: "hand",
    cursor: () => (start ? "grabbing" : "grab"),
    down(ctx, e) {
      start = { p: vec(e.screenX, e.screenY), view: ctx.view };
    },
    move(ctx, e) {
      if (!start) return;
      const { p, view } = start;
      ctx.setView({ ...view, panX: view.panX + e.screenX - p.x, panY: view.panY + e.screenY - p.y });
    },
    up() {
      start = null;
    },
  };
}

export const zoomTool: Tool = {
  id: "zoom",
  cursor: (_, e) => (e?.alt ? "zoom-out" : "zoom-in"),
  down(ctx, e) {
    const z = e.alt ? prevZoomStep(ctx.view.zoom) : nextZoomStep(ctx.view.zoom);
    ctx.setView(zoomAt(ctx.view, z, vec(e.screenX, e.screenY)));
  },
};

/** Samples the composite image (all visible layers) into the foreground colour. */
export function createEyedropperTool(): Tool {
  let active = false;
  const sample: Tool["move"] = (ctx, e) => {
    const x = Math.floor(e.x);
    const y = Math.floor(e.y);
    if (x < 0 || y < 0 || x >= ctx.doc.width || y >= ctx.doc.height) return;
    const [r, g, b, a] = flatten(ctx.doc, rect(x, y, 1, 1));
    if (a > 0) ctx.setForeground({ r, g, b });
  };
  return {
    id: "eyedropper",
    cursor: () => "crosshair",
    down(ctx, e) {
      active = true;
      sample(ctx, e);
    },
    move(ctx, e) {
      if (active) sample(ctx, e);
    },
    up() {
      active = false;
    },
  };
}
