import { initializeCanvas, readPsd, writePsd, type Layer as PsdLayer, type PixelData } from "ag-psd";
import { isBlendMode } from "../core/blend";
import { createLayer, docRect, flatten, type Doc, type Layer } from "../core/document";
import { isEmpty } from "../core/geometry";
import { EMPTY_TILES, contentBounds, readRect, tilesFromImage } from "../core/tiles";

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

/**
 * Reads a PSD into a document. Groups are flattened into the layer list (a
 * hidden or translucent group hides/fades its children); layer masks are
 * baked into alpha. Text, adjustment and smart-object layers import as their
 * rendered pixels.
 */
export function readPsdDocument(buffer: ArrayBuffer | Uint8Array): Doc {
  const psd = readPsd(buffer, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
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
      layers.push(
        createLayer({
          name: c.name ?? `Layer ${layers.length + 1}`,
          visible: v,
          opacity: o,
          blendMode: c.blendMode && isBlendMode(c.blendMode) ? c.blendMode : "normal",
          tiles,
        }),
      );
    }
  };
  walk(psd.children ?? [], true, 1);

  if (layers.length === 0 && psd.imageData) {
    layers.push(createLayer({ name: "Background", tiles: tilesFromImage(psd.width, psd.height, to8bit(psd.imageData)) }));
  }
  if (layers.length === 0) layers.push(createLayer({ name: "Layer 1" }));
  return { width: psd.width, height: psd.height, layers, activeLayerId: layers[layers.length - 1].id, selection: null };
}

export function writePsdDocument(doc: Doc): ArrayBuffer {
  const children: PsdLayer[] = doc.layers.map((l) => {
    const b = contentBounds(l.tiles);
    const base = { name: l.name, opacity: l.opacity, blendMode: l.blendMode, hidden: !l.visible };
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
  return writePsd(
    {
      width: doc.width,
      height: doc.height,
      children,
      imageData: { width: doc.width, height: doc.height, data: flatten(doc, docRect(doc)) },
    },
    { generateThumbnail: false, noBackground: true },
  );
}
