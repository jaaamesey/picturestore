import { lengthToPixels, orderQuad, perspectiveMatrix, perspectiveSize } from "../../core/crop";
import { resolutionOf, type Doc } from "../../core/document";
import { transformDocument } from "../../core/documentTransform";
import { vec, type Vec2 } from "../../core/geometry";
import { isConvex, type Quad } from "../../core/warp";
import type { Tool, ToolContext } from "../types";
import { docToScreen, followRemap } from "../view";
import { ROTATE_CURSOR } from "./transform";

const HANDLE_PX = 8;

type Drag =
  | { readonly kind: "corner" | "edge"; readonly index: number; readonly from: Quad; readonly start: Vec2 }
  | { readonly kind: "move" | "rotate"; readonly from: Quad; readonly start: Vec2 }
  | { readonly kind: "draw"; readonly start: Vec2; readonly startScreen: Vec2; moved: boolean };

type Hit = { readonly kind: "corner" | "edge"; readonly index: number } | { readonly kind: "inside" | "outside" };

const centroid = (q: readonly Vec2[]) => vec(q.reduce((s, p) => s + p.x, 0) / q.length, q.reduce((s, p) => s + p.y, 0) / q.length);
const midpoint = (a: Vec2, b: Vec2) => vec((a.x + b.x) / 2, (a.y + b.y) / 2);

function inside(q: Quad, p: Vec2): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const s = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    if (s && sign && s !== sign) return false;
    sign ||= s;
  }
  return true;
}

/** What's under screen point `p`: a corner, an edge's handle (its midpoint), the inside or outside. */
export function hitQuad(q: Quad, toScreen: (p: Vec2) => Vec2, p: Vec2): Hit {
  const near = (d: Vec2) => Math.hypot(d.x - p.x, d.y - p.y) <= HANDLE_PX;
  const corner = q.findIndex((c) => near(toScreen(c)));
  if (corner >= 0) return { kind: "corner", index: corner };
  const edge = q.findIndex((c, i) => near(toScreen(midpoint(c, q[(i + 1) % 4]))));
  if (edge >= 0) return { kind: "edge", index: edge };
  return { kind: inside(q.map(toScreen) as unknown as Quad, p) ? "inside" : "outside" };
}

/**
 * Photoshop's Perspective Crop tool: click the four corners of something
 * photographed at an angle (or drag a rectangle and move its corners onto
 * it), then commit to straighten it onto a rectangle — of its true
 * proportions, estimated from the perspective, unless W/H are given. The
 * corners and the edges' handles move freely; drag inside to move the
 * quad and outside to rotate it. Cropped pixels are always deleted.
 */
