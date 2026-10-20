import { describe, expect, it } from "vitest";
import { apply, rect, vec } from "./geometry";
import { dragHandle, dragMove, dragRotate, handlePoint, hitTest, initialTransform, transformMatrix } from "./transform";

const s0 = initialTransform(rect(0, 0, 100, 50));
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};
const free = { proportional: false, fromCenter: false };

describe("free transform", () => {
  it("starts as identity", () => near(apply(transformMatrix(s0), vec(13, 7)), vec(13, 7)));

  it("hit-tests handles, the interior and the outside", () => {
    expect(hitTest(s0, vec(101, 49), 4)).toEqual({ kind: "handle", hx: 1, hy: 1 });
    expect(hitTest(s0, vec(50, 1), 4)).toEqual({ kind: "handle", hx: 0, hy: -1 });
    expect(hitTest(s0, vec(30, 30), 4)).toEqual({ kind: "move" });
    expect(hitTest(s0, vec(150, 30), 4)).toEqual({ kind: "rotate" });
  });

  it("picks the nearest handle when several are in range", () => {
    const small = initialTransform(rect(0, 0, 10, 10));
    expect(hitTest(small, vec(10, 10), 6)).toEqual({ kind: "handle", hx: 1, hy: 1 });
  });

  it("drags a corner, anchoring the opposite corner", () => {
    const s = dragHandle(s0, 1, 1, vec(200, 100), free);
    near(handlePoint(s, -1, -1), vec(0, 0));
    near(handlePoint(s, 1, 1), vec(200, 100));
  });

  it("drags an edge on one axis only", () => {
    const s = dragHandle(s0, 1, 0, vec(150, 999), free);
    expect(s.sy).toBe(1);
    near(handlePoint(s, 1, 1), vec(150, 50));
    near(handlePoint(s, -1, -1), vec(0, 0));
  });

  it("keeps aspect ratio when proportional", () => {
    const s = dragHandle(s0, 1, 1, vec(200, 60), { proportional: true, fromCenter: false });
    expect(s.sx).toBeCloseTo(2);
    expect(s.sy).toBeCloseTo(2);
  });

  it("scales about the centre", () => {
    const s = dragHandle(s0, 1, 1, vec(150, 75), { proportional: false, fromCenter: true });
    near(handlePoint(s, -1, -1), vec(-50, -25));
  });

  it("flips when dragged past the anchor", () => {
    const s = dragHandle(s0, 1, 0, vec(-100, 25), free);
    expect(s.sx).toBeCloseTo(-1);
  });

  it("drags handles of rotated boxes in the box's frame", () => {
    const r = { ...s0, angle: Math.PI / 2 };
    const anchor = handlePoint(r, -1, -1);
    const s = dragHandle(r, 1, 1, handlePoint({ ...r, sx: 2, cx: r.cx, cy: r.cy + 50 }, 1, 1), free);
    near(handlePoint(s, -1, -1), anchor);
    expect(s.sx).toBeCloseTo(2);
  });

  it("rotates about the centre, optionally snapping to 15°", () => {
    const s = dragRotate(s0, vec(100, 25), vec(50, 125), false);
    expect(s.angle).toBeCloseTo(Math.PI / 2);
    const snapped = dragRotate(s0, vec(100, 25), vec(100, 34), true);
    expect(snapped.angle).toBeCloseTo(Math.PI / 12);
  });

  it("moves", () => near(handlePoint(dragMove(s0, 5, 6), -1, -1), vec(5, 6)));
});
