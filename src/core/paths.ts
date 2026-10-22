import { newId, type Doc, type SavedPath } from "./document";
import { EMPTY_PATH, type VectorPath } from "./path";
import { maskToPath, pathToMask, type PathMaskOptions } from "./pathMask";
import { combine, type SelectionMode } from "./selection";

/**
 * The Paths panel's operations on a document: the work path and the saved
 * paths (see {@link SavedPath}), and paths to and from selections.
 */

export const savedPaths = (d: Doc): readonly SavedPath[] => d.paths ?? [];

/** "Path 1", "Path 2", …: the first number not taken. */
export function pathName(d: Doc): string {
  const names = new Set(savedPaths(d).map((p) => p.name));
  for (let n = 1; ; n++) if (!names.has(`Path ${n}`)) return `Path ${n}`;
}

/** New Path: an empty saved path, first in the panel. */
export function addPath(d: Doc, name = pathName(d), path: VectorPath = EMPTY_PATH): { doc: Doc; id: string } {
  const id = newId();
  return { doc: { ...d, paths: [{ id, name, path }, ...savedPaths(d)] }, id };
}

/** Save Path: the work path becomes a saved path (and there is no work path any more). */
export function saveWorkPath(d: Doc, name = pathName(d)): { doc: Doc; id: string } | null {
  if (!d.workPath) return null;
  const made = addPath(d, name, d.workPath);
  return { doc: { ...made.doc, workPath: null }, id: made.id };
}

export const renamePath = (d: Doc, id: string, name: string): Doc => ({ ...d, paths: savedPaths(d).map((p) => (p.id === id ? { ...p, name } : p)) });

export const deleteSavedPath = (d: Doc, id: string): Doc => ({ ...d, paths: savedPaths(d).filter((p) => p.id !== id) });

/** Duplicate Path: a copy just above the original, named "… copy". */
export function duplicateSavedPath(d: Doc, id: string): { doc: Doc; id: string } | null {
  const list = savedPaths(d);
  const at = list.findIndex((p) => p.id === id);
  if (at < 0) return null;
  const copy: SavedPath = { ...list[at], id: newId(), name: `${list[at].name} copy` };
  return { doc: { ...d, paths: [...list.slice(0, at), copy, ...list.slice(at)] }, id: copy.id };
}

/** Moves a saved path to position `to` in the panel's order. */
export function reorderSavedPath(d: Doc, id: string, to: number): Doc {
  const list = [...savedPaths(d)];
  const from = list.findIndex((p) => p.id === id);
  if (from < 0) return d;
  const [moved] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, moved);
  return { ...d, paths: list };
}

export interface MakeSelectionOptions extends PathMaskOptions {
  /** How the new selection joins an existing one. */
  readonly operation: SelectionMode;
}

/** Make Selection: the path's area becomes the selection, or joins it. */
export function selectionFromPath(d: Doc, path: VectorPath, o: MakeSelectionOptions): Doc {
  const mask = pathToMask(path, d.width, d.height, o);
  return { ...d, selection: combine(d.selection, mask, o.operation) };
}

/** Make Work Path: the selection's outlines become the work path (replacing the old one). Null with no selection. */
export function workPathFromSelection(d: Doc, tolerance: number): Doc | null {
  if (!d.selection) return null;
  const path = maskToPath(d.selection, tolerance);
  return path.subpaths.length ? { ...d, workPath: path } : null;
}
