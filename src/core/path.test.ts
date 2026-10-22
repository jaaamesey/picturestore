import { describe, expect, it } from "vitest";
import { pathShape, placementMapping } from "./content";
import { rasterizeContours } from "./coverage";
import { readRect } from "./pixels";
import { documentPath, renderShape, type ShapeStyle } from "./shape";
import { rect, vec } from "./geometry";
import {
  addSubpath,
  alignSubpaths,
  allAnchors,
  anchorsIn,
  arrangeSubpaths,
  closeSubpath,
  cornerKnot,
  deleteSegment,
  deleteSegments,
  deleteSelection,
  distributeSubpaths,
  handleAt,
  dragSegment,
  extend,
  insertKnot,
  isSmooth,
  joinEnds,
  mergeComponents,
  moveHandle,
  nearestSegment,
  pointInSubpath,
  pathArea,
  removeKnot,
  selectedSegments,
  selectedSubpaths,
  segmentCount,
  subpathTouchesRect,
  smoothKnot,
  toCorner,
  toSmooth,
  type Subpath,
  type VectorPath,
} from "./path";

const P = (x: number, y: number) => vec(x, y);
const square = (x: number, y: number, s: number, op: Subpath["op"] = "combine"): Subpath => ({
  closed: true,
  op,
  knots: [cornerKnot(P(x, y)), cornerKnot(P(x + s, y)), cornerKnot(P(x + s, y + s)), cornerKnot(P(x, y + s))],
});
/** Pixels covered (≥ half) when the path's area is rasterized. */
const area = (path: VectorPath) => {
  const c = rasterizeContours(pathArea(path), rect(0, 0, 100, 100));
  return c ? c.data.reduce((n, v) => n + (v >= 128 ? 1 : 0), 0) : 0;
};

describe("anchor points", () => {
  it("opposite direction lines on a line make a smooth point; none or bent ones a corner", () => {
    expect(isSmooth({ anchor: P(0, 0), in: P(-5, 0), out: P(5, 0) })).toBe(true);
    expect(isSmooth({ anchor: P(0, 0), in: P(-5, 0), out: P(5, 3) })).toBe(false);
    expect(isSmooth({ anchor: P(0, 0), in: P(0, 0), out: P(0, 0) })).toBe(false);
    expect(isSmooth({ anchor: P(0, 0), in: P(-5, 0), out: P(0, 0) })).toBe(false);
    expect(isSmooth({ anchor: P(0, 0), in: P(-5, 0), out: P(5, 3), smooth: true })).toBe(true);
  });

  it("dragging a direction point of an existing smooth point changes that side's length only; the other turns to follow", () => {
    const k = smoothKnot(P(10, 10), P(20, 10)); // in (0, 10), out (20, 10)
    const m = moveHandle(k, "out", P(10, 30), "smooth");
    expect(m.out).toEqual(P(10, 30));
    // The other side keeps its length (10), now pointing the opposite way.
    expect(m.in.x).toBeCloseTo(10);
    expect(m.in.y).toBeCloseTo(0);
    expect(isSmooth(m)).toBe(true);
    const longer = moveHandle(k, "out", P(40, 10), "smooth");
    expect(longer.in).toEqual(P(0, 10));
  });

  it("drawing mirrors the other direction line; Alt breaks them apart and leaves a corner point", () => {
    const k = smoothKnot(P(0, 0), P(4, 4));
    expect(moveHandle(k, "out", P(6, 0), "mirror").in).toEqual(P(-6, 0));
    const broken = moveHandle(k, "out", P(0, 9), "break");
    expect(broken.in).toEqual(P(-4, -4));
    expect(isSmooth(broken)).toBe(false);
    // A corner point's direction lines are independent.
    expect(moveHandle({ ...k, smooth: false }, "out", P(1, 1), "smooth").in).toEqual(P(-4, -4));
  });

  it("converting: a click on a smooth point leaves a corner with no direction lines; dragging a corner makes a smooth point", () => {
    let path: VectorPath = addSubpath({ subpaths: [] }, smoothKnot(P(5, 5), P(9, 5)));
    path = toCorner(path, { sub: 0, knot: 0 });
    expect(path.subpaths[0].knots[0]).toMatchObject({ in: P(5, 5), out: P(5, 5), smooth: false });
    path = toSmooth(path, { sub: 0, knot: 0 }, P(5, 12));
    expect(path.subpaths[0].knots[0]).toMatchObject({ out: P(5, 12), in: P(5, -2), smooth: true });
  });
});

