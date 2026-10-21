/// <reference lib="webworker" />
import { CPU_RASTERIZERS } from "../core/content";
import { imageSizePreview } from "../core/documentTransform";
import type { Tile } from "../core/tiles";
import { fromWire, type Request, type Response } from "./wire";

/**
 * Renders previews off the main thread with the same core code as the
 * editor (here the CPU implementations). Holds copies of the tiles it has
 * been sent, by id, until cleared.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const tiles = new Map<number, Tile>();

scope.onmessage = async ({ data: req }: MessageEvent<Request>) => {
  if (req.op === "tiles") {
    req.ids.forEach((id, i) => tiles.set(id, { data: req.data[i], version: 0 }));
    return;
  }
  if (req.op === "clear") {
    tiles.clear();
    return;
  }
  try {
    const doc = fromWire(req.doc, (id) => {
      const t = tiles.get(id);
      if (!t) throw new Error(`Preview worker is missing tile ${id}`);
      return t;
    });
    const { width, height, pixels } = await imageSizePreview(doc, req.options, req.window, req.scale, CPU_RASTERIZERS);
    scope.postMessage({ id: req.id, ok: true, width, height, pixels } satisfies Response, [pixels.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response);
  }
};
