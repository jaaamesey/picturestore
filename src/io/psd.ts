import {
  initializeCanvas,
  readPsd,
  writePsd,
  type BezierPath,
  type Color as PsdColor,
  type LinkedFile,
  type Layer as PsdLayer,
  type PixelData,
  type Psd,
} from "ag-psd";
import { isBlendMode } from "../core/blend";
import type { RGB } from "../core/color";
import { placementMapping } from "../core/content";
import { PIXELS, resolutionOf, createLayer, docRect, flatten, type Doc, type Layer, type LayerContent, type SmartSource } from "../core/document";
import { boundsOf, isEmpty, rect, vec, type Vec2 } from "../core/geometry";
import { documentKnots, type Knot, type ShapeStyle } from "../core/shape";
import { EMPTY_TILES, contentBounds, readRect, tilesFromImage, type TileMap } from "../core/tiles";
import { isIdentityPatch, quadOf, type Patch, type Quad } from "../core/warp";

// ag-psd allocates pixel buffers through these hooks. Plain buffers avoid canvas
// premultiplication losses and work outside the browser (tests, workers).
initializeCanvas(
  (width, height) => {
    if (typeof OffscreenCanvas === "undefined") throw new Error("Canvas is unavailable in this environment");
    return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData,
);

/** Normalises 8/16/32-bit channel data to 8-bit RGBA. */
function to8bit({ data }: PixelData): Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray) return data;
  if (data instanceof Uint8Array) return new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  if (data instanceof Uint16Array) return Uint8ClampedArray.from(data, (v) => v >> 8);
  return Uint8ClampedArray.from(data, (v) => v * 255);
}

/** Bakes an enabled layer mask into the layer's alpha. */
function applyMask(pixels: Uint8ClampedArray, layer: PsdLayer): void {
  const mask = layer.mask;
  if (!mask?.imageData || mask.disabled) return;
  const w = (layer.right ?? 0) - (layer.left ?? 0);
  const m = to8bit(mask.imageData);
  const mw = mask.imageData.width;
  const mx = mask.left ?? 0;
  const my = mask.top ?? 0;
  for (let i = 0; i < pixels.length / 4; i++) {
    const x = (layer.left ?? 0) + (i % w) - mx;
    const y = (layer.top ?? 0) + Math.floor(i / w) - my;
    const inside = x >= 0 && y >= 0 && x < mw && y < mask.imageData.height;
    const v = inside ? m[(y * mw + x) * 4] : (mask.defaultColor ?? 255);
    pixels[i * 4 + 3] = (pixels[i * 4 + 3] * v) / 255;
  }
}

/** Decodes an embedded image file (PNG, JPEG…) to RGBA. Null when the format isn't supported. */
export type ImageDecoder = (bytes: Uint8Array) => Promise<{ width: number; height: number; pixels: Uint8ClampedArray } | null>;

/** Browser/worker decoder; unavailable (null) in plain Node. */
export const decodeImageBytes: ImageDecoder = async (bytes) => {
  if (typeof createImageBitmap === "undefined") return null;
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width, height, pixels: ctx.getImageData(0, 0, width, height).data };
};

const isPsdBytes = (b: Uint8Array) => b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53; // "8BPS"
const isPngBytes = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpegBytes = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

function mimeOf(b: Uint8Array): string {
  if (isPsdBytes(b)) return "image/vnd.adobe.photoshop";
  if (isPngBytes(b)) return "image/png";
  if (isJpegBytes(b)) return "image/jpeg";
  return "application/octet-stream";
}

/** Smart object contents from an embedded file: a PSD is composited, images decoded. */
async function readSource(f: LinkedFile, decode: ImageDecoder): Promise<SmartSource | null> {
  const bytes = f.data;
  if (!bytes || bytes.length < 4) return null;
  let width: number, height: number, tiles: TileMap;
  if (isPsdBytes(bytes)) {
    const inner = await readPsdDocument(bytes, decode);
    ({ width, height } = inner);
    tiles = tilesFromImage(width, height, flatten(inner));
  } else {
    const img = await decode(bytes);
    if (!img) return null;
    ({ width, height } = img);
    tiles = tilesFromImage(width, height, img.pixels);
  }
  return { id: f.id, name: f.name.replace(/\.[^.]+$/, ""), width, height, tiles, file: { bytes, type: f.type?.trim() || mimeOf(bytes) } };
}