describe("editing a path", () => {
  const line = (): VectorPath => extend(extend(addSubpath({ subpaths: [] }, cornerKnot(P(0, 0))), 0, cornerKnot(P(10, 0))), 0, cornerKnot(P(10, 10)));

  it("an open path has one fewer segment than points; closing adds one", () => {
    expect(segmentCount(line().subpaths[0])).toBe(2);
    expect(segmentCount(closeSubpath(line(), 0).subpaths[0])).toBe(3);
  });

  it("adding an anchor point on a curve keeps its shape exactly (smooth); on a straight segment it's a corner", () => {
    let c = addSubpath({ subpaths: [] }, { anchor: P(0, 0), in: P(0, 0), out: P(0, 20) });
    c = extend(c, 0, { anchor: P(20, 0), in: P(20, 20), out: P(20, 0) });
    const { path, ref } = insertKnot(c, 0, 0, 0.5);
    const k = path.subpaths[0].knots[ref.knot];
    expect(path.subpaths[0].knots).toHaveLength(3);
    expect(isSmooth(k)).toBe(true);
    // The curve through the new point is the original one: (10, 15) at t = ½.
    expect(k.anchor.x).toBeCloseTo(10);
    expect(k.anchor.y).toBeCloseTo(15);
    const s = insertKnot(line(), 0, 0, 0.3);
    expect(s.path.subpaths[0].knots[1]).toMatchObject({ anchor: P(3, 0), smooth: false, in: P(3, 0), out: P(3, 0) });
  });

  it("splitting the closing segment of a closed path adds the point last", () => {
    const { path, ref } = insertKnot({ subpaths: [square(0, 0, 10)] }, 0, 3, 0.5);
    expect(ref.knot).toBe(4);
    expect(path.subpaths[0].knots[4].anchor).toEqual(P(0, 5));
  });

  it("deleting an anchor point joins its neighbours; the last one removes the component", () => {
    const sq = { subpaths: [square(0, 0, 10)] };
    expect(removeKnot(sq, { sub: 0, knot: 1 }).subpaths[0].knots).toHaveLength(3);
    const one = addSubpath({ subpaths: [] }, cornerKnot(P(1, 1)));
    expect(removeKnot(one, { sub: 0, knot: 0 }).subpaths).toHaveLength(0);
  });

  it("deleting a segment opens a closed path there, and splits an open one", () => {
    const opened = deleteSegment({ subpaths: [square(0, 0, 10)] }, 0, 1).subpaths;
    expect(opened).toHaveLength(1);
    expect(opened[0].closed).toBe(false);
    // From the point after the cut round to the one before it.
    expect(opened[0].knots.map((k) => k.anchor)).toEqual([P(10, 10), P(0, 10), P(0, 0), P(10, 0)]);
    const split = deleteSegment(line(), 0, 0).subpaths;
    expect(split.map((s) => s.knots.length)).toEqual([1, 2]);
  });

  it("Delete on selected points: segments between two selected neighbours go; a lone point goes with the segments touching it; a whole component goes", () => {
    const sq = { subpaths: [square(0, 0, 10)] };
    const knot = (k: number) => ({ sub: 0, knot: k });
    // A selected segment: only that segment goes; the path opens.
    const cut = deleteSelection(sq, [knot(1), knot(2)]);
    const seg = cut.path.subpaths;
    // The two points stay selected, now ends of the opened path: Delete again erases them.
    expect(cut.selected).toEqual([{ sub: 0, knot: 3 }, { sub: 0, knot: 0 }]);
    expect(seg).toHaveLength(1);
    expect(seg[0].closed).toBe(false);
    expect(seg[0].knots.map((k) => k.anchor)).toEqual([P(10, 10), P(0, 10), P(0, 0), P(10, 0)]);
    // A lone point: it goes, with both its segments; the other three stay as an open path.
    const lone = deleteSelection(sq, [knot(1)]).path.subpaths;
    expect(lone).toHaveLength(1);
    expect(lone[0].knots.map((k) => k.anchor)).toEqual([P(10, 10), P(0, 10), P(0, 0)]);
    // Every point: the component goes.
    expect(deleteSelection(sq, [knot(0), knot(1), knot(2), knot(3)]).path.subpaths).toHaveLength(0);
    // Two cuts in a closed path leave two pieces.
    const two = deleteSegments(sq, 0, [0, 2]).subpaths;
    expect(two.map((s) => s.knots.map((k) => k.anchor))).toEqual([[P(10, 0), P(10, 10)], [P(0, 10), P(0, 0)]]);
    // An open path: a lone middle point splits it.
    const open: VectorPath = { subpaths: [{ closed: false, op: "combine", knots: [cornerKnot(P(0, 0)), cornerKnot(P(5, 0)), cornerKnot(P(10, 0))] }] };
    expect(deleteSelection(open, [knot(1)]).path.subpaths.map((s) => s.knots.length)).toEqual([1, 1]);
  });

  it("joins two open paths at their ends, in order, and closes a path by joining its own ends", () => {
    let path = line();
    path = { subpaths: [...path.subpaths, { knots: [cornerKnot(P(20, 10)), cornerKnot(P(30, 10))], closed: false, op: "combine" }] };
    const j = joinEnds(path, { sub: 0, knot: 2 }, { sub: 1, knot: 0 });
    expect(j.path.subpaths).toHaveLength(1);
    expect(j.path.subpaths[0].knots.map((k) => k.anchor.x)).toEqual([0, 10, 10, 20, 30]);
    // Joined at the far end of the other: it's turned round.
    const r = joinEnds(path, { sub: 0, knot: 2 }, { sub: 1, knot: 1 });
    expect(r.path.subpaths[0].knots.map((k) => k.anchor.x)).toEqual([0, 10, 10, 30, 20]);
    expect(joinEnds(line(), { sub: 0, knot: 2 }, { sub: 0, knot: 0 }).path.subpaths[0].closed).toBe(true);
  });

  it("finds the segment nearest a point, with where along it", () => {
    const hit = nearestSegment({ subpaths: [square(0, 0, 10)] }, P(5, -1), 3)!;
    expect(hit).toMatchObject({ sub: 0, seg: 0 });
    expect(hit.t).toBeCloseTo(0.5);
    expect(nearestSegment({ subpaths: [square(0, 0, 10)] }, P(5, -5), 3)).toBeNull();
  });

  it("dragging a straight segment moves both its points; a curve's direction points move so it follows the pointer", () => {
    const moved = dragSegment({ subpaths: [square(0, 0, 10)] }, 0, 0, 0.5, P(0, 4), false).subpaths[0].knots;
    expect(moved.map((k) => k.anchor)).toEqual([P(0, 4), P(10, 4), P(10, 10), P(0, 10)]);
    let c = addSubpath({ subpaths: [] }, { anchor: P(0, 0), in: P(0, 0), out: P(0, 20) });
    c = extend(c, 0, { anchor: P(20, 0), in: P(20, 20), out: P(20, 0) });
    const d = dragSegment(c, 0, 0, 0.5, P(0, 5), false).subpaths[0];
    const k = insertKnot({ subpaths: [d] }, 0, 0, 0.5).path.subpaths[0].knots[1].anchor;
    expect(k.y).toBeCloseTo(15 + 5, 1);
    expect(k.x).toBeCloseTo(10, 1);
  });

  it("dragging a curve between smooth points bends the neighbouring segments too, unless constrained", () => {
    const smooth = (a: number, hx: number, hy: number) => smoothKnot(P(a, 0), P(a + hx, hy));
    const base: VectorPath = { subpaths: [{ closed: false, op: "combine", knots: [smooth(0, 5, 5), smooth(20, 5, -5), smooth(40, 5, 5)] }] };
    const free = dragSegment(base, 0, 0, 0.5, P(0, 6), false).subpaths[0].knots[1];
    const held = dragSegment(base, 0, 0, 0.5, P(0, 6), true).subpaths[0].knots[1];
    // Free: the middle point's other direction line turned with the dragged one.
    expect(free.out.y).not.toBe(base.subpaths[0].knots[1].out.y);
    expect(isSmooth(free)).toBe(true);
    // Constrained: the segment after it is untouched.
    expect(held.out).toEqual(base.subpaths[0].knots[1].out);
  });
});