export function createPerspectiveCropTool(): Tool {
  let points: Vec2[] = [];
  let doc: Doc | null = null;
  let drag: Drag | null = null;

  const quad = () => (points.length === 4 ? (points as unknown as Quad) : null);

  function publish(ctx: ToolContext) {
    if (points.length === 0 && drag?.kind !== "draw") return ctx.overlay(null);
    const q = quad();
    ctx.overlay({ kind: "perspective-crop", points: [...points], valid: !!q && isConvex(q), dragging: !!drag });
  }

  function reset(ctx: ToolContext) {
    points = [];
    drag = null;
    doc = ctx.doc;
    publish(ctx);
  }

  const toScreen = (ctx: ToolContext) => (p: Vec2) => docToScreen(ctx.view, p);

  return {
    id: "perspective-crop",
    latestMoveOnly: true,
    commitOnSwitch: true,

    cursor(ctx, e) {
      const q = quad();
      if (!e || !q || doc !== ctx.doc) return "crosshair";
      const hit = drag ? null : hitQuad(q, toScreen(ctx), vec(e.screenX, e.screenY));
      if (drag?.kind === "rotate" || hit?.kind === "outside") return ROTATE_CURSOR;
      if (drag?.kind === "move" || hit?.kind === "inside") return "move";
      return "crosshair";
    },

    down(ctx, e) {
      if (doc !== ctx.doc) reset(ctx);
      const p = vec(e.x, e.y), screen = vec(e.screenX, e.screenY);
      const q = quad();
      if (!q) {
        drag = { kind: "draw", start: p, startScreen: screen, moved: false };
        return publish(ctx);
      }
      const hit = hitQuad(q, toScreen(ctx), screen);
      if (e.clicks >= 2 && hit.kind === "inside") return commit(ctx);
      drag =
        hit.kind === "corner" || hit.kind === "edge"
          ? { kind: hit.kind, index: hit.index, from: q, start: p }
          : { kind: hit.kind === "inside" ? "move" : "rotate", from: q, start: p };
      publish(ctx);
    },

    move(ctx, e) {
      if (!drag) return;
      const p = vec(e.x, e.y);
      switch (drag.kind) {
        case "draw": {
          drag.moved ||= Math.hypot(e.screenX - drag.startScreen.x, e.screenY - drag.startScreen.y) > 3;
          // A drag (before any corner is clicked) draws a rectangle.
          if (!drag.moved || points.length > 0) return;
          const a = drag.start;
          points = [a, vec(p.x, a.y), p, vec(a.x, p.y)];
          points = [...orderQuad(points)];
          break;
        }
        case "corner":
        case "edge":
        case "move": {
          const d = vec(p.x - drag.start.x, p.y - drag.start.y);
          const { kind, from } = drag;
          const moves = (i: number) =>
            kind === "move" || i === (drag as { index: number }).index || (kind === "edge" && i === ((drag as { index: number }).index + 1) % 4);
          points = from.map((c, i) => (moves(i) ? vec(c.x + d.x, c.y + d.y) : c));
          break;
        }
        case "rotate": {
          const c = centroid(drag.from);
          const turn = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
          const cos = Math.cos(turn), sin = Math.sin(turn);
          points = drag.from.map((q) => vec(c.x + cos * (q.x - c.x) - sin * (q.y - c.y), c.y + sin * (q.x - c.x) + cos * (q.y - c.y)));
          break;
        }
      }
      publish(ctx);
    },

    up(ctx, e) {
      const d = drag;
      drag = null;
      // Clicks place corners one at a time.
      if (d?.kind === "draw" && !d.moved && points.length < 4) {
        points = [...points, vec(e.x, e.y)];
        if (points.length === 4) points = [...orderQuad(points)];
      }
      publish(ctx);
    },

    commit,

    cancel: reset,
    activate: reset,

    sync(ctx) {
      if (doc !== ctx.doc && !drag) reset(ctx);
    },
  };

  function commit(ctx: ToolContext) {
    const q = quad();
    const d = ctx.doc;
    const valid = !!q && doc === d && isConvex(q);
    reset(ctx);
    if (!valid) return;
    const o = ctx.settings.perspectiveCrop;
    const resolution = o.resolution ?? resolutionOf(d);
    const estimate = perspectiveSize(q, vec(d.width / 2, d.height / 2));
    const w = o.width && lengthToPixels(o.width.value, o.width.unit, resolution);
    const h = o.height && lengthToPixels(o.height.value, o.height.unit, resolution);
    const width = Math.max(1, Math.round(w ?? (h ? (h * estimate.width) / estimate.height : estimate.width)));
    const height = Math.max(1, Math.round(h ?? (w ? (w * estimate.height) / estimate.width : estimate.height)));
    const matrix = perspectiveMatrix(q, width, height);
    if (!matrix) return;
    const t = { matrix, width, height, lengthScale: 1, filter: "bicubic" as const, resolution, clipToCanvas: true };
    const { view, viewport } = ctx;
    // Same zoom, centred: no point of the old view means anything in the straightened one.
    ctx.commitAsync("Perspective Crop", transformDocument(d, t, ctx.raster), () =>
      ctx.setView(followRemap(view, viewport, { width, height }, () => vec(width / 2, height / 2), true)),
    );
  }
}
