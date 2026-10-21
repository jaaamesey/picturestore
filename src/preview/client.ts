import type { Doc } from "../core/document";
import type { ImageSizeOptions } from "../core/documentTransform";
import type { Rect } from "../core/geometry";
import type { Tile } from "../core/tiles";
import { toWire, type Request, type Response } from "./wire";

/** Tiles per message when syncing (256 KB each): keeps each structured clone short on the main thread. */
const TILES_PER_MESSAGE = 32;

/**
 * Renders Image Size previews in a worker. Tiles are copied there once and
 * referenced by id afterwards, so a preview usually sends nothing but the
 * document's structure. `dispose` frees the worker and its copies.
 */
export function createPreviewWorker() {
  let worker: Worker | null = null;
  const ids = new WeakMap<Tile, number>();
  const sent = new Set<number>();
  let nextTile = 0;
  let nextRequest = 0;
  const pending = new Map<number, { resolve: (r: ImageData) => void; reject: (e: Error) => void }>();

  const start = () => {
    const w = new Worker(new URL("./preview.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data }: MessageEvent<Response>) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (!p) return;
      if (data.ok) p.resolve(new ImageData(data.pixels as Uint8ClampedArray<ArrayBuffer>, data.width, data.height));
      else p.reject(new Error(data.error));
    };
    // A worker that dies (out of memory, say) takes its tiles with it: start over next time.
    w.onerror = (e) => {
      e.preventDefault();
      for (const p of pending.values()) p.reject(new Error("The preview worker stopped unexpectedly."));
      pending.clear();
      sent.clear();
      w.terminate();
      worker = null;
    };
    return w;
  };

  const post = (req: Request) => (worker ??= start()).postMessage(req);

  return {
    async render(doc: Doc, options: ImageSizeOptions & { resample: boolean }, window: Rect, scale: number): Promise<ImageData> {
      const missing: Tile[] = [];
      const wire = toWire(doc, (t) => {
        let id = ids.get(t);
        if (id === undefined) ids.set(t, (id = nextTile++));
        if (!sent.has(id)) {
          sent.add(id);
          missing.push(t);
        }
        return id;
      });
      // Send new tiles in slices, yielding between them so the UI stays responsive.
      for (let i = 0; i < missing.length; i += TILES_PER_MESSAGE) {
        const batch = missing.slice(i, i + TILES_PER_MESSAGE);
        post({ op: "tiles", ids: batch.map((t) => ids.get(t)!), data: batch.map((t) => t.data) });
        if (i + TILES_PER_MESSAGE < missing.length) await new Promise((r) => setTimeout(r, 0));
      }
      const id = nextRequest++;
      return new Promise<ImageData>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post({ op: "render", id, doc: wire, options, window, scale });
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      sent.clear();
      for (const p of pending.values()) p.reject(new Error("Preview cancelled"));
      pending.clear();
    },
  };
}