describe("shape areas", () => {
  const two = (op: Subpath["op"]): VectorPath => ({ subpaths: [square(10, 10, 30), square(25, 25, 30, op)] });

  it("combine unites overlapping components, whichever way each is wound", () => {
    expect(area(two("combine"))).toBe(900 + 900 - 15 * 15);
    const reversed: VectorPath = { subpaths: [square(10, 10, 30), { ...square(25, 25, 30), knots: [...square(25, 25, 30).knots].reverse() }] };
    expect(area(reversed)).toBe(area(two("combine")));
  });

  it("subtract, intersect and exclude act on the components before them", () => {
    expect(area(two("subtract"))).toBe(900 - 225);
    expect(area(two("intersect"))).toBe(225);
    expect(area(two("exclude"))).toBe(900 + 900 - 2 * 225);
  });

  it("operations apply in order: a later subtract cuts everything before it", () => {
    const path: VectorPath = { subpaths: [square(10, 10, 20), square(25, 10, 20), square(20, 15, 10, "subtract")] };
    // 400 + 400 - 100 (overlap) = 700, less the 10 × 10 cut.
    expect(area(path)).toBe(600);
  });

  it("merging overlapping components leaves one outline with no overlap", () => {
    const merged = mergeComponents(two("combine"));
    expect(area(merged)).toBe(area(two("combine")));
    expect(merged.subpaths.length).toBe(1);
    expect(mergeComponents({ subpaths: [square(0, 0, 40), square(10, 10, 10, "subtract")] }).subpaths.map((s) => s.op)).toEqual(["combine", "subtract"]);
  });
});

