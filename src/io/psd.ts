import {
  initializeCanvas,
  readPsd,
  writePsd,
  type BezierPath,
  type LinkedFile,
  type Layer as PsdLayer,
  type LayerMaskData,
  type PixelData,
  type Psd,
} from "ag-psd";
import { isBlendMode } from "../core/blend";
import type { RGB } from "../core/color";
import { pathShape, placementMapping } from "../core/content";
import type { TextContent } from "../text/model";
import { exactContent, textFromPsd, textToPsd, typeFromXmp, typeStylesFromXmp, typeXmp } from "./psdText";
import { PIXELS, resolutionOf, createLayer, docRect, type Doc, type Layer, type LayerContent, type LayerMask, type SmartSource } from "../core/document";
import { fromPsd, rgbOf, toPsd } from "./psdAdjustments";
import { flatten } from "../core/composite";
import { isEmpty, rect, vec, type Vec2 } from "../core/geometry";
import { documentKnots, type Knot, type ShapeStyle } from "../core/shape";
import { NO_PIXELS, contentBounds, readRect, pixelsFromImage, type Pixels } from "../core/pixels";
import { isIdentityPatch, type Patch, type Quad } from "../core/warp";

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

/** A PSD layer mask as ours: grey pixels over its default colour. */
function maskIn(c: PsdLayer): LayerMask | null {
  const m = c.mask;
  if (!m) return null;
  const background = (m.defaultColor ?? 0) >= 128 ? 255 : 0;
  const img = m.imageData;
  const pixels = img && img.width > 0 && img.height > 0 ? pixelsFromImage(img.width, img.height, opaqueGrey(to8bit(img)), m.left ?? 0, m.top ?? 0) : NO_PIXELS;
  const density = m.userMaskDensity;
  return { pixels, background, enabled: !m.disabled, linked: true, ...(density !== undefined && density < 1 && { density }) };
}

const opaqueGrey = (d: Uint8ClampedArray) => {
  const out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) out.set([d[i], d[i], d[i], 255], i);
  return out;
};

