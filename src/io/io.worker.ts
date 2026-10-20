/// <reference lib="webworker" />
import type { Doc } from "../core/document";
import { decode, encode, transferables } from "./codec";
import type { SaveFormat } from "./formats";

export type Request =
  | { readonly id: number; readonly op: "decode"; readonly file: Blob }
  | { readonly id: number; readonly op: "encode"; readonly doc: Doc; readonly format: SaveFormat };

export type Response =
  | { readonly id: number; readonly ok: true; readonly result: Doc | Blob }
  | { readonly id: number; readonly ok: false; readonly error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async ({ data: req }: MessageEvent<Request>) => {
  try {
    if (req.op === "decode") {
      const doc = await decode(req.file);
      scope.postMessage({ id: req.id, ok: true, result: doc } satisfies Response, transferables(doc));
    } else {
      scope.postMessage({ id: req.id, ok: true, result: await encode(req.doc, req.format) } satisfies Response);
    }
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response);
  }
};
