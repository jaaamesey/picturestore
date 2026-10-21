import { applyProgram, compile, type Program } from "./adjustments";
import { blendSpan, effectiveMode } from "./blend";
import { PIXELS, type Doc, type Layer, type LayerMask } from "./document";
import { EMPTY_RECT, isEmpty, rect, union, type Rect } from "./geometry";
import { findLayer, hasPixels, isClipped, isGroup, locate, updateIn } from "./layers";
import { pixelReader, pixelsFromImage, readSpans, storedBounds, tileWriter, writeSpans, type Pixels } from "./pixels";
import type { Mask } from "./selection";

/**
 * The reference compositor: renders a layer tree the way Photoshop does,
 * into straight RGBA8. The GPU compositor (`gpu/renderer.ts`) mirrors it,
 * and e2e tests compare the two; export, the eyedropper, Copy Merged and
 * merging use it directly.
 *
 * - Layers blend bottom to top through their blend mode, opacity and layer
 *   mask.
 * - A clipping group (a base layer and the clipped layers above it) renders
 *   as a unit: the clipped layers composite onto the base alone, keeping its
 *   transparency ("Blend Clipped Layers as Group", Photoshop's default),
 *   and the result blends in with the base's mode and opacity.
 * - A group in Pass Through blends its contents straight into what's below
 *   (its opacity and mask then fade between before and after); any other
 *   mode composites the contents on their own first and blends the result.
 * - Adjustment layers recolour everything below them in their container
 *   (only the base, when clipped), keeping its transparency.
 *
 * Work is done in horizontal bands of premultiplied float RGBA, so memory
 * stays bounded whatever the image size.
 */
export function flatten(d: Pick<Doc, "width" | "height" | "layers">, area: Rect = rect(0, 0, d.width, d.height), layers: readonly Layer[] = d.layers): Uint8ClampedArray {
  const out = new Uint8ClampedArray(area.w * area.h * 4);
  const rows = Math.max(1, Math.min(area.h, Math.floor(BAND_PIXELS / Math.max(1, area.w))));
  for (let y = 0; y < area.h; y += rows) {
    const band = rect(area.x, area.y + y, area.w, Math.min(rows, area.h - y));
    const acc = new Renderer(band).render(layers);
    toStraight(acc, out, y * area.w * 4);
  }
  return out;
}

const BAND_PIXELS = 1 << 18;

function toStraight(acc: Float32Array, out: Uint8ClampedArray, at: number) {
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3];
    if (a <= 0) continue;
    const k = 255 / a;
    out[at + i] = acc[i] * k;
    out[at + i + 1] = acc[i + 1] * k;
    out[at + i + 2] = acc[i + 2] * k;
    out[at + i + 3] = a * 255;
  }
}

/** A layer mask's coverage (0–1) over `band`, or null when it has no effect. */
export function maskCoverage(mask: LayerMask | null, band: Rect): Float32Array | null {
  if (!mask?.enabled) return null;
  const cov = new Float32Array(band.w * band.h).fill(mask.background / 255);
  const bg = mask.background;
  readSpans(mask.pixels, band, (data, i, x, y, n) => {
    for (let k = (y - band.y) * band.w + (x - band.x), end = i + n * 4; i < end; i += 4, k++) {
      const a = data[i + 3];
      cov[k] = (data[i] * a + bg * (255 - a)) / (255 * 255);
    }
  });
  // Density scales how much it hides.
  const d = mask.density ?? 1;
  if (d < 1) for (let k = 0; k < cov.length; k++) cov[k] = 1 - d * (1 - cov[k]);
  return cov;
}

/** A layer's Fill opacity (groups have none). */
export const fillOf = (l: Layer) => l.fill ?? 1;

const programs = new WeakMap<object, Program>();
/** Compiled adjustments, cached by settings identity (settings are immutable). */
export function programOf(l: Layer): Program {
  if (l.content.kind !== "adjustment") throw new Error("not an adjustment layer");
  const a = l.content.adjustment;
  let p = programs.get(a);
  if (!p) programs.set(a, (p = compile(a)));
  return p;
}

class Renderer {
  private readonly n: number;
  constructor(private readonly band: Rect) {
    this.n = band.w * band.h;
  }

  private buffer = () => new Float32Array(this.n * 4);

  render(layers: readonly Layer[]): Float32Array {
    const acc = this.buffer();
    this.stack(layers, acc);
    return acc;
  }