const quadFrom = (t: readonly number[]): Quad => [vec(t[0], t[1]), vec(t[2], t[3]), vec(t[4], t[5]), vec(t[6], t[7])];

/** A placed layer's warp as our patch: only Photoshop's "custom" warp is a 4×4 mesh; presets aren't supported. */
function warpPatch(c: PsdLayer["placedLayer"], w: number, h: number): Patch | null | undefined {
  const warp = c?.warp;
  if (!warp || warp.style === "none" || !warp.style) return null;
  const mesh = warp.customEnvelopeWarp?.meshPoints;
  if (warp.style !== "custom" || !mesh || mesh.length !== 16) return undefined;
  const b = warp.bounds;
  const x0 = b?.left.value ?? 0, y0 = b?.top.value ?? 0;
  const bw = b ? b.right.value - x0 : w, bh = b ? b.bottom.value - y0 : h;
  const patch = mesh.map((p) => vec((p.x - x0) / bw, (p.y - y0) / bh));
  return isIdentityPatch(patch) ? null : patch;
}

function smartContent(c: PsdLayer, sources: Map<string, SmartSource>): LayerContent | null {
  const p = c.placedLayer;
  const source = p && sources.get(p.id);
  if (!p || !source || p.transform?.length !== 8) return null;
  const w = p.width ?? source.width, h = p.height ?? source.height;
  const patch = warpPatch(p, w, h);
  if (patch === undefined) return null;
  const quad = quadFrom(p.transform);
  const angle = Math.atan2(quad[1].y - quad[0].y, quad[1].x - quad[0].x);
  return { kind: "smart", source, placement: { source: rect(0, 0, source.width, source.height), quad, angle, patch } };
}

function rgbOf(c: PsdColor | undefined): RGB | null {
  if (!c || !("r" in c)) return null;
  // ag-psd uses 0–255 for RGB(A) and 0–1 floats for FRGB.
  const f = "fr" in c ? 255 : 1;
  const v = c as { r: number; g: number; b: number };
  return { r: Math.round(v.r * f), g: Math.round(v.g * f), b: Math.round(v.b * f) };
}

/** A solid-colour shape layer (vector mask + fill/stroke). Gradients, patterns and path booleans import as pixels. */
function shapeContent(c: PsdLayer): LayerContent | null {
  const mask = c.vectorMask;
  if (!mask || mask.invert || !c.vectorFill || c.vectorFill.type !== "color") return null;
  if (mask.paths.some((p) => p.open || (p.operation && p.operation !== "combine"))) return null;
  const contours: Knot[][] = mask.paths.map((p) =>
    p.knots.map(({ points: q }) => ({ in: vec(q[0], q[1]), anchor: vec(q[2], q[3]), out: vec(q[4], q[5]) })),
  );
  const pts = contours.flat().flatMap((k) => [k.anchor, k.in, k.out]);
  if (pts.length === 0) return null;
  const s = c.vectorStroke;
  const fill = s?.fillEnabled === false ? null : rgbOf(c.vectorFill.color);
  const strokeColor = s?.content?.type === "color" ? rgbOf(s.content.color) : null;
  const style: ShapeStyle = {
    fill,
    stroke:
      s?.strokeEnabled && strokeColor
        ? { color: strokeColor, width: s.lineWidth?.value ?? 1, align: s.lineAlignment ?? "inside" }
        : null,
  };
  // Contours are kept in document coordinates: the source box is their bounds, placed where it is.
  const box = boundsOf(pts);
  if (isEmpty(box)) return null;
  return {
    kind: "shape",
    geometry: { kind: "path", contours },
    style,
    placement: { source: box, quad: quadOf(box), angle: 0, patch: null },
  };
}

