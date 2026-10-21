import {
  CROP_OVERLAYS,
  boxToDoc,
  canvasBox,
  constraintRatio,
  cropMatrix,
  cropOutput,
  docToBox,
  drawBox,
  fitInside,
  fitRatio,
  isCanvasBox,
  largestBox,
  levelAngle,
  moveBox,
  rectBox,
  resizeBox,
  rotateBox,
  swapOrientation,
  type CropBox,
} from "../../core/crop";
import { resolutionOf, type Doc } from "../../core/document";
import { mapPoint, transformDocument } from "../../core/documentTransform";
import { vec, type Vec2 } from "../../core/geometry";
import type { View } from "../../gpu/renderer";
import type { Tool, ToolContext, ToolEvent } from "../types";
import { docToScreen, followRemap, placeAt, screenToDoc } from "../view";
import { ROTATE_CURSOR, resizeCursorToward } from "./transform";

/** Handles (and edges) grab within this many screen pixels. */
const HANDLE_PX = 8;

type Hit = { readonly kind: "handle"; readonly hx: -1 | 0 | 1; readonly hy: -1 | 0 | 1 } | { readonly kind: "inside" } | { readonly kind: "outside" };

/** What's under screen point `p`: a handle or edge (anywhere along it), the inside or the outside of the box. */
export function hitCropBox(b: CropBox, view: View, p: Vec2): Hit {
  const q = docToBox(b, screenToDoc(view, p));
  const k = view.zoom;
  const [l, r, t, btm] = [q.x * k, (b.w - q.x) * k, q.y * k, (b.h - q.y) * k];
  if (Math.min(l, r, t, btm) < -HANDLE_PX) return { kind: "outside" };
  const side = (a: number, z: number): -1 | 0 | 1 => (Math.min(Math.abs(a), Math.abs(z)) > HANDLE_PX ? 0 : Math.abs(a) <= Math.abs(z) ? -1 : 1);
  const hx = side(l, r), hy = side(t, btm);
  if (hx || hy) return { kind: "handle", hx, hy };
  return Math.min(l, r, t, btm) >= 0 ? { kind: "inside" } : { kind: "outside" };
}

const sameBox = (a: CropBox, b: CropBox) => a.cx === b.cx && a.cy === b.cy && a.w === b.w && a.h === b.h && a.angle === b.angle;

interface Session {
  /** The document the box is for. */
  readonly doc: Doc;
  box: CropBox;
  /** Untouched: dragging inside draws a new box instead of moving it. */
  pristine: boolean;
  /** The ratio the box was last fitted to. */
  ratio: number | null;
  /** Restored on cancel (the image is moved and turned under the box). */
  readonly view: View;
}

type Drag =
  | { readonly kind: "resize"; readonly hx: -1 | 0 | 1; readonly hy: -1 | 0 | 1; readonly from: CropBox }
  | { readonly kind: "move" | "rotate"; readonly from: CropBox; readonly start: Vec2; readonly view: View }
  | { readonly kind: "draw"; readonly start: Vec2; readonly startScreen: Vec2; moved: boolean }
  | { readonly kind: "straighten"; readonly a: Vec2; b: Vec2 };

export interface CropController extends Tool {
  readonly id: "crop";
  /** Rotate Crop Box (X): portrait ⇄ landscape, ratio fields swapped. */
  rotateBox(ctx: ToolContext): void;
}

/**
 * Photoshop's Crop tool. A box is shown as soon as the tool is selected
 * (the selection's bounds, else the whole canvas); drag inside it to draw a
 * new one, its handles to resize (Shift keeps proportions, Alt from the
 * centre), inside to move and outside to rotate. By default the image
 * moves and turns under a box that stays upright and centred — the view
 * rotates, so the preview costs nothing; Classic Mode moves the box
 * instead. Enter, a double-click, or switching tools crops; Escape resets.
 * After a crop the box is hidden until the next click.
 */