  /** Composites a container's layers onto `acc`. */
  private stack(layers: readonly Layer[], acc: Float32Array) {
    for (let i = 0; i < layers.length; i++) {
      if (isClipped(layers, i)) continue;
      let j = i + 1;
      while (j < layers.length && layers[j].clipped) j++;
      const base = layers[i];
      if (!base.visible) continue;
      const clipped = layers.slice(i + 1, j).filter((l) => l.visible);
      if (clipped.length) this.clipGroup(base, clipped, acc);
      else this.layer(base, acc);
    }
  }

  private clipGroup(base: Layer, clipped: readonly Layer[], acc: Float32Array) {
    const cov = maskCoverage(base.mask, this.band);
    if (base.content.kind === "adjustment") {
      // An adjustment's "content" is its mask: what's clipped to it shows through that alone.
      this.layer(base, acc);
      for (const c of clipped) this.layer(c, acc, cov);
      return;
    }
    // The base on its own (with its mask), then the clipped layers onto it, keeping its transparency.
    const buf = isGroup(base) ? this.render(base.content.layers) : this.pixels(base.pixels);
    // The base's fill and mask shape the group; its opacity and mode blend the result.
    const fill = isGroup(base) ? 1 : fillOf(base);
    if (cov || fill < 1) for (let k = 0; k < this.n; k++) for (let c = 0; c < 4; c++) buf[k * 4 + c] *= fill * (cov ? cov[k] : 1);
    for (const c of clipped) this.layer(c, buf, null, true);
    blendSpan(effectiveMode(base.blendMode), acc, 0, buf, 0, this.n, base.opacity);
  }

  /** Composites one layer onto `acc`, its coverage optionally limited further by `limit`. */
  private layer(l: Layer, acc: Float32Array, limit: Float32Array | null = null, atop = false) {
    let cov = maskCoverage(l.mask, this.band);
    if (limit) cov = cov ? cov.map((v, k) => v * limit[k]) : limit;
    const mode = effectiveMode(l.blendMode);
    if (l.content.kind === "adjustment") return this.adjust(programOf(l), l, acc, cov);
    if (isGroup(l)) {
      if (l.blendMode === "pass through" && !atop) {
        if (l.opacity >= 1 && !cov) return this.stack(l.content.layers, acc);
        // Render through, then fade between the backdrop before and after.
        const before = acc.slice();
        this.stack(l.content.layers, acc);
        for (let k = 0, i = 0; k < this.n; k++) {
          const t = l.opacity * (cov ? cov[k] : 1);
          for (let c = 0; c < 4; c++, i++) acc[i] = before[i] + (acc[i] - before[i]) * t;
        }
        return;
      }
      return blendSpan(mode, acc, 0, this.render(l.content.layers), 0, this.n, l.opacity, cov, 0, atop);
    }
    blendSpan(mode, acc, 0, this.pixels(l.pixels), 0, this.n, l.opacity * fillOf(l), cov, 0, atop);
  }

  /**
   * An adjustment: the backdrop's colours through the adjustment, blended
   * back onto it (with the layer's mode, opacity and mask) keeping its
   * transparency, i.e. the adjusted colours composited source-atop.
   */
  private adjust(p: Program, l: Layer, acc: Float32Array, cov: Float32Array | null) {
    const adjusted = this.buffer();
    const o = [0, 0, 0];
    for (let i = 0; i < acc.length; i += 4) {
      const a = acc[i + 3];
      if (a <= 0) continue;
      applyProgram(p, acc[i] / a, acc[i + 1] / a, acc[i + 2] / a, o);
      adjusted[i] = o[0];
      adjusted[i + 1] = o[1];
      adjusted[i + 2] = o[2];
      adjusted[i + 3] = 1;
    }
    blendSpan(effectiveMode(l.blendMode), acc, 0, adjusted, 0, this.n, l.opacity * fillOf(l), cov, 0, true);
  }

  /** Layer pixels over the band, premultiplied. */
  private pixels(pixels: Pixels): Float32Array {
    const buf = this.buffer();
    const { band } = this;
    readSpans(pixels, band, (data, i, x, y, n) => {
      for (let k = ((y - band.y) * band.w + (x - band.x)) * 4, end = i + n * 4; i < end; i += 4, k += 4) {
        const a = data[i + 3] / 255;
        if (a <= 0) continue;
        const s = a / 255;
        buf[k] = data[i] * s;
        buf[k + 1] = data[i + 1] * s;
        buf[k + 2] = data[i + 2] * s;
        buf[k + 3] = a;
      }
    });
    return buf;
  }
}

