import type { Vec2 } from "../core/geometry";
import type { View } from "../gpu/renderer";

export const ZOOM_STEPS = [
  1 / 64, 1 / 48, 1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64,
];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export const screenToDoc = (v: View, p: Vec2): Vec2 => ({ x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom });
export const docToScreen = (v: View, p: Vec2): Vec2 => ({ x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY });

/** Zooms to `zoom` keeping the document point under `anchor` (screen) fixed. */
export function zoomAt(v: View, zoom: number, anchor: Vec2): View {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const d = screenToDoc(v, anchor);
  return { zoom: z, panX: anchor.x - d.x * z, panY: anchor.y - d.y * z };
}

export const nextZoomStep = (zoom: number) => ZOOM_STEPS.find((z) => z > zoom * 1.001) ?? MAX_ZOOM;
export const prevZoomStep = (zoom: number) => [...ZOOM_STEPS].reverse().find((z) => z < zoom / 1.001) ?? MIN_ZOOM;

/** Centres the document, scaled to fit within the viewport (never above 100%). */
export function fitView(docW: number, docH: number, vw: number, vh: number, padding = 24, maxZoom = 1): View {
  const zoom = Math.min(maxZoom, (vw - padding * 2) / docW, (vh - padding * 2) / docH);
  const z = Math.max(MIN_ZOOM, zoom);
  return { zoom: z, panX: Math.round((vw - docW * z) / 2), panY: Math.round((vh - docH * z) / 2) };
}
