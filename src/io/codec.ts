import { createLayer, docRect, type Doc } from "../core/document";
import { flatten } from "../core/composite";
import { isOpaque, pixelsFromImage } from "../core/pixels";
import { walk } from "../core/layers";
import type { SaveFormat } from "./formats";
import { readPsdDocument, writePsdDocument } from "./psd";

/**
 * Format sniffing, decoding and encoding. Runs inside the I/O worker
 * (`io.worker.ts`), so it only uses APIs available in workers.
 */
const isPsd = (b: Uint8Array) => b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53; // "8BPS"

export async function decode(file: Blob): Promise<Doc> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPsd(bytes)) return readPsdDocument(bytes);
  const bitmap = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = pixelsFromImage(width, height, ctx.getImageData(0, 0, width, height).data);
  // As Photoshop: an opaque image opens as a Background layer, one with transparency as "Layer 0".
  const layer = isOpaque(pixels, width, height) ? createLayer({ name: "Background", isBackground: true, pixels }) : createLayer({ name: "Layer 0", pixels });
  return { width, height, layers: [layer], activeLayerId: layer.id, selection: null };
}

export async function encode(doc: Doc, format: SaveFormat, quality = 0.92): Promise<Blob> {
  if (format === "psd") return new Blob([writePsdDocument(doc)], { type: "image/vnd.adobe.photoshop" });
  const pixels = flatten(doc, docRect(doc)) as Uint8ClampedArray<ArrayBuffer>;
  const canvas = new OffscreenCanvas(doc.width, doc.height);
  const ctx = canvas.getContext("2d")!;
  const image = new ImageData(pixels, doc.width, doc.height);
  if (format === "jpeg") {
    // JPEG has no alpha; composite onto white like Photoshop does.
    const layer = new OffscreenCanvas(doc.width, doc.height);
    layer.getContext("2d")!.putImageData(image, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.drawImage(layer, 0, 0);
  } else {
    ctx.putImageData(image, 0, 0);
  }
  return canvas.convertToBlob({ type: `image/${format}`, quality });
}

/** Every tile buffer in a document, for zero-copy transfer out of the worker. */
export const transferables = (doc: Doc): ArrayBuffer[] =>
  [...walk(doc.layers)].flatMap((l) => [...l.pixels.values(), ...(l.mask?.pixels.values() ?? [])].map((t) => t.data.buffer as ArrayBuffer));
