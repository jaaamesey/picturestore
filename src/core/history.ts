import type { Doc, Layer } from "./document";
import { walk } from "./layers";
import type { Pixels } from "./pixels";

export interface HistoryEntry {
  readonly label: string;
  readonly doc: Doc;
  /** Bytes this state retains that the previous one didn't (new tiles, masks, sources). */
  readonly bytes: number;
}

/**
 * Undo history as a list of document snapshots. Snapshots share unchanged
 * layers and tiles (copy-on-write), so undo/redo are O(1) and each entry costs
 * roughly what it changed. History is bounded by both a step count and a
 * memory budget, trimming the oldest states first, so long sessions on large
 * documents can't exhaust memory.
 */
export interface History {
  readonly entries: readonly HistoryEntry[];
  readonly index: number;
}

export interface HistoryLimits {
  /** Photoshop's default is 50 history states. */
  readonly steps: number;
  readonly bytes: number;
}

/** The editor sets both from Preferences ▸ Performance (History States, Memory Usage). */
export const DEFAULT_LIMITS: HistoryLimits = { steps: 50, bytes: Infinity };

const TILE_BYTES = 256 * 256 * 4;

function newTileBytes(pixels: Pixels, prev: Pixels | undefined): number {
  if (pixels === prev) return 0;
  let n = 0;
  for (const [key, t] of pixels) if (prev?.get(key) !== t) n++;
  return n * TILE_BYTES;
}

function contentBytes(l: Layer, prev: Layer | undefined): number {
  if (l.content.kind !== "smart") return 0;
  const p = prev?.content.kind === "smart" ? prev.content.source : undefined;
  if (p === l.content.source) return 0;
  return newTileBytes(l.content.source.pixels, p?.pixels) + (l.content.source.file?.bytes.length ?? 0);
}

/** Memory `doc` holds that `prev` doesn't, by object identity (O(layers + changed tiles)). */
export function retainedBytes(doc: Doc, prev: Doc | null): number {
  if (doc === prev) return 0;
  const before = new Map(prev ? [...walk(prev.layers)].map((l) => [l.id, l]) : []);
  let bytes = 0;
  for (const l of walk(doc.layers)) {
    const p = before.get(l.id);
    if (p === l) continue;
    bytes += newTileBytes(l.pixels, p?.pixels) + contentBytes(l, p);
    if (l.mask) bytes += newTileBytes(l.mask.pixels, p?.mask?.pixels);
  }
  if (doc.selection && doc.selection !== prev?.selection) bytes += doc.selection.data.length;
  return bytes;
}

export const createHistory = (doc: Doc, label = "Open"): History => ({
  entries: [{ label, doc, bytes: retainedBytes(doc, null) }],
  index: 0,
});

export const currentDoc = (h: History): Doc => h.entries[h.index].doc;

/** The new oldest state owns everything it references. */
const rebase = (entries: HistoryEntry[]): HistoryEntry[] => {
  entries[0] = { ...entries[0], bytes: retainedBytes(entries[0].doc, null) };
  return entries;
};

/** Drops the oldest entries until within limits, always keeping at least one undoable step. */
function trim(entries: HistoryEntry[], index: number, limits: HistoryLimits): History {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  let drop = 0;
  while (entries.length - drop > 2 && drop < index && (entries.length - drop > limits.steps || total > limits.bytes)) {
    total -= entries[drop].bytes;
    drop++;
  }
  if (drop === 0) return { entries, index };
  return { entries: rebase(entries.slice(drop)), index: index - drop };
}

/**
 * Frees one state to relieve memory pressure: the oldest undo state, else
 * the furthest redo state. The current state is never dropped. Null when
 * only the current state is left.
 */
export function dropOne(h: History): History | null {
  if (h.index > 0) return { entries: rebase(h.entries.slice(1)), index: h.index - 1 };
  if (h.entries.length > 1) return { entries: h.entries.slice(0, -1), index: h.index };
  return null;
}

/** Applies a (possibly lowered) step limit, as when History States is changed in Preferences. */
export const limitSteps = (h: History, steps: number): History => trim([...h.entries], h.index, { steps, bytes: Infinity });

/** Records a new state, discarding any redo branch. */
export function push(h: History, label: string, doc: Doc, limits: HistoryLimits = DEFAULT_LIMITS): History {
  const prev = h.entries[h.index].doc;
  const entries = [...h.entries.slice(0, h.index + 1), { label, doc, bytes: retainedBytes(doc, prev) }];
  return trim(entries, entries.length - 1, limits);
}

export const canUndo = (h: History) => h.index > 0;
export const canRedo = (h: History) => h.index < h.entries.length - 1;
export const undo = (h: History): History => (canUndo(h) ? { ...h, index: h.index - 1 } : h);
export const redo = (h: History): History => (canRedo(h) ? { ...h, index: h.index + 1 } : h);
export const jump = (h: History, index: number): History =>
  index >= 0 && index < h.entries.length ? { ...h, index } : h;

/** Replaces the current entry (used to coalesce continuous edits such as dragging a slider). */
export function amend(h: History, label: string, doc: Doc): History {
  const prev = h.index > 0 ? h.entries[h.index - 1].doc : null;
  const entries = [...h.entries.slice(0, h.index), { label, doc, bytes: retainedBytes(doc, prev) }];
  return { entries, index: h.index };
}

/** Rewrites the current state without a new step (e.g. selecting a layer, which Photoshop doesn't record). */
export function replaceCurrent(h: History, doc: Doc): History {
  return { ...h, entries: h.entries.map((e, i) => (i === h.index ? { ...e, doc } : e)) };
}

/** Approximate memory held by the whole history. */
export const historyBytes = (h: History) => h.entries.reduce((s, e) => s + e.bytes, 0);