describe("components", () => {
  const three = (): VectorPath => ({ subpaths: [square(0, 0, 10), square(30, 5, 10), square(100, 12, 10)] });
  const lefts = (p: VectorPath) => p.subpaths.map((s) => s.knots[0].anchor.x);
  const tops = (p: VectorPath) => p.subpaths.map((s) => s.knots[0].anchor.y);

  it("aligns to the edges and centres of the selection, and distributes three or more evenly", () => {
    expect(lefts(alignSubpaths(three(), [0, 1, 2], "left"))).toEqual([0, 0, 0]);
    expect(lefts(alignSubpaths(three(), [0, 1, 2], "right"))).toEqual([100, 100, 100]);
    expect(tops(alignSubpaths(three(), [0, 2], "vcenter"))).toEqual([6, 5, 6]);
    expect(lefts(distributeSubpaths(three(), [0, 1, 2], "left"))).toEqual([0, 50, 100]);
    // Fewer than three: nothing to spread.
    expect(distributeSubpaths(three(), [0, 1], "left")).toEqual(three());
  });

  it("arranges components in the order operations apply in", () => {
    const a = arrangeSubpaths(three(), [0], "front");
    expect(lefts(a.path)).toEqual([30, 100, 0]);
    expect(a.moved).toEqual([2]);
    expect(lefts(arrangeSubpaths(three(), [2], "backward").path)).toEqual([0, 100, 30]);
    expect(lefts(arrangeSubpaths(three(), [1], "back").path)).toEqual([30, 0, 100]);
  });
});

