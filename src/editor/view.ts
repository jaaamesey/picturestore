import type { Vec2 } from "../core/geometry";
import type { View } from "../gpu/renderer";

export const ZOOM_STEPS = [
  1 / 64, 1 / 48, 1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64,
];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Screen = R(rotation) · doc × zoom + pan. */
export function screenToDoc(v: View, p: Vec2): Vec2 {
  const x = (p.x - v.panX) / v.zoom, y = (p.y - v.panY) / v.zoom;
  if (!v.rotation) return { x, y };
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  return { x: c * x + s * y, y: -s * x + c * y };
}

export function docToScreen(v: View, p: Vec2): Vec2 {
  if (!v.rotation) return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY };
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  return { x: (c * p.x - s * p.y) * v.zoom + v.panX, y: (s * p.x + c * p.y) * v.zoom + v.panY };
}

/** A view at `zoom` and `rotation` that puts document point `doc` at screen point `screen`. */
export function placeAt(zoom: number, rotation: number, doc: Vec2, screen: Vec2): View {
  const p = docToScreen({ zoom, rotation, panX: 0, panY: 0 }, doc);
  return { zoom, rotation, panX: screen.x - p.x, panY: screen.y - p.y };
}

/** Zooms to `zoom` keeping the document point under `anchor` (screen) fixed. */
export function zoomAt(v: View, zoom: number, anchor: Vec2): View {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  return placeAt(z, v.rotation ?? 0, screenToDoc(v, anchor), anchor);
}

export const nextZoomStep = (zoom: number) => ZOOM_STEPS.find((z) => z > zoom * 1.001) ?? MAX_ZOOM;
export const prevZoomStep = (zoom: number) => [...ZOOM_STEPS].reverse().find((z) => z < zoom / 1.001) ?? MIN_ZOOM;

/** Centres the document, scaled to fit within the viewport (never above 100%); turned by `rotation`, its turned bounds fit. */
export function fitView(docW: number, docH: number, vw: number, vh: number, padding = 24, maxZoom = 1, rotation = 0): View {
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const bw = docW * c + docH * s, bh = docW * s + docH * c;
  const z = Math.max(MIN_ZOOM, Math.min(maxZoom, (vw - padding * 2) / bw, (vh - padding * 2) / bh));
  if (!rotation) return { zoom: z, panX: Math.round((vw - docW * z) / 2), panY: Math.round((vh - docH * z) / 2) };
  return placeAt(z, rotation, { x: docW / 2, y: docH / 2 }, { x: vw / 2, y: vh / 2 });
}

/**
 * The view after the document's space is remapped by `map` (Image Size,
 * Canvas Size), at the same zoom — as Photoshop keeps it, so 100% still
 * means actual pixels and a resize visibly changes the image's size. The
 * document point at the viewport's centre stays at the centre (mapped to
 * where it went), so you keep looking at the same thing. With
 * `centreIfFits`, an axis on which the new document fits within the
 * viewport is centred instead.
 */
export function followRemap(
  v: View,
  viewport: { readonly width: number; readonly height: number },
  size: { readonly width: number; readonly height: number },
  map: (p: Vec2) => Vec2,
  centreIfFits: boolean,
): View {
  const c = { x: viewport.width / 2, y: viewport.height / 2 };
  const p = map(screenToDoc(v, c));
  // The new document is upright (a crop's rotation is applied to it).
  let panX = c.x - p.x * v.zoom, panY = c.y - p.y * v.zoom;
  if (centreIfFits && size.width * v.zoom <= viewport.width) panX = (viewport.width - size.width * v.zoom) / 2;
  if (centreIfFits && size.height * v.zoom <= viewport.height) panY = (viewport.height - size.height * v.zoom) / 2;
  return { zoom: v.zoom, panX: Math.round(panX), panY: Math.round(panY) };
}

/**
 * Ruler ticks at `zoom`: labelled ticks at least ~64 screen pixels apart,
 * on a 1–2–5 progression of document pixels, with minor ticks between
 * (what Shift snaps a dragged guide to).
 */
export function rulerStep(zoom: number): { major: number; minor: number } {
  const target = 64 / zoom;
  let major = 1;
  for (let p = 1; ; p *= 10) {
    const m = [1, 2, 5].map((k) => k * p).find((s) => s >= target);
    if (m) {
      major = m;
      break;
    }
  }
  // As many minor ticks as fit at least 6 screen pixels apart, on whole pixels.
  const minor = [10, 5, 2].map((n) => major / n).find((s) => s >= 1 && s * zoom >= 6) ?? major;
  return { major, minor };
}

/** The rulers' thickness (View ▸ Rulers), in CSS pixels, along the viewport's top and left edges. */
export const RULER_PX = 18;