/** Our mask as a PSD layer mask: its stored part as opaque grey, the rest its default colour. */
function maskOut(m: LayerMask): LayerMaskData {
  const base: LayerMaskData = { defaultColor: m.background, disabled: !m.enabled, ...(m.density !== undefined && m.density < 1 && { userMaskDensity: m.density }) };
  const b = contentBounds(m.pixels);
  if (isEmpty(b)) return base;
  const data = readRect(m.pixels, b);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    const v = (data[i] * a + m.background * (255 - a)) / 255;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { ...base, left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h, imageData: { width: b.w, height: b.h, data } };
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
  let width: number, height: number, pixels: Pixels;
  if (isPsdBytes(bytes)) {
    const inner = await readPsdDocument(bytes, decode);
    ({ width, height } = inner);
    pixels = pixelsFromImage(width, height, flatten(inner));
  } else {
    const img = await decode(bytes);
    if (!img) return null;
    ({ width, height } = img);
    pixels = pixelsFromImage(width, height, img.pixels);
  }
  return { id: f.id, name: f.name.replace(/\.[^.]+$/, ""), width, height, pixels, file: { bytes, type: f.type?.trim() || mimeOf(bytes) } };
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

/** A solid-colour shape layer (vector mask + fill/stroke). Gradients, patterns and path booleans import as pixels. */
function shapeContent(c: PsdLayer): LayerContent | null {
  const mask = c.vectorMask;
  if (!mask || mask.invert || !c.vectorFill || c.vectorFill.type !== "color") return null;
  if (mask.paths.some((p) => p.open || (p.operation && p.operation !== "combine"))) return null;
  const contours: Knot[][] = mask.paths.map((p) =>
    p.knots.map(({ points: q }) => ({ in: vec(q[0], q[1]), anchor: vec(q[2], q[3]), out: vec(q[4], q[5]) })),
  );
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
  return pathShape(contours, style);
}

/**
 * Reads a PSD into a document: groups (nested, pass-through or not),
 * clipping masks, layer masks and adjustment layers stay as they are.
 * Embedded smart objects (with custom warps), solid-colour shape layers
 * and type stay live (see ./psdText.ts); fill layers and anything else
 * import as their rendered pixels.
 */
export async function readPsdDocument(buffer: ArrayBuffer | Uint8Array, decode: ImageDecoder = decodeImageBytes): Promise<Doc> {
  const psd = readPsd(buffer, { useImageData: true, skipThumbnail: true });
  const sources = new Map<string, SmartSource>();
  for (const f of psd.linkedFiles ?? []) {
    const src = await readSource(f, decode).catch(() => null);
    if (src) sources.set(f.id, src);
  }
  let count = 0;
  const written = typeFromXmp(psd.imageResources?.xmpMetadata);
  let typeIndex = 0;
  const read = (children: PsdLayer[]): Layer[] =>
    children.map((c) => {
      const common = {
        name: c.name ?? `Layer ${++count}`,
        visible: !c.hidden,
        opacity: c.opacity ?? 1,
        blendMode: c.blendMode && isBlendMode(c.blendMode) ? c.blendMode : ("normal" as const),
        clipped: !!c.clipping,
        mask: maskIn(c),
      };
      if (c.children) {
        const blendMode = c.blendMode === "pass through" ? ("pass through" as const) : common.blendMode;
        return createLayer({ ...common, blendMode, content: { kind: "group", layers: read(c.children), open: !!c.opened } });
      }
      const adjustment = c.adjustment && fromPsd(c.adjustment);
      if (adjustment) return createLayer({ ...common, content: { kind: "adjustment", adjustment } });
      let pixels = NO_PIXELS;
      if (c.imageData && c.imageData.width > 0 && c.imageData.height > 0) {
        pixels = pixelsFromImage(c.imageData.width, c.imageData.height, new Uint8ClampedArray(to8bit(c.imageData)), c.left ?? 0, c.top ?? 0);
      }
      // Photoshop's own rendering is kept as the layer's pixels; the content stays editable.
      const text = c.text && textFromPsd(c.text);
      const content = (text && (exactContent(text, written[typeIndex++]) ?? text)) || smartContent(c, sources) || shapeContent(c) || PIXELS;
      return createLayer({ ...common, pixels, content });
    });
  const layers = read(psd.children ?? []);
  if (layers.length === 0 && psd.imageData) {
    layers.push(createLayer({ name: "Background", pixels: pixelsFromImage(psd.width, psd.height, to8bit(psd.imageData)) }));
  }
  if (layers.length === 0) layers.push(createLayer({ name: "Layer 1" }));
  const res = psd.imageResources?.resolutionInfo;
  // Stored as pixels per inch or per centimetre; documents keep ppi.
  const resolution = res ? (res.horizontalResolutionUnit === "PPCM" ? res.horizontalResolution * 2.54 : res.horizontalResolution) : undefined;
  // Guides: ag-psd's "vertical" is a guide at x, as ours.
  const stored = psd.imageResources?.gridAndGuidesInformation?.guides ?? [];
  const guides = stored.length ? stored.map((g) => ({ orientation: g.direction, position: g.location })) : undefined;
  const textStyles = typeStylesFromXmp(psd.imageResources?.xmpMetadata);
  return { width: psd.width, height: psd.height, layers, activeLayerId: layers[layers.length - 1].id, selection: null, resolution, guides, ...(textStyles && { textStyles }) };
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
        children: [{ name: src.name, left: 0, top: 0, right: src.width, bottom: src.height, imageData: { width: src.width, height: src.height, data: readRect(src.pixels, rect(0, 0, src.width, src.height)) } }],
        imageData: { width: src.width, height: src.height, data: readRect(src.pixels, rect(0, 0, src.width, src.height)) },
      },
      { generateThumbnail: false, noBackground: true },
    ),
  );
  return { id: src.id, name: `${src.name}.psb`, type: "image/vnd.adobe.photoshop", data };
}

const psdColor = (c: RGB) => ({ r: c.r, g: c.g, b: c.b });
const flatQuad = (q: Quad) => q.flatMap((p: Vec2) => [p.x, p.y]);

/** What writing collects across layers: smart objects' files, and type layers' exact content (for XMP). */
type Written = Map<string, LinkedFile> & { typeLayers: TextContent[] };

function contentFields(content: LayerContent, linked: Written): Partial<PsdLayer> {
  switch (content.kind) {
    case "pixels":
      return {};
    case "group":
      return { opened: content.open, children: content.layers.map((l) => layerOut(l, linked)) };
    case "adjustment":
      return { adjustment: toPsd(content.adjustment) };
    case "text":
      linked.typeLayers.push(content);
      return { text: textToPsd(content) };
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

function layerOut(l: Layer, linked: Written): PsdLayer {
  const base: PsdLayer = {
    name: l.name,
    opacity: l.opacity,
    blendMode: l.blendMode,
    hidden: !l.visible,
    clipping: l.clipped,
    ...(l.mask && { mask: maskOut(l.mask) }),
    ...contentFields(l.content, linked),
  };
  const b = contentBounds(l.pixels);
  if (isEmpty(b)) return { ...base, left: 0, top: 0, right: 0, bottom: 0 };
  return { ...base, left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h, imageData: { width: b.w, height: b.h, data: readRect(l.pixels, b) } };
}

export function writePsdDocument(doc: Doc): ArrayBuffer {
  const linked: Written = Object.assign(new Map<string, LinkedFile>(), { typeLayers: [] as TextContent[] });
  const children = doc.layers.map((l) => layerOut(l, linked));
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
  if (linked.typeLayers.length || doc.textStyles?.character.length || doc.textStyles?.paragraph.length) psd.imageResources.xmpMetadata = typeXmp(linked.typeLayers, doc.textStyles);
  return writePsd(psd, { generateThumbnail: false, noBackground: true });
}