/**
 * Reads a PSD into a document. Groups are flattened into the layer list (a
 * hidden or translucent group hides/fades its children); layer masks are
 * baked into alpha. Embedded smart objects (with custom warps) and
 * solid-colour shape layers stay live; text, adjustment layers and anything
 * else import as their rendered pixels.
 */
export async function readPsdDocument(buffer: ArrayBuffer | Uint8Array, decode: ImageDecoder = decodeImageBytes): Promise<Doc> {
  const psd = readPsd(buffer, { useImageData: true, skipThumbnail: true });
  const sources = new Map<string, SmartSource>();
  for (const f of psd.linkedFiles ?? []) {
    const src = await readSource(f, decode).catch(() => null);
    if (src) sources.set(f.id, src);
  }
  const layers: Layer[] = [];
  const walk = (children: PsdLayer[], visible: boolean, opacity: number) => {
    for (const c of children) {
      const v = visible && !c.hidden;
      const o = opacity * (c.opacity ?? 1);
      if (c.children) {
        walk(c.children, v, o);
        continue;
      }
      let tiles = EMPTY_TILES;
      if (c.imageData && c.imageData.width > 0 && c.imageData.height > 0) {
        const pixels = new Uint8ClampedArray(to8bit(c.imageData));
        applyMask(pixels, c);
        tiles = tilesFromImage(c.imageData.width, c.imageData.height, pixels, c.left ?? 0, c.top ?? 0);
      }
      // Photoshop's own rendering is kept as the layer's pixels; the content stays editable.
      const content = smartContent(c, sources) ?? shapeContent(c) ?? PIXELS;
      layers.push(
        createLayer({
          name: c.name ?? `Layer ${layers.length + 1}`,
          visible: v,
          opacity: o,
          blendMode: c.blendMode && isBlendMode(c.blendMode) ? c.blendMode : "normal",
          tiles,
          content,
        }),
      );
    }
  };
  walk(psd.children ?? [], true, 1);

  if (layers.length === 0 && psd.imageData) {
    layers.push(createLayer({ name: "Background", tiles: tilesFromImage(psd.width, psd.height, to8bit(psd.imageData)) }));
  }
  if (layers.length === 0) layers.push(createLayer({ name: "Layer 1" }));
  const res = psd.imageResources?.resolutionInfo;
  // Stored as pixels per inch or per centimetre; documents keep ppi.
  const resolution = res ? (res.horizontalResolutionUnit === "PPCM" ? res.horizontalResolution * 2.54 : res.horizontalResolution) : undefined;
  // Guides: ag-psd's "vertical" is a guide at x, as ours.
  const stored = psd.imageResources?.gridAndGuidesInformation?.guides ?? [];
  const guides = stored.length ? stored.map((g) => ({ orientation: g.direction, position: g.location })) : undefined;
  return { width: psd.width, height: psd.height, layers, activeLayerId: layers[layers.length - 1].id, selection: null, resolution, guides };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** A smart object's file to embed: the original if we have it, else its pixels as a single-layer PSD (like Photoshop's .psb). */
function linkedFile(src: SmartSource): LinkedFile {
  if (src.file) {
    const ext = isPsdBytes(src.file.bytes) ? "psb" : (EXT[src.file.type] ?? "bin");
    return { id: src.id, name: `${src.name}.${ext}`, type: src.file.type, data: src.file.bytes };
  }
  const data = new Uint8Array(
    writePsd(
      {
        width: src.width,
        height: src.height,
        children: [{ name: src.name, left: 0, top: 0, right: src.width, bottom: src.height, imageData: { width: src.width, height: src.height, data: readRect(src.tiles, rect(0, 0, src.width, src.height)) } }],
        imageData: { width: src.width, height: src.height, data: readRect(src.tiles, rect(0, 0, src.width, src.height)) },
      },
      { generateThumbnail: false, noBackground: true },
    ),
  );
  return { id: src.id, name: `${src.name}.psb`, type: "image/vnd.adobe.photoshop", data };
}