/** Where a layer can affect pixels: its own (or its contents') stored pixels, or everywhere for adjustments. */
function extent(l: Layer, everywhere: Rect): Rect {
  if (l.content.kind === "adjustment") return everywhere;
  if (isGroup(l)) return l.content.layers.reduce((r, c) => union(r, extent(c, everywhere)), EMPTY_RECT);
  return storedBounds(l.pixels);
}

/** Renders layers (as one isolated stack) into pixels over `area`. */
export const renderLayers = (layers: readonly Layer[], area: Rect): Pixels =>
  isEmpty(area) ? new Map() : pixelsFromImage(area.w, area.h, flatten({ width: 0, height: 0, layers }, area, layers), area.x, area.y);

/** How a layer looks on its own: shown, unclipped, at full opacity in Normal mode (its mask still applies). */
const alone = (l: Layer): Layer => ({ ...l, visible: true, clipped: false, opacity: 1, blendMode: "normal" });

/**
 * Merge Down (Ctrl+E), as Photoshop does it:
 * - a layer merges into the one below it, which keeps its name and
 *   properties (an adjustment layer merging down applies to it);
 * - on a clipping group's base, Merge Clipping Mask: the clipped layers
 *   merge into the base;
 * - on a group, Merge Group: its contents become one layer.
 */
export function mergeDown(d: Doc, id: string): Doc {
  const p = locate(d.layers, id);
  if (!p) return d;
  const { siblings, index } = p;
  const top = siblings[index];
  if (isGroup(top)) return mergeGroup(d, id);
  let end = index + 1;
  while (end < siblings.length && siblings[end].clipped) end++;
  if (end > index + 1 && !isClipped(siblings, index)) return mergeRange(d, siblings.slice(index, end));
  const below = siblings[index - 1];
  if (!below || !hasPixels(below)) return d;
  return mergeRange(d, [below, { ...top, clipped: top.clipped && !below.clipped }]);
}

/** Merges `[into, ...rest]` (adjacent siblings) into `into`'s pixels. */
function mergeRange(d: Doc, [into, ...rest]: readonly Layer[]): Doc {
  if (!hasPixels(into)) return d;
  const everywhere = rect(0, 0, d.width, d.height);
  // Everything either stores, which may extend past the canvas.
  const area = [into, ...rest].reduce((r, l) => union(r, l.content.kind === "adjustment" ? storedBounds(into.pixels) : extent(l, everywhere)), storedBounds(into.pixels));
  const pixels = renderLayers([alone(into), ...rest], area);
  const ids = new Set(rest.map((l) => l.id));
  const merged: Layer = { ...into, pixels, content: PIXELS, mask: null };
  const layers = filterTree(updateIn(d.layers, into.id, () => merged), (l) => !ids.has(l.id));
  return { ...d, layers, activeLayerId: into.id };
}

/** Merge Group: the group becomes a pixel layer of its rendered contents, keeping its opacity and (non pass-through) mode. */
export function mergeGroup(d: Doc, id: string): Doc {
  const g = findLayer(d.layers, id);
  if (!g || !isGroup(g)) return d;
  const pixels = renderLayers([{ ...alone(g), mask: null }], extent(g, rect(0, 0, d.width, d.height)));
  const layer: Layer = { ...g, pixels, content: PIXELS, blendMode: g.blendMode === "pass through" ? "normal" : g.blendMode };
  return { ...d, layers: updateIn(d.layers, id, () => layer), activeLayerId: id };
}

function filterTree(layers: readonly Layer[], keep: (l: Layer) => boolean): readonly Layer[] {
  return layers.filter(keep).map((l) => (isGroup(l) ? { ...l, content: { ...l.content, layers: filterTree(l.content.layers, keep) } } : l));
}

/**
 * Applies an adjustment to pixels directly (Image ▸ Adjustments), within
 * the selection's coverage when there is one. Transparency is kept.
 */
