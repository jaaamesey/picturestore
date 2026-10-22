import { rasterizeContours } from "./coverage";
import { maskCoverage } from "./composite";
import { updateLayer, type Doc, type Layer, type LayerMask } from "./document";
import { rect, vec } from "./geometry";
import { findLayer } from "./layers";
import { cornerKnot, pathArea, type VectorPath } from "./path";
import { pixelsFromImage } from "./pixels";

/**
 * A layer's vector mask: a path that hides everything outside it (Layer ▸
 * Vector Mask), kept as a path, so it stays sharp at any size. It applies
 * together with the layer's pixel mask.
 *
 * Compositors don't know about it: they are given the layers with each
 * vector mask rendered into the layer's pixel mask — stored only over the
 * path's bounds, hiding the rest — by {@link resolveVectorMasks}.
 */
export interface VectorMask {
  readonly path: VectorPath;
  /** Disabled masks are kept but have no effect. */
  readonly enabled: boolean;
}

/** The effective mask of a layer with a vector mask: the path's area times the layer mask (hidden everywhere else). */
export function effectiveMask(vm: VectorMask, mask: LayerMask | null, width: number, height: number): LayerMask | null {
  if (!vm.enabled) return mask;
  const clip = rect(0, 0, width, height);
  const c = rasterizeContours(pathArea(vm.path, undefined, true), clip);
  if (!c) return { pixels: pixelsFromImage(0, 0, new Uint8ClampedArray(0)), background: 0, enabled: true, linked: mask?.linked ?? true };
  const { region, data } = c;
  const below = maskCoverage(mask, region);
  const rgba = new Uint8ClampedArray(region.w * region.h * 4);
  for (let i = 0, o = 0; i < data.length; i++, o += 4) {
    const v = below ? data[i] * below[i] : data[i];
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
    rgba[o + 3] = 255;
  }
  return { pixels: pixelsFromImage(region.w, region.h, rgba, region.x, region.y), background: 0, enabled: true, linked: mask?.linked ?? true };
}

interface Resolved {
  readonly width: number;
  readonly height: number;
  readonly layer: Layer;
}
const layerCache = new WeakMap<Layer, Resolved>();
const listCache = new WeakMap<readonly Layer[], { width: number; height: number; layers: readonly Layer[] }>();

function resolveLayer(l: Layer, width: number, height: number): Layer {
  const hit = layerCache.get(l);
  if (hit && hit.width === width && hit.height === height) return hit.layer;
  let out = l;
  if (l.content.kind === "group") {
    const inner = resolveVectorMasks(l.content.layers, width, height);
    if (inner !== l.content.layers) out = { ...out, content: { ...l.content, layers: inner } };
  }
  if (l.vectorMask?.enabled) out = { ...out, mask: effectiveMask(l.vectorMask, l.mask, width, height) };
  layerCache.set(l, { width, height, layer: out });
  return out;
}

/** The layers with vector masks drawn into their masks (the same array when there are none). */
export function resolveVectorMasks(layers: readonly Layer[], width: number, height: number): readonly Layer[] {
  const hit = listCache.get(layers);
  if (hit && hit.width === width && hit.height === height) return hit.layers;
  const mapped = layers.map((l) => resolveLayer(l, width, height));
  const out = mapped.some((l, i) => l !== layers[i]) ? mapped : layers;
  listCache.set(layers, { width, height, layers: out });
  return out;
}

/** Where a new vector mask starts: showing everything (a path round the canvas), hiding everything, or a path. */
export type VectorMaskStart = "reveal" | "hide" | VectorPath;

/** Layer ▸ Vector Mask ▸ Reveal All / Hide All / Current Path. Null if the layer has one already. */
export function addVectorMask(d: Doc, layerId: string, start: VectorMaskStart): Doc | null {
  const l = findLayer(d.layers, layerId);
  if (!l || l.vectorMask) return null;
  const path: VectorPath =
    start === "hide" ? { subpaths: [] } : start === "reveal" ? { subpaths: [{ closed: true, op: "combine", knots: [vec(0, 0), vec(d.width, 0), vec(d.width, d.height), vec(0, d.height)].map(cornerKnot) }] } : start;
  return updateLayer(d, layerId, { vectorMask: { path, enabled: true } });
}

export const deleteVectorMask = (d: Doc, layerId: string): Doc => updateLayer(d, layerId, { vectorMask: undefined });

export function toggleVectorMask(d: Doc, layerId: string): Doc {
  const l = findLayer(d.layers, layerId);
  return l?.vectorMask ? updateLayer(d, layerId, { vectorMask: { ...l.vectorMask, enabled: !l.vectorMask.enabled } }) : d;
}

/** Rasterize ▸ Vector Mask: the path becomes part of the layer mask. */
export function rasterizeVectorMask(d: Doc, layerId: string): Doc {
  const l = findLayer(d.layers, layerId);
  if (!l?.vectorMask) return d;
  const mask = effectiveMask(l.vectorMask, l.mask, d.width, d.height);
  return updateLayer(d, layerId, { vectorMask: undefined, mask: l.vectorMask.enabled ? mask : l.mask });
}
