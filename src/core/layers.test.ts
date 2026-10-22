import { describe, expect, it } from "vitest";
import { addLayer, createDocument, createGroup, createLayer, duplicateLayer, groupLayers, moveLayerRelative, removeLayer, ungroup, type Doc, type Layer } from "./document";
import { allLayers, ancestors, clipBaseIndex, findLayer, isClipped, isShown, locate } from "./layers";

const named = (name: string, props: Partial<Layer> = {}) => createLayer({ name, ...props });
const doc = (...layers: Layer[]): Doc => ({ width: 1, height: 1, layers, activeLayerId: layers[layers.length - 1].id, selection: null });
const names = (layers: readonly Layer[]): string =>
  layers.map((l) => (l.content.kind === "group" ? `${l.name}(${names(l.content.layers)})` : l.clipped ? `${l.name}*` : l.name)).join(" ");
const id = (d: Doc, name: string) => allLayers(d.layers).find((l) => l.name === name)!.id;

describe("layer tree", () => {
  const nested = () => doc(named("A"), createGroup("G", [named("B"), createGroup("H", [named("C")])]), named("D"));

  it("finds layers and where they are", () => {
    const d = nested();
    expect(findLayer(d.layers, id(d, "C"))!.name).toBe("C");
    expect(ancestors(d.layers, id(d, "C")).map((g) => g.name)).toEqual(["G", "H"]);
    expect(locate(d.layers, id(d, "B"))).toMatchObject({ index: 0, parent: { name: "G" } });
  });

  it("adds new layers above the active one, or at the top of the active group", () => {
    let d = nested();
    d = addLayer({ ...d, activeLayerId: id(d, "B") }, named("N"));
    expect(names(d.layers)).toBe("A G(B N H(C)) D");
    d = addLayer({ ...d, activeLayerId: id(d, "H") }, named("M"));
    expect(names(d.layers)).toBe("A G(B N H(C M)) D");
  });

  it("moves layers into, out of and within groups", () => {
    const d = nested();
    expect(names(moveLayerRelative(d, id(d, "D"), id(d, "H"), "inside").layers)).toBe("A G(B H(C D))");
    expect(names(moveLayerRelative(d, id(d, "C"), id(d, "A"), "below").layers)).toBe("C A G(B H()) D");
    // Dropped on a group's folder, a layer goes in at the bottom.
    expect(names(moveLayerRelative(d, id(d, "D"), id(d, "G"), "inside-bottom").layers)).toBe("A G(D B H(C))");
    // Not into itself.
    expect(moveLayerRelative(d, id(d, "G"), id(d, "C"), "above")).toBe(d);
    // Already there: unchanged, so no history step.
    expect(moveLayerRelative(d, id(d, "A"), id(d, "G"), "below")).toBe(d);
    expect(moveLayerRelative(d, id(d, "B"), id(d, "G"), "inside-bottom")).toBe(d);
  });

  it("groups and ungroups", () => {
    let d = doc(named("A"), named("B"), named("C"));
    d = groupLayers(d, [id(d, "C"), id(d, "A")]);
    expect(names(d.layers)).toBe("B Group 1(A C)");
    expect(findLayer(d.layers, d.activeLayerId)!.name).toBe("Group 1");
    expect(findLayer(d.layers, d.activeLayerId)!.blendMode).toBe("pass through");
    d = ungroup(d, id(d, "Group 1"));
    expect(names(d.layers)).toBe("B A C");
    expect(findLayer(d.layers, d.activeLayerId)!.name).toBe("C");
  });

  it("deletes a group with its contents, keeping a layer", () => {
    const d = nested();
    expect(names(removeLayer(d, id(d, "G")).layers)).toBe("A D");
    const only = doc(createGroup("G", [named("X")]));
    expect(removeLayer(only, only.layers[0].id)).toBe(only);
  });

  it("duplicates groups deeply with new ids", () => {
    const d = nested();
    const dup = duplicateLayer(d, id(d, "G"));
    expect(names(dup.layers)).toBe("A G(B H(C)) G copy(B H(C)) D");
    expect(new Set(allLayers(dup.layers).map((l) => l.id)).size).toBe(allLayers(dup.layers).length);
  });
});

describe("clipping", () => {
  it("clipped layers clip to the nearest unclipped layer below", () => {
    const s = [named("A", { clipped: true }), named("B"), named("C", { clipped: true }), named("D", { clipped: true })];
    expect(isClipped(s, 0)).toBe(false);
    expect(clipBaseIndex(s, 3)).toBe(1);
  });

  it("a layer added or moved into a clipping group joins it; one moved out leaves", () => {
    let d = doc(named("Bg"), named("Base"), named("C", { clipped: true }));
    d = addLayer({ ...d, activeLayerId: id(d, "Base") }, named("N"));
    expect(names(d.layers)).toBe("Bg Base N* C*");
    d = moveLayerRelative(d, id(d, "N"), id(d, "Bg"), "below");
    expect(names(d.layers)).toBe("N Bg Base C*");
    d = moveLayerRelative(d, id(d, "C"), id(d, "N"), "above");
    expect(names(d.layers)).toBe("N C Bg Base");
  });

  it("a clipped layer is shown only when its base and groups are", () => {
    const d = doc(named("Base", { visible: false }), named("C", { clipped: true }));
    expect(isShown(d.layers, id(d, "C"))).toBe(false);
    const g = doc({ ...createGroup("G", [named("X")]), visible: false });
    expect(isShown(g.layers, id(g, "X"))).toBe(false);
  });
});

it("new documents have one layer", () => {
  expect(createDocument({ width: 1, height: 1 }).layers).toHaveLength(1);
});