describe("path shapes", () => {
  const style: ShapeStyle = { fill: { r: 0, g: 0, b: 0 }, stroke: null };
  const content = (path: VectorPath, s = style) => pathShape(path, s)!;
  const draw = (c: ReturnType<typeof content>, clip = rect(0, 0, 100, 100)) => {
    const px = renderShape(c.geometry, c.style, placementMapping(c.placement), clip);
    const d = readRect(px, clip);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) n++;
    return n;
  };

  it("render with their operations: a donut is an outer component and a subtracted inner one", () => {
    const donut: VectorPath = { subpaths: [square(10, 10, 60), square(25, 25, 30, "subtract")] };
    expect(draw(content(donut))).toBe(3600 - 900);
  });

  it("open components are filled as if closed, and stroked as lines without a closing edge", () => {
    const tri: VectorPath = {
      subpaths: [{ closed: false, op: "combine", knots: [cornerKnot(P(10, 10)), cornerKnot(P(60, 10)), cornerKnot(P(60, 50))] }],
    };
    expect(draw(content(tri))).toBe(Math.round((50 * 40) / 2));
    const stroked = content(tri, { fill: null, stroke: { color: { r: 0, g: 0, b: 0 }, width: 4, align: "center" } });
    // Two edges of 50 and 40, 4 wide; the hypotenuse is left unstroked.
    expect(draw(stroked)).toBeGreaterThan(50 * 4 + 40 * 4 - 40);
    expect(draw(stroked)).toBeLessThan(50 * 4 + 40 * 4 + 40);
  });

  it("round-trip through a document-space path with their operations and open ends intact", () => {
    const path: VectorPath = {
      subpaths: [square(10, 10, 40), { ...square(20, 20, 10, "exclude"), closed: false }],
    };
    const c = content(path);
    const back = documentPath(c.geometry, placementMapping(c.placement));
    expect(back.subpaths.map((s) => [s.op, s.closed, s.knots.length])).toEqual([["combine", true, 4], ["exclude", false, 4]]);
    expect(back.subpaths[0].knots[2].anchor.x).toBeCloseTo(50);
  });
});

describe("hit testing", () => {
  const sq = { subpaths: [square(10, 10, 20)] };

  it("finds direction points of selected anchors only", () => {
    const path = addSubpath({ subpaths: [] }, smoothKnot(P(10, 10), P(20, 10)));
    expect(handleAt(path, [{ sub: 0, knot: 0 }], P(20.5, 10), 2)).toEqual({ ref: { sub: 0, knot: 0 }, side: "out" });
    expect(handleAt(path, [], P(20, 10), 2)).toBeNull();
    expect(handleAt(path, [{ sub: 0, knot: 0 }], P(0, 10), 2)?.side).toBe("in");
  });

  it("tells whether a point is inside a component, and which components a rectangle touches", () => {
    expect(pointInSubpath(sq.subpaths[0], P(20, 20))).toBe(true);
    expect(pointInSubpath(sq.subpaths[0], P(5, 20))).toBe(false);
    expect(subpathTouchesRect(sq.subpaths[0], rect(25, 5, 10, 10))).toBe(true); // a corner inside
    expect(subpathTouchesRect(sq.subpaths[0], rect(0, 18, 40, 4))).toBe(true); // crossing, with no corner inside
    expect(subpathTouchesRect(sq.subpaths[0], rect(40, 40, 5, 5))).toBe(false);
  });

  it("selects anchors in a rectangle; a component is selected when all its anchors are; two selected neighbours make a selected segment", () => {
    expect(anchorsIn(sq, rect(0, 0, 25, 25)).map((r) => r.knot)).toEqual([0]);
    const all = allAnchors(sq, [0]);
    expect(selectedSubpaths(sq, all)).toEqual([0]);
    expect(selectedSubpaths(sq, all.slice(1))).toEqual([]);
    expect(selectedSegments(sq, [{ sub: 0, knot: 1 }, { sub: 0, knot: 2 }])).toEqual([{ sub: 0, seg: 1 }]);
    expect(selectedSegments(sq, [{ sub: 0, knot: 3 }, { sub: 0, knot: 0 }])).toEqual([{ sub: 0, seg: 3 }]); // the closing one
    expect(selectedSegments(sq, [{ sub: 0, knot: 0 }, { sub: 0, knot: 2 }])).toEqual([]);
  });
});
