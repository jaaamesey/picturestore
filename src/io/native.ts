import { isBlendMode } from "../core/blend";
import type { Doc, Layer } from "../core/document";
import { toMask } from "../core/selection";
import { TILE_SIZE, parseTileKey, tileKey, type Tile } from "../core/tiles";

/**
 * The native `.pstore` format: a small JSON manifest followed by a binary
 * section of deflate-compressed chunks — the same shape as glTF's `.glb`.
 *
 *   "PSTR"  u32 version  u32 manifestLength  manifest (UTF-8 JSON)  chunks…
 *
 * Layers are stored as their sparse tiles, so empty regions cost nothing and
 * the file maps 1:1 onto the in-memory model. The manifest is plain JSON and
 * easy to extend; readers ignore fields they don't know.
 */
export const NATIVE_EXTENSION = "pstore";
export const NATIVE_VERSION = 1;
const MAGIC = "PSTR";

interface ChunkRef {
  readonly offset: number;
  readonly length: number;
}

interface Manifest {
  readonly format: "picturestore";
  readonly version: number;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly activeLayerId: string;
  /** Bottom to top. */
  readonly layers: readonly {
    readonly id: string;
    readonly name: string;
    readonly visible: boolean;
    readonly opacity: number;
    readonly blendMode: string;
    readonly tiles: readonly { readonly x: number; readonly y: number; readonly chunk: ChunkRef }[];
  }[];
  /** Document-sized 8-bit mask. */
  readonly selection: ChunkRef | null;
}

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const deflate = (d: Uint8Array) => transform(d, new CompressionStream("deflate-raw"));
const inflate = (d: Uint8Array) => transform(d, new DecompressionStream("deflate-raw"));

export async function encodeNative(doc: Doc): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const add = async (raw: Uint8Array): Promise<ChunkRef> => {
    const c = await deflate(raw);
    chunks.push(c);
    const ref = { offset, length: c.length };
    offset += c.length;
    return ref;
  };

  const layers: Manifest["layers"][number][] = [];
  for (const l of doc.layers) {
    const tiles = [];
    for (const [key, t] of l.tiles) {
      const [x, y] = parseTileKey(key);
      tiles.push({ x, y, chunk: await add(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)) });
    }
    layers.push({ id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode, tiles });
  }
  const manifest: Manifest = {
    format: "picturestore",
    version: NATIVE_VERSION,
    width: doc.width,
    height: doc.height,
    tileSize: TILE_SIZE,
    activeLayerId: doc.activeLayerId,
    layers,
    selection: doc.selection ? await add(doc.selection.data) : null,
  };

  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const out = new Uint8Array(12 + json.length + offset);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint32(4, NATIVE_VERSION, true);
  view.setUint32(8, json.length, true);
  out.set(json, 12);
  let at = 12 + json.length;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export const isNative = (bytes: Uint8Array) =>
  bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === MAGIC;

export async function decodeNative(bytes: Uint8Array): Promise<Doc> {
  if (!isNative(bytes)) throw new Error("Not a Picturestore file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version > NATIVE_VERSION) throw new Error(`File version ${version} is newer than this app supports`);
  const jsonLength = view.getUint32(8, true);
  const m = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLength))) as Manifest;
  if (m.format !== "picturestore" || m.tileSize !== TILE_SIZE) throw new Error("Unsupported Picturestore file");
  const body = 12 + jsonLength;
  const chunk = (c: ChunkRef) => inflate(bytes.subarray(body + c.offset, body + c.offset + c.length));

  const layers: Layer[] = [];
  for (const l of m.layers) {
    const tiles = new Map<string, Tile>();
    for (const t of l.tiles) {
      const data = await chunk(t.chunk);
      if (data.length !== TILE_SIZE * TILE_SIZE * 4) throw new Error("Corrupt tile data");
      tiles.set(tileKey(t.x, t.y), { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), version: 0 });
    }
    layers.push({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: isBlendMode(l.blendMode) ? l.blendMode : "normal",
      tiles,
    });
  }
  if (layers.length === 0) throw new Error("Document has no layers");
  const sel = m.selection ? await chunk(m.selection) : null;
  return {
    width: m.width,
    height: m.height,
    layers,
    activeLayerId: layers.some((l) => l.id === m.activeLayerId) ? m.activeLayerId : layers[layers.length - 1].id,
    selection: sel ? toMask(sel, m.width, m.height) : null,
  };
}
