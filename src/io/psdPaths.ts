import type { Knot } from "../core/bezier";
import type { SavedPath } from "../core/document";
import type { Vec2 } from "../core/geometry";
import { isSmooth, type PathOp, type Subpath, type VectorPath } from "../core/path";

/**
 * The Paths panel's paths in a PSD: image resources 2000–2997 hold the
 * saved paths (the resource's name is the path's name) and 1025 the work
 * path, as series of 26-byte path records (the vector mask's format, see
 * Adobe's file format specification) with coordinates as 8.24 fixed point
 * fractions of the image size. ag-psd has no support for them, so they are
 * added to and read from the resources section directly.
 */

const SAVED_FIRST = 2000, SAVED_LAST = 2997, WORK = 1025;
const OPS: readonly PathOp[] = ["exclude", "combine", "subtract", "intersect"];
const FIXED = 2 ** 24;

interface Block {
  readonly id: number;
  readonly name: string;
  readonly data: Uint8Array;
}

/** A path's records. */
function encodePath(path: VectorPath, width: number, height: number): Uint8Array {
  const records = 3 + path.subpaths.reduce((n, s) => n + 1 + s.knots.length, 0);
  const out = new Uint8Array(records * 26);
  const view = new DataView(out.buffer);
  let at = 0;
  const record = (selector: number) => {
    view.setUint16(at, selector);
    at += 2;
  };
  const fixed = (v: number) => {
    view.setInt32(at, Math.round(v * FIXED));
    at += 4;
  };
  const point = (p: Vec2) => (fixed(p.y / height), fixed(p.x / width));
  record(6); // fill rule
  at += 24;
  record(8); // initial fill rule: starts with no pixels
  at += 24;
  for (const s of path.subpaths) {
    record(s.closed ? 0 : 3);
    view.setUint16(at, s.knots.length);
    view.setInt16(at + 2, OPS.indexOf(s.op));
    view.setUint16(at + 4, 1); // even-odd, as Photoshop writes for plain paths
    at += 24;
    for (const k of s.knots) {
      record(isSmooth(k) ? (s.closed ? 1 : 4) : s.closed ? 2 : 5);
      point(k.in);
      point(k.anchor);
      point(k.out);
    }
  }
  return out.subarray(0, at);
}

/** Path records back into a path. */
function decodePath(data: Uint8Array, width: number, height: number): VectorPath {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const subpaths: { knots: Knot[]; closed: boolean; op: PathOp }[] = [];
  const point = (at: number): Vec2 => ({ x: (view.getInt32(at + 4) / FIXED) * width, y: (view.getInt32(at) / FIXED) * height });
  for (let at = 0; at + 26 <= data.length; at += 26) {
    const selector = view.getUint16(at);
    if (selector === 0 || selector === 3) {
      const op = view.getInt16(at + 4);
      subpaths.push({ knots: [], closed: selector === 0, op: OPS[op] ?? "combine" });
    } else if (selector >= 1 && selector <= 5 && selector !== 3 && subpaths.length) {
      const linked = selector === 1 || selector === 4;
      subpaths[subpaths.length - 1].knots.push({ in: point(at + 2), anchor: point(at + 10), out: point(at + 18), smooth: linked });
    }
  }
  return { subpaths: subpaths.filter((s) => s.knots.length) as Subpath[] };
}

const utf8 = new TextEncoder();

function blockBytes(b: Block): Uint8Array {
  const name = utf8.encode(b.name).subarray(0, 255);
  const nameLen = 1 + name.length + ((1 + name.length) % 2);
  const dataLen = b.data.length + (b.data.length % 2);
  const out = new Uint8Array(4 + 2 + nameLen + 4 + dataLen);
  const view = new DataView(out.buffer);
  out.set(utf8.encode("8BIM"), 0);
  view.setUint16(4, b.id);
  out[6] = name.length;
  out.set(name, 7);
  view.setUint32(6 + nameLen, b.data.length);
  out.set(b.data, 10 + nameLen);
  return out;
}

/** The PSD with the work path and saved paths added to its image resources. */
export function writePathResources(psd: ArrayBuffer, width: number, height: number, saved: readonly SavedPath[], work: VectorPath | null | undefined): ArrayBuffer {
  const blocks: Block[] = saved.slice(0, SAVED_LAST - SAVED_FIRST + 1).map((p, i) => ({ id: SAVED_FIRST + i, name: p.name, data: encodePath(p.path, width, height) }));
  if (work?.subpaths.length) blocks.push({ id: WORK, name: "", data: encodePath(work, width, height) });
  if (!blocks.length) return psd;
  const extra = blocks.map(blockBytes);
  const added = extra.reduce((n, b) => n + b.length, 0);
  const bytes = new Uint8Array(psd);
  const view = new DataView(psd);
  // Header (26 bytes), colour mode data (length + data), then the image resources (length + blocks).
  const resourcesAt = 26 + 4 + view.getUint32(26);
  const length = view.getUint32(resourcesAt);
  const end = resourcesAt + 4 + length;
  const out = new Uint8Array(bytes.length + added);
  out.set(bytes.subarray(0, end), 0);
  let at = end;
  for (const b of extra) (out.set(b, at), (at += b.length));
  out.set(bytes.subarray(end), at);
  new DataView(out.buffer).setUint32(resourcesAt, length + added);
  return out.buffer;
}

/** The work path and saved paths in a PSD's image resources. */
export function readPathResources(psd: ArrayBuffer | Uint8Array): { work: VectorPath | null; saved: SavedPath[] } {
  const bytes = psd instanceof Uint8Array ? psd : new Uint8Array(psd);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: { work: VectorPath | null; saved: SavedPath[] } = { work: null, saved: [] };
  if (bytes.length < 34) return result;
  const width = view.getUint32(18), height = view.getUint32(14);
  let at = 26 + 4 + view.getUint32(26);
  const end = at + 4 + view.getUint32(at);
  at += 4;
  const found: { id: number; name: string; path: VectorPath }[] = [];
  while (at + 12 <= end) {
    if (String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]) !== "8BIM") break;
    const id = view.getUint16(at + 4);
    const nameLen = bytes[at + 6];
    const nameField = 1 + nameLen + ((1 + nameLen) % 2);
    const size = view.getUint32(at + 6 + nameField);
    const start = at + 10 + nameField;
    if (id === WORK || (id >= SAVED_FIRST && id <= SAVED_LAST)) {
      const name = new TextDecoder().decode(bytes.subarray(at + 7, at + 7 + nameLen));
      found.push({ id, name, path: decodePath(bytes.subarray(start, start + size), width, height) });
    }
    at = start + size + (size % 2);
  }
  let n = 0;
  for (const f of found.sort((a, b) => a.id - b.id)) {
    if (f.id === WORK) result.work = f.path;
    else result.saved.push({ id: `p${(n++).toString(36)}${Math.random().toString(36).slice(2, 7)}`, name: f.name, path: f.path });
  }
  return result;
}
