import { createLayer, docRect, flatten, type Doc } from "../core/document";
import { tilesFromImage } from "../core/tiles";
import { NATIVE_EXTENSION, decodeNative, encodeNative, isNative } from "./native";

/** Formats the Open dialog accepts. */
export const OPEN_ACCEPT = `.${NATIVE_EXTENSION},.psd,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif`;

const isPsd = (b: Uint8Array) => b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53; // "8BPS"

/** Decodes any supported file, sniffing the format from its contents. */
export async function readDocument(file: Blob): Promise<Doc> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isNative(bytes)) return decodeNative(bytes);
  if (isPsd(bytes)) return (await import("./psd")).readPsdDocument(bytes);
  return decodeImage(file);
}

export async function decodeImage(file: Blob): Promise<Doc> {
  const bitmap = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const { width, height } = bitmap;
  const ctx = new OffscreenCanvas(width, height).getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  const layer = createLayer({ name: "Background", tiles: tilesFromImage(width, height, data) });
  return { width, height, layers: [layer], activeLayerId: layer.id, selection: null };
}

export type ExportFormat = "png" | "jpeg" | "webp" | "psd";

export const EXTENSIONS: Record<ExportFormat | "native", string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
  psd: "psd",
  native: NATIVE_EXTENSION,
};

export async function encodeDocument(doc: Doc, format: ExportFormat | "native", quality = 0.92): Promise<Blob> {
  if (format === "native") return new Blob([(await encodeNative(doc)) as Uint8Array<ArrayBuffer>]);
  if (format === "psd") return new Blob([(await import("./psd")).writePsdDocument(doc)]);
  const pixels = flatten(doc, docRect(doc));
  const canvas = new OffscreenCanvas(doc.width, doc.height);
  const ctx = canvas.getContext("2d")!;
  if (format === "jpeg") {
    // JPEG has no alpha; composite onto white like Photoshop does.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    const tmp = new OffscreenCanvas(doc.width, doc.height);
    tmp.getContext("2d")!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, doc.width, doc.height), 0, 0);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, doc.width, doc.height), 0, 0);
  }
  return canvas.convertToBlob({ type: `image/${format}`, quality });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const stripExtension = (name: string) => name.replace(/\.[^./\\]+$/, "");

export function pickFiles(accept = OPEN_ACCEPT): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}
