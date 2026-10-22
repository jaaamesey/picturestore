import { describe, expect, it } from "vitest";
import { addLayer, createDocument } from "../../core/document";
import { vec } from "../../core/geometry";
import { cornerKnot, type VectorPath } from "../../core/path";
import { NO_PATH_STATE } from "../types";
import { shapeTarget } from "./type";

const line: VectorPath = { subpaths: [{ closed: false, op: "combine", knots: [cornerKnot(vec(20, 50)), cornerKnot(vec(180, 50))] }] };
const square: VectorPath = {
  subpaths: [{ closed: true, op: "combine", knots: [cornerKnot(vec(20, 20)), cornerKnot(vec(120, 20)), cornerKnot(vec(120, 120)), cornerKnot(vec(20, 120))] }],
};
const doc = (workPath: VectorPath | null) => ({ ...addLayer(createDocument({ width: 200, height: 200 })), workPath });
const work = { target: { kind: "work" as const }, selected: [] };

describe("type on any path", () => {
  it("runs along the selected work path, open or closed, from where it's clicked", () => {
    const t = shapeTarget(doc(line), work, vec(100, 53), 4);
    expect(t).toMatchObject({ kind: "path", closed: false });
    expect(t!.kind === "path" && t!.start).toBeCloseTo(80);
    expect(shapeTarget(doc(square), work, vec(70, 22), 4)).toMatchObject({ kind: "path", closed: true });
  });

  it("fills a closed path clicked inside, but not an open one", () => {
    expect(shapeTarget(doc(square), work, vec(70, 70), 4)).toMatchObject({ kind: "area" });
    expect(shapeTarget(doc(line), work, vec(100, 90), 4)).toBeNull();
  });

  it("needs the path to be the one in use", () => {
    expect(shapeTarget(doc(line), NO_PATH_STATE, vec(100, 50), 4)).toBeNull();
    const saved = { ...doc(null), paths: [{ id: "a", name: "Path 1", path: line }] };
    expect(shapeTarget(saved, { target: { kind: "saved", id: "a" }, selected: [] }, vec(100, 50), 4)).toMatchObject({ kind: "path" });
    expect(shapeTarget(doc(line), work, vec(100, 90), 4)).toBeNull();
  });
});
