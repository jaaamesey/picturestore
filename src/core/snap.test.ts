import { describe, expect, it } from "vitest";
import { addLayer, createDocument, createLayer, fillTiles, type Doc } from "./document";
import { rect, vec } from "./geometry";
import { snapPoint, snapRect, snapTargets, transformGuides, type SnapTo } from "./snap";
import { EMPTY_TILES } from "./tiles";

const ALL: SnapTo = { guides: true, grid: null, layers: true, bounds: true };

/** 400×300 with a layer covering (100, 50)–(150, 90) and a vertical guide at x = 333. */
function doc(): Doc {
  const d = addLayer(createDocument({ width: 400, height: 300, background: null }), createLayer({ name: "box", tiles: fillTiles(EMPTY_TILES, rect(100, 50, 50, 40), { r: 1, g: 2, b: 3 }) }));
  return { ...d, guides: [{ orientation: "vertical", position: 333 }] };
}

describe("snapping", () => {
  it("pulls a point onto the nearest guide, layer edge or centre, or canvas edge, per axis, within the tolerance", () => {
    const t = snapTargets(doc(), ALL);
    expect(snapPoint(vec(330, 52), t, 8)).toMatchObject({ dx: 3, dy: -2 });
    expect(snapPoint(vec(127, 296), t, 8)).toMatchObject({ dx: -2, dy: 4 });
    expect(snapPoint(vec(250, 200), t, 8)).toMatchObject({ dx: 0, dy: 0 });
  });

  it("snaps a moving box by whichever of its edges or centre is nearest", () => {
    const t = snapTargets(doc(), ALL);
    // Its centre (x = 203) is 3 px from the canvas centre; its left edge (183) is nowhere near anything.
    expect(snapRect(rect(183, 10, 40, 10), t, 8)).toMatchObject({ dx: -3 });
  });

  it("prefers a guide, the grid or the canvas to a layer at the same distance", () => {
    const d = { ...doc(), guides: [{ orientation: "vertical" as const, position: 154 }] };
    const s = snapPoint(vec(152, 0), snapTargets(d, ALL), 8);
    expect(s.dx).toBe(2);
  });

  it("snaps to the grid's subdivisions", () => {
    const t = snapTargets(doc(), { guides: false, layers: false, bounds: false, grid: { x: 25, y: 25 } });
    expect(snapPoint(vec(73, 128), t, 8)).toMatchObject({ dx: 2, dy: -3 });
  });

  it("leaves out what's moving, hidden layers and disabled targets", () => {
    const d = doc();
    const id = d.layers[1].id;
    expect(snapPoint(vec(103, 200), snapTargets(d, ALL, [id]), 8).dx).toBe(0);
    expect(snapPoint(vec(331, 200), snapTargets(d, { ...ALL, guides: false }), 8).dx).toBe(0);
  });

  it("draws smart guides from what moved to what it aligned with", () => {
    const s = snapRect(rect(98, 200, 20, 20), snapTargets(doc(), ALL), 8);
    expect(s.dx).toBe(2);
    expect(s.guides).toContainEqual({ axis: "x", at: 100, from: 50, to: 220 });
  });
});

describe("guides through document transforms", () => {
  const guides = [{ orientation: "vertical", position: 10 }, { orientation: "horizontal", position: 20 }] as const;
  it("follow scales and translations, and swap at quarter turns", () => {
    expect(transformGuides(guides, [2, 0, 5, 0, 3, -1, 0, 0, 1])).toEqual([{ orientation: "vertical", position: 25 }, { orientation: "horizontal", position: 59 }]);
    // A quarter turn clockwise on a 100-tall canvas: (x, y) → (100 − y, x).
    expect(transformGuides(guides, [0, -1, 100, 1, 0, 0, 0, 0, 1])).toEqual([{ orientation: "horizontal", position: 10 }, { orientation: "vertical", position: 80 }]);
  });
  it("are dropped by other rotations", () => {
    const c = Math.cos(0.3), s = Math.sin(0.3);
    expect(transformGuides(guides, [c, -s, 0, s, c, 0, 0, 0, 1])).toBeUndefined();
  });
});
