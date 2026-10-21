import { createLayer, docRect, flatten, type Doc } from "../core/document";
import { pixelsFromImage } from "../core/pixels";
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
  const layer = createLayer({ name: "Background", pixels: pixelsFromImage(width, height, ctx.getImageData(0, 0, width, height).data) });
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
  doc.layers.flatMap((l) => [...l.pixels.values()].map((t) => t.data.buffer as ArrayBuffer));