export function adjustPixels(pixels: Pixels, p: Program, selection: Mask | null): Pixels {
  const w = tileWriter(pixels);
  const o = [0, 0, 0];
  const area = selection ? selection.bounds : storedBounds(pixels);
  const sb = selection?.bounds;
  writeSpans(
    w,
    area,
    (d, i, x, y, n) => {
      for (let m = sb ? (y - sb.y) * sb.w + (x - sb.x) : 0, end = i + n * 4; i < end; i += 4, m++) {
        if (!d[i + 3]) continue;
        const k = selection ? selection.data[m] / 255 : 1;
        if (k <= 0) continue;
        applyProgram(p, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, o);
        d[i] += (o[0] * 255 - d[i]) * k;
        d[i + 1] += (o[1] * 255 - d[i + 1]) * k;
        d[i + 2] += (o[2] * 255 - d[i + 2]) * k;
      }
    },
    { stored: true },
  );
  return w.finish();
}

/** Apply Layer Mask: the mask's coverage multiplied into the layer's transparency. */
export function applyMask(pixels: Pixels, mask: LayerMask): Pixels {
  const read = pixelReader(mask.pixels);
  const bg = mask.background;
  const w = tileWriter(pixels);
  writeSpans(
    w,
    storedBounds(pixels),
    (d, i, x0, y, n) => {
      for (let x = x0, a = i + 3; x < x0 + n; x++, a += 4) {
        if (!d[a]) continue;
        const p = read(x, y), ma = p >>> 24;
        d[a] = (d[a] * ((p & 255) * ma + bg * (255 - ma))) / (255 * 255);
      }
    },
    { stored: true },
  );
  return w.finish();
}

/** Histogram of pixel values over all three channels (weighted by alpha and the selection's coverage). */
export function histogram(pixels: Pixels, selection: Mask | null): Float64Array {
  const h = new Float64Array(256);
  const sb = selection?.bounds;
  readSpans(pixels, sb ?? storedBounds(pixels), (d, i, x, y, n) => {
    for (let m = sb ? (y - sb.y) * sb.w + (x - sb.x) : 0, end = i + n * 4; i < end; i += 4, m++) {
      const w = d[i + 3] * (selection ? selection.data[m] : 255);
      if (!w) continue;
      h[d[i]] += w;
      h[d[i + 1]] += w;
      h[d[i + 2]] += w;
    }
  });
  return h;
}

/** Per-channel histograms (and luminosity's), counts per value 0–255. */
export interface Histograms {
  readonly rgb: Float64Array;
  readonly red: Float64Array;
  readonly green: Float64Array;
  readonly blue: Float64Array;
  readonly luminosity: Float64Array;
}

/**
 * Histograms of what `read` returns (straight RGBA) over `area`, from at
 * most `rows` evenly spaced rows: enough for Levels and Curves to show the
 * image's distribution, at a fraction of the cost of reading it all.
 */
export function sampleHistograms(read: (r: Rect) => Uint8ClampedArray, area: Rect, rows = 256): Histograms {
  const h = { rgb: new Float64Array(256), red: new Float64Array(256), green: new Float64Array(256), blue: new Float64Array(256), luminosity: new Float64Array(256) };
  const n = Math.min(rows, area.h);
  for (let k = 0; k < n; k++) {
    const d = read(rect(area.x, area.y + Math.floor(((k + 0.5) * area.h) / n), area.w, 1));
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (!a) continue;
      h.red[d[i]] += a;
      h.green[d[i + 1]] += a;
      h.blue[d[i + 2]] += a;
      h.luminosity[Math.round(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2])] += a;
    }
  }
  for (let i = 0; i < 256; i++) h.rgb[i] = h.red[i] + h.green[i] + h.blue[i];
  return h;
}

/** The layer tree as seen from beneath `id`: it, and everything above it, hidden (what an adjustment layer there adjusts). */
export function layersBelow(layers: readonly Layer[], id: string): readonly Layer[] {
  const p = locate(layers, id);
  if (!p) return layers;
  const hide = (s: readonly Layer[], from: number) => s.map((l, i) => (i >= from ? { ...l, visible: false } : l));
  let out = hide(p.siblings, p.index);
  for (let g = p.parent; g; ) {
    const gp = locate(layers, g.id)!;
    const group: Layer = { ...g, content: { ...g.content, layers: out } };
    out = hide(gp.siblings, gp.index + 1).map((l, i) => (i === gp.index ? group : l));
    g = gp.parent;
  }
  return out;
}