export function createCropTool(): CropController {
  let session: Session | null = null;
  let hidden = false;
  let drag: Drag | null = null;

  const ratioOf = (ctx: ToolContext) => constraintRatio(ctx.settings.crop.constraint, resolutionOf(ctx.doc));

  function fresh(ctx: ToolContext): Session {
    const d = ctx.doc;
    const ratio = ratioOf(ctx);
    const base = d.selection ? rectBox(d.selection.bounds) : canvasBox(d.width, d.height);
    return { doc: d, box: ratio ? fitRatio(base, ratio) : base, pristine: true, ratio, view: ctx.view };
  }

  const current = (ctx: ToolContext) => (session && session.doc === ctx.doc ? session : (session = fresh(ctx)));

  function publish(ctx: ToolContext) {
    if (hidden || !session) return ctx.overlay(null);
    ctx.overlay({
      kind: "crop",
      box: session.box,
      drag: drag && (drag.kind !== "draw" || drag.moved) ? drag.kind : null,
      line: drag?.kind === "straighten" ? [drag.a, drag.b] : undefined,
    });
  }

  /** The image turns under the box so the box is upright on screen, its centre at `at`. */
  function follow(ctx: ToolContext, b: CropBox, at: Vec2) {
    if (!ctx.settings.crop.classic) ctx.setView(placeAt(ctx.view.zoom, -b.angle || 0, vec(b.cx, b.cy), at));
  }

  /** After a resize: centred in the window with Auto Center Preview, else where it is. */
  function settle(ctx: ToolContext, b: CropBox) {
    const c = ctx.settings.crop;
    if (c.classic) return;
    follow(ctx, b, c.autoCenter ? vec(ctx.viewport.width / 2, ctx.viewport.height / 2) : docToScreen(ctx.view, vec(b.cx, b.cy)));
  }

  /** An unrotated box's edges snap (Photoshop's "cropping marquees"); a turned one's can't line up with anything. */
  const snapped = (ctx: ToolContext, p: Vec2, b: CropBox) => (b.angle === 0 ? ctx.snap.point(p) : p);

  const crop = (ctx: ToolContext) => {
    const s = session;
    drag = null;
    hidden = true;
    session = null;
    ctx.overlay(null);
    if (!s || s.doc !== ctx.doc) return;
    const d = ctx.doc;
    const out = cropOutput(s.box, ctx.settings.crop.constraint, resolutionOf(d));
    if (isCanvasBox(s.box, d.width, d.height) && out.width === d.width && out.height === d.height && out.resolution === resolutionOf(d)) return;
    const matrix = cropMatrix(s.box, out.width, out.height);
    const sx = out.width / s.box.w, sy = out.height / s.box.h;
    // As Image Size: content lengths (stroke widths) follow a proportional resample.
    const proportional = Math.abs(sx - sy) <= 1.01 / Math.min(s.box.w, s.box.h);
    const t = {
      matrix,
      width: out.width,
      height: out.height,
      lengthScale: proportional ? Math.sqrt(sx * sy) : 1,
      filter: "bicubic" as const,
      resolution: out.resolution,
      clipToCanvas: ctx.settings.crop.deletePixels,
    };
    // The result appears where the box was, at the same zoom.
    const { view, viewport } = ctx;
    ctx.commitAsync("Crop", transformDocument(d, t, ctx.raster), () => ctx.setView(followRemap(view, viewport, out, (p) => mapPoint(matrix, p), false)));
  };

  const straightening = (ctx: ToolContext, e: ToolEvent | null) => ctx.settings.crop.straighten || !!e?.mod;

  function rotateCropBox(ctx: ToolContext) {
    const s = current(ctx);
    hidden = false;
    s.box = swapOrientation(s.box);
    s.pristine = false;
    const { constraint } = ctx.settings.crop;
    if (constraint.width && constraint.height) {
      s.ratio = s.ratio && 1 / s.ratio;
      ctx.updateSettings((x) => void (x.crop.constraint = { ...constraint, width: constraint.height, height: constraint.width }));
    }
    settle(ctx, s.box);
    publish(ctx);
  }

  return {
    id: "crop",
    latestMoveOnly: true,
    commitOnSwitch: true,

    cursor(ctx, e) {
      if (!e || hidden) return "crosshair";
      if (drag) return drag.kind === "move" ? "move" : drag.kind === "rotate" ? ROTATE_CURSOR : "crosshair";
      const s = session;
      if (straightening(ctx, e) || !s || s.doc !== ctx.doc) return "crosshair";
      const hit = hitCropBox(s.box, ctx.view, vec(e.screenX, e.screenY));
      if (hit.kind === "outside") return ROTATE_CURSOR;
      if (hit.kind === "inside") return s.pristine ? "crosshair" : "move";
      const c = docToScreen(ctx.view, vec(s.box.cx, s.box.cy));
      const p = docToScreen(ctx.view, boxToDoc(s.box, vec(((hit.hx + 1) / 2) * s.box.w, ((hit.hy + 1) / 2) * s.box.h)));
      return resizeCursorToward(p.x - c.x, p.y - c.y);
    },

    down(ctx, e) {
      const p = vec(e.x, e.y), screen = vec(e.screenX, e.screenY);
      if (hidden) {
        // A click brings the box back; a drag draws one.
        hidden = false;
        session = fresh(ctx);
        drag = { kind: "draw", start: snapped(ctx, p, session.box), startScreen: screen, moved: false };
        return publish(ctx);
      }
      const s = current(ctx);
      const hit = hitCropBox(s.box, ctx.view, screen);
      if (e.clicks >= 2 && hit.kind === "inside") return crop(ctx);
      if (straightening(ctx, e)) drag = { kind: "straighten", a: p, b: p };
      else if (hit.kind === "handle") drag = { kind: "resize", hx: hit.hx, hy: hit.hy, from: s.box };
      else if (hit.kind === "inside" && s.pristine) drag = { kind: "draw", start: snapped(ctx, p, s.box), startScreen: screen, moved: false };
      else drag = { kind: hit.kind === "inside" ? "move" : "rotate", from: s.box, start: screen, view: ctx.view };
      publish(ctx);
    },

    move(ctx, e) {
      const s = session;
      if (!drag || !s) return;
      const p = vec(e.x, e.y), screen = vec(e.screenX, e.screenY);
      const classic = ctx.settings.crop.classic;
      const before = s.box;
      switch (drag.kind) {
        case "resize":
          s.box = resizeBox(drag.from, drag.hx, drag.hy, snapped(ctx, p, drag.from), {
            ratio: s.ratio ?? (e.shift ? drag.from.w / drag.from.h : null),
            fromCentre: e.alt,
          });
          break;
        case "move": {
          // In the view the drag started in: with the image moving, the current one moves too.
          let d = vec(screen.x - drag.start.x, screen.y - drag.start.y);
          if (e.shift) d = Math.abs(d.x) >= Math.abs(d.y) ? vec(d.x, 0) : vec(0, d.y);
          const a = screenToDoc(drag.view, drag.start), b = screenToDoc(drag.view, vec(drag.start.x + d.x, drag.start.y + d.y));
          const delta = classic ? vec(b.x - a.x, b.y - a.y) : vec(a.x - b.x, a.y - b.y);
          s.box = moveBox(drag.from, delta);
          if (s.box.angle === 0) {
            // The box's edges or centre snap (Shift keeps it on its axis).
            const b = s.box, sn = ctx.snap.rect({ x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h });
            s.box = moveBox(b, e.shift ? (d.x ? vec(sn.x, 0) : vec(0, sn.y)) : sn);
          }
          follow(ctx, s.box, docToScreen(drag.view, vec(drag.from.cx, drag.from.cy)));
          break;
        }
        case "rotate": {
          const c = docToScreen(drag.view, vec(drag.from.cx, drag.from.cy));
          const turn = Math.atan2(screen.y - c.y, screen.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
          // The image turns with the pointer (the box, the other way); in Classic Mode the box does.
          s.box = rotateBox(drag.from, classic ? turn : -turn);
          follow(ctx, s.box, c);
          break;
        }
        case "draw":
          drag.moved ||= Math.hypot(screen.x - drag.startScreen.x, screen.y - drag.startScreen.y) > 2;
          if (!drag.moved) return;
          s.box = drawBox(drag.start, snapped(ctx, p, s.box), -(ctx.view.rotation ?? 0), { ratio: s.ratio, square: e.shift, fromCentre: e.alt });
          break;
        case "straighten":
          drag.b = p;
          break;
      }
      if (!sameBox(s.box, before) || drag.kind === "straighten") s.pristine = false;
      publish(ctx);
    },

    up(ctx) {
      const s = session, d = drag;
      drag = null;
      if (!s || !d) return publish(ctx);
      if (d.kind === "resize" || (d.kind === "draw" && d.moved)) settle(ctx, s.box);
      if (d.kind === "straighten") {
        const a = docToScreen(ctx.view, d.a), b = docToScreen(ctx.view, d.b);
        if (Math.hypot(b.x - a.x, b.y - a.y) >= 4) {
          // Level the line, then shrink the box so no empty corners show.
          s.box = fitInside({ ...s.box, angle: levelAngle(d.a, d.b) }, ctx.doc.width, ctx.doc.height);
          s.pristine = false;
          settle(ctx, s.box);
        }
        if (ctx.settings.crop.straighten) ctx.updateSettings((x) => void (x.crop.straighten = false));
      }
      publish(ctx);
    },

    commit: crop,

    cancel(ctx) {
      drag = null;
      if (hidden) return;
      if (session && !session.pristine) ctx.setView(session.view);
      session = fresh({ ...ctx, view: session?.view ?? ctx.view });
      publish(ctx);
    },

    activate(ctx) {
      hidden = false;
      drag = null;
      session = fresh(ctx);
      publish(ctx);
    },

    sync(ctx) {
      if (hidden || drag) return;
      if (!session || session.doc !== ctx.doc) {
        session = fresh(ctx);
        return publish(ctx);
      }
      const s = session;
      const ratio = ratioOf(ctx);
      if (ratio !== s.ratio) {
        s.ratio = ratio;
        if (ratio) s.box = largestBox(ctx.doc.width, ctx.doc.height, ratio, s.box.angle);
        else if (s.pristine) s.box = fresh(ctx).box;
        settle(ctx, s.box);
      }
      // Classic Mode toggled: the image stays put, or turns upright under the box.
      const rotation = ctx.view.rotation ?? 0;
      const want = ctx.settings.crop.classic ? 0 : -s.box.angle || 0;
      if (Math.abs(rotation - want) > 1e-9) ctx.setView(placeAt(ctx.view.zoom, want, vec(s.box.cx, s.box.cy), docToScreen(ctx.view, vec(s.box.cx, s.box.cy))));
      publish(ctx);
    },

    key(ctx, e) {
      if (hidden || !session) return false;
      const k = e.key.toLowerCase();
      const c = ctx.settings.crop;
      switch (k) {
        case "h":
        case "/":
          ctx.updateSettings((x) => void (x.crop.showCropped = !x.crop.showCropped));
          return true;
        case "o": {
          const i = CROP_OVERLAYS.findIndex((o) => o.id === c.overlay);
          if (e.shift) ctx.updateSettings((x) => void (x.crop.orientation = (x.crop.orientation + 1) % CROP_OVERLAYS[i].orientations));
          else ctx.updateSettings((x) => void ((x.crop.overlay = CROP_OVERLAYS[(i + 1) % CROP_OVERLAYS.length].id), (x.crop.orientation = 0)));
          return true;
        }
        case "x":
          rotateCropBox(ctx);
          return true;
        case "p":
          ctx.updateSettings((x) => void (x.crop.classic = !x.crop.classic));
          return true;
        case "i": {
          // Front Image, once the box has been adjusted (until then I is the Eyedropper, as in Photoshop).
          if (session.pristine) return false;
          const d = ctx.doc;
          ctx.updateSettings((x) => {
            x.crop.constraint = {
              mode: "size",
              width: { value: d.width, unit: "pixels" },
              height: { value: d.height, unit: "pixels" },
              resolution: resolutionOf(d),
            };
          });
          return true;
        }
      }
      return false;
    },

    rotateBox: rotateCropBox,
  };
}
