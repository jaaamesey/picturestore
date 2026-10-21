import { smartSource } from "../core/content";
import { createLayer, flatten, type Doc, type SmartSource } from "../core/document";
import type { Floating } from "../core/raster";
import { readRect, pixelsFromImage, type Pixels } from "../core/pixels";
import type { SaveFormat } from "./formats";
import type { Request, Response } from "./io.worker";

export { EXTENSIONS, type ExportFormat, type SaveFormat } from "./formats";

/** Formats the Open dialog accepts. PSD is the native format. */
export const OPEN_TYPES = [".psd", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"];

// --- I/O worker client -------------------------------------------------------

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: Doc | Blob) => void; reject: (e: Error) => void }>();

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

function call(req: WithoutId<Request>): Promise<Doc | Blob> {
  if (!worker) {
    worker = new Worker(new URL("./io.worker.ts", import.meta.url), { type: "module" });
    // A worker that dies (e.g. out of memory encoding a huge document) fails what it held, and is replaced on next use.
    worker.onerror = (e) => {
      e.preventDefault();
      for (const p of pending.values()) p.reject(new Error("The file worker stopped unexpectedly (possibly out of memory)."));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    worker.onmessage = ({ data }: MessageEvent<Response>) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) p?.resolve(data.result);
      else p?.reject(new Error(data.error));
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...req, id } as Request);
  });
}

/** Decodes a PSD or image off the main thread. */
export const readDocument = (file: Blob) => call({ op: "decode", file }) as Promise<Doc>;

/** Encodes off the main thread. Tiles are copied to the worker (history still shares them). */
export const encodeDocument = (doc: Doc, format: SaveFormat) => call({ op: "encode", doc, format }) as Promise<Blob>;

/** A document's pixels as one image: the layer itself when that's exact, else the composite. */
function compositeTiles(doc: Doc): Pixels {
  const [only] = doc.layers;
  const plain = doc.layers.length === 1 && only.visible && only.opacity === 1 && only.blendMode === "normal";
  return plain ? only.pixels : pixelsFromImage(doc.width, doc.height, flatten(doc));
}

/** Decodes an image (or PSD, composited) as smart object contents, keeping the file to embed. */
export async function readSmartSource(file: File): Promise<SmartSource> {
  const [doc, bytes] = await Promise.all([readDocument(file), file.arrayBuffer()]);
  const type = file.type || (isPsdName(file.name) ? "image/vnd.adobe.photoshop" : "application/octet-stream");
  return smartSource(stripExtension(file.name), doc.width, doc.height, compositeTiles(doc), { bytes: new Uint8Array(bytes), type });
}

/** Decodes an image into pixels (e.g. pasted from another application). */
export const readImageTiles = async (file: Blob): Promise<Pixels> => compositeTiles(await readDocument(file));

/** A smart object's contents as a document, for Edit Contents. Embedded PSDs keep their layers. */
export async function smartSourceDocument(source: SmartSource): Promise<Doc> {
  if (source.file && isPsdBytes(source.file.bytes)) return readDocument(new Blob([source.file.bytes as Uint8Array<ArrayBuffer>]));
  const layer = createLayer({ name: "Layer 0", pixels: source.pixels });
  return { width: source.width, height: source.height, layers: [layer], activeLayerId: layer.id, selection: null };
}

/** PNG for the system clipboard. */
export async function encodePng(f: Floating): Promise<Blob> {
  const { w, h } = f.bounds;
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.putImageData(new ImageData(readRect(f.pixels, f.bounds) as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

const isPsdBytes = (b: Uint8Array) => b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53; // "8BPS"

// --- Files on disk -------------------------------------------------------------

export interface OpenedFile {
  readonly file: File;
  /** Present when the browser supports saving back in place (File System Access API). */
  readonly handle: FileSystemFileHandle | null;
}

const PSD_TYPE = { description: "Photoshop document", accept: { "image/vnd.adobe.photoshop": [".psd"] } };
const OPEN_PICKER_TYPES = [{ description: "Images", accept: { "image/*": OPEN_TYPES } }];

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export async function pickFiles(): Promise<OpenedFile[]> {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true, types: OPEN_PICKER_TYPES });
      return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    } catch (e) {
      if (isAbort(e)) return [];
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = OPEN_TYPES.join(",");
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])].map((file) => ({ file, handle: null })));
    input.click();
  });
}

/** Asks where to save a PSD. Null if the user cancels, or if the browser can't save in place. */
export async function pickSaveTarget(suggestedName: string): Promise<FileSystemFileHandle | null | "unsupported"> {
  if (!window.showSaveFilePicker) return "unsupported";
  try {
    return await window.showSaveFilePicker({ suggestedName, types: [PSD_TYPE] });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

export async function writeFile(handle: FileSystemFileHandle, blob: Blob) {
  const stream = await handle.createWritable();
  await stream.write(blob);
  await stream.close();
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
export const isPsdName = (name: string) => /\.psd$/i.test(name);
