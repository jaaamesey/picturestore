import type { Doc } from "./document";

export interface HistoryEntry {
  readonly label: string;
  readonly doc: Doc;
}

/**
 * Undo history as a list of document snapshots. Snapshots share unchanged
 * layers and tiles, so each entry costs roughly the size of what it changed.
 */
export interface History {
  readonly entries: readonly HistoryEntry[];
  readonly index: number;
}

export const DEFAULT_HISTORY_LIMIT = 50;

export const createHistory = (doc: Doc, label = "Open"): History => ({ entries: [{ label, doc }], index: 0 });

export const currentDoc = (h: History): Doc => h.entries[h.index].doc;

/** Records a new state, discarding any redo branch and trimming to `limit`. */
export function push(h: History, label: string, doc: Doc, limit = DEFAULT_HISTORY_LIMIT): History {
  const entries = [...h.entries.slice(0, h.index + 1), { label, doc }];
  const drop = Math.max(0, entries.length - limit);
  return { entries: entries.slice(drop), index: entries.length - 1 - drop };
}

export const canUndo = (h: History) => h.index > 0;
export const canRedo = (h: History) => h.index < h.entries.length - 1;
export const undo = (h: History): History => (canUndo(h) ? { ...h, index: h.index - 1 } : h);
export const redo = (h: History): History => (canRedo(h) ? { ...h, index: h.index + 1 } : h);
export const jump = (h: History, index: number): History =>
  index >= 0 && index < h.entries.length ? { ...h, index } : h;

/** Replaces the current entry (used to coalesce continuous edits such as dragging a slider). */
export function amend(h: History, label: string, doc: Doc): History {
  const entries = [...h.entries.slice(0, h.index), { label, doc }];
  return { entries, index: h.index };
}