const psdColor = (c: RGB) => ({ r: c.r, g: c.g, b: c.b });
const flatQuad = (q: Quad) => q.flatMap((p: Vec2) => [p.x, p.y]);

function contentFields(content: LayerContent, linked: Map<string, LinkedFile>): Partial<PsdLayer> {
  switch (content.kind) {
    case "pixels":
      return {};
    case "smart": {
      const { source, placement } = content;
      if (!linked.has(source.id)) linked.set(source.id, linkedFile(source));
      const { w, h } = placement.source;
      const patch = placement.patch;
      return {
        placedLayer: {
          id: source.id,
          placed: crypto.randomUUID(),
          type: "raster",
          transform: flatQuad(placement.quad),
          width: source.width,
          height: source.height,
          ...(patch && !isIdentityPatch(patch)
            ? {
                warp: {
                  style: "custom",
                  bounds: {
                    top: { units: "Pixels", value: 0 },
                    left: { units: "Pixels", value: 0 },
                    bottom: { units: "Pixels", value: h },
                    right: { units: "Pixels", value: w },
                  },
                  uOrder: 4,
                  vOrder: 4,
                  customEnvelopeWarp: { meshPoints: patch.map((p) => ({ x: p.x * w, y: p.y * h })) },
                },
              }
            : {}),
        },
      };
    }
    case "shape": {
      const { style } = content;
      const paths: BezierPath[] = documentKnots(content.geometry, placementMapping(content.placement)).map((c) => ({
        open: false,
        operation: "combine",
        fillRule: "non-zero",
        knots: c.map((k) => ({ linked: true, points: [k.in.x, k.in.y, k.anchor.x, k.anchor.y, k.out.x, k.out.y] })),
      }));
      return {
        vectorMask: { paths },
        vectorFill: { type: "color", color: psdColor(style.fill ?? { r: 0, g: 0, b: 0 }) },
        vectorStroke: {
          strokeEnabled: !!style.stroke,
          fillEnabled: !!style.fill,
          lineWidth: { units: "Pixels", value: style.stroke?.width ?? 0 },
          lineAlignment: style.stroke?.align ?? "inside",
          lineJoinType: "miter",
          lineCapType: "butt",
          miterLimit: 4,
          content: { type: "color", color: psdColor(style.stroke?.color ?? { r: 0, g: 0, b: 0 }) },
        },
      };
    }
  }
}

export function writePsdDocument(doc: Doc): ArrayBuffer {
  const linked = new Map<string, LinkedFile>();
  const children: PsdLayer[] = doc.layers.map((l) => {
    const b = contentBounds(l.tiles);
    const base = { name: l.name, opacity: l.opacity, blendMode: l.blendMode, hidden: !l.visible, ...contentFields(l.content, linked) };
    if (isEmpty(b)) return { ...base, left: 0, top: 0, right: 0, bottom: 0 };
    return {
      ...base,
      left: b.x,
      top: b.y,
      right: b.x + b.w,
      bottom: b.y + b.h,
      imageData: { width: b.w, height: b.h, data: readRect(l.tiles, b) },
    };
  });
  const psd: Psd = {
    width: doc.width,
    height: doc.height,
    children,
    imageData: { width: doc.width, height: doc.height, data: flatten(doc, docRect(doc)) },
  };
  if (linked.size) psd.linkedFiles = [...linked.values()];
  const ppi = resolutionOf(doc);
  psd.imageResources = {
    resolutionInfo: { horizontalResolution: ppi, horizontalResolutionUnit: "PPI", widthUnit: "Inches", verticalResolution: ppi, verticalResolutionUnit: "PPI", heightUnit: "Inches" },
  };
  // Positions are stored in 1/32 px, unsigned (by ag-psd), so guides left of or above the canvas can't be.
  const guides = (doc.guides ?? []).filter((g) => g.position >= 0).map((g) => ({ location: Math.round(g.position * 32) / 32, direction: g.orientation }));
  if (guides.length) psd.imageResources.gridAndGuidesInformation = { guides };
  return writePsd(psd, { generateThumbnail: false, noBackground: true });
}
