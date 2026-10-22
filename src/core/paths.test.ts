import { describe, expect, it } from "vitest";
import { addLayer, createDocument } from "./document";
import { cornerKnot } from "./path";
import { vec } from "./geometry";
import { addPath, deleteSavedPath, duplicateSavedPath, pathName, renamePath, reorderSavedPath, saveWorkPath, selectionFromPath, workPathFromSelection } from "./paths";
import { rectMask } from "./selection";

const square = { subpaths: [{ closed: true, op: "combine" as const, knots: [cornerKnot(vec(10, 10)), cornerKnot(vec(50, 10)), cornerKnot(vec(50, 50)), cornerKnot(vec(10, 50))] }] };
const doc = () => addLayer(createDocument({ width: 100, height: 100 }));

describe("document paths", () => {
  it("names paths Path 1, Path 2, …, reusing a freed number", () => {
    let d = doc();
    expect(pathName(d)).toBe("Path 1");
    d = addPath(d).doc;
    d = addPath(d).doc;
    expect(d.paths!.map((p) => p.name)).toEqual(["Path 2", "Path 1"]);
    expect(pathName(d)).toBe("Path 3");
    d = deleteSavedPath(d, d.paths![1].id);
    expect(pathName(d)).toBe("Path 1");
  });

  it("saving the work path makes a saved path and clears it", () => {
    const d = { ...doc(), workPath: square };
    const saved = saveWorkPath(d)!;
    expect(saved.doc.workPath).toBeNull();
    expect(saved.doc.paths![0]).toMatchObject({ id: saved.id, name: "Path 1", path: square });
    expect(saveWorkPath(saved.doc)).toBeNull();
  });

  it("renames, duplicates just above, and reorders", () => {
    let d = addPath(addPath(doc()).doc).doc;
    const [c, b, a] = [d.paths![0].id, d.paths![1].id, addPath(d).id];
    void a;
    d = renamePath(d, b, "Outline");
    expect(d.paths!.map((p) => p.name)).toEqual(["Path 2", "Outline"]);
    const dup = duplicateSavedPath(d, b)!;
    expect(dup.doc.paths!.map((p) => p.name)).toEqual(["Path 2", "Outline copy", "Outline"]);
    const moved = reorderSavedPath(dup.doc, c, 2);
    expect(moved.paths!.map((p) => p.name)).toEqual(["Outline copy", "Outline", "Path 2"]);
  });

  it("Make Selection applies its operation to the current selection", () => {
    const d = { ...doc(), selection: rectMask(100, 100, { x: 40, y: 40, w: 40, h: 40 }) };
    const o = { antiAlias: true, feather: 0 };
    expect(selectionFromPath(d, square, { ...o, operation: "replace" }).selection!.bounds).toEqual({ x: 10, y: 10, w: 40, h: 40 });
    expect(selectionFromPath(d, square, { ...o, operation: "add" }).selection!.bounds).toEqual({ x: 10, y: 10, w: 70, h: 70 });
    expect(selectionFromPath(d, square, { ...o, operation: "intersect" }).selection!.bounds).toEqual({ x: 40, y: 40, w: 10, h: 10 });
    expect(selectionFromPath(d, square, { ...o, operation: "subtract" }).selection!.bounds).toEqual({ x: 40, y: 40, w: 40, h: 40 });
  });

  it("Make Work Path turns the selection into the work path; nothing selected, nothing", () => {
    expect(workPathFromSelection(doc(), 2)).toBeNull();
    const d = { ...doc(), selection: rectMask(100, 100, { x: 20, y: 20, w: 30, h: 30 }) };
    const w = workPathFromSelection(d, 2)!;
    expect(w.workPath!.subpaths).toHaveLength(1);
    expect(w.workPath!.subpaths[0].closed).toBe(true);
  });
});
