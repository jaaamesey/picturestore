import { describe, expect, it } from "vitest";
import { rect, vec, type Vec2 } from "./geometry";
import {
  dragTransform, flip, handles, hitTest, initialTransform, integerOffset, isIdentityTransform, numeric, rotateAbout,
  warpPoints, withNumeric, type Drag, type HitOptions, type Modifiers, type TransformHit, type TransformMode,
  type TransformState,
} from "./transform";
import { IDENTITY_PATCH, mapPoint } from "./warp";

const s0 = initialTransform(rect(0, 0, 100, 50));
const none: Modifiers = { shift: false, alt: false, mod: false };
const near = (a: Vec2, b: Vec2, d = 6) => {
  expect(a.x).toBeCloseTo(b.x, d);
  expect(a.y).toBeCloseTo(b.y, d);
};
const corner = (index: number): TransformHit => ({ kind: "corner", index });
const edge = (index: number): TransformHit => ({ kind: "edge", index });

function drag(
  hit: TransformHit,
  start: Vec2,
  end: Vec2,
  mods: Partial<Modifiers> = {},
  opts: { from?: TransformState; mode?: TransformMode; link?: boolean } = {},
) {
  const d: Drag = { hit, start, from: opts.from ?? s0, mode: opts.mode ?? "free", link: opts.link ?? true };
  return dragTransform(d, end, { ...none, ...mods });
}

const opts: HitOptions = { tolerance: 4, mode: "free", showReference: false, rotateBand: Infinity };

describe("setup", () => {
  it("starts as the identity with the reference at the centre", () => {
    expect(isIdentityTransform(s0)).toBe(true);
    near(s0.reference, vec(50, 25));
    near(handles(s0).edges[1], vec(100, 25));
  });

  it("recognises pure integer translations", () => {
    expect(integerOffset(drag({ kind: "move" }, vec(10, 10), vec(13, 8)))).toEqual(vec(3, -2));
    expect(integerOffset(drag({ kind: "move" }, vec(10, 10), vec(13.5, 8)))).toBeNull();
  });
});

describe("hit testing", () => {
  it("prefers the nearest handle, then inside/outside", () => {
    const small = initialTransform(rect(0, 0, 6, 6));
    expect(hitTest(small, vec(6, 6), { ...opts, tolerance: 6 })).toEqual(corner(2));
    expect(hitTest(s0, vec(51, 1), opts)).toEqual(edge(0));
    expect(hitTest(s0, vec(30, 30), opts)).toEqual({ kind: "move" });
    expect(hitTest(s0, vec(150, 30), opts)).toEqual({ kind: "rotate" });
  });

  it("limits the rotate zone for the Move tool's persistent controls", () => {
    expect(hitTest(s0, vec(150, 30), { ...opts, rotateBand: 20 })).toEqual({ kind: "none" });
    expect(hitTest(s0, vec(110, 30), { ...opts, rotateBand: 20 })).toEqual({ kind: "rotate" });
  });

  it("only rotates outside the box in free and rotate modes", () => {
    expect(hitTest(s0, vec(150, 30), { ...opts, mode: "skew" })).toEqual({ kind: "none" });
  });

  it("finds the reference point only when shown", () => {
    expect(hitTest(s0, vec(50, 25), opts)).toEqual({ kind: "move" });
    expect(hitTest(s0, vec(50, 25), { ...opts, showReference: true })).toEqual({ kind: "reference" });
  });

  it("hits warp control points and the warp surface", () => {
    const w = { ...opts, mode: "warp" as const };
    expect(hitTest(s0, vec(0, 0), w)).toEqual({ kind: "warp-point", index: 0 });
    const hit = hitTest(s0, vec(25, 40), w);
    expect(hit.kind).toBe("warp-surface");
    if (hit.kind === "warp-surface") {
      expect(hit.s).toBeCloseTo(0.25, 5);
      expect(hit.t).toBeCloseTo(0.8, 5);
    }
  });
});

describe("scaling (Photoshop 2020+ behaviour)", () => {
  it("scales proportionally from a corner by default, anchored at the opposite corner", () => {
    const s = drag(corner(2), vec(100, 50), vec(200, 100));
    near(s.quad[0], vec(0, 0));
    near(s.quad[2], vec(200, 100));
  });

  it("Shift scales freely", () => {
    const s = drag(corner(2), vec(100, 50), vec(200, 60), { shift: true });
    near(s.quad[2], vec(200, 60));
  });

  it("with the link off, plain drags are free and Shift constrains", () => {
    near(drag(corner(2), vec(100, 50), vec(200, 60), {}, { link: false }).quad[2], vec(200, 60));
    const s = drag(corner(2), vec(100, 50), vec(200, 60), { shift: true }, { link: false });
    expect((s.quad[2].x - s.quad[0].x) / (s.quad[2].y - s.quad[0].y)).toBeCloseTo(2, 6);
  });

  it("Alt scales about the reference point", () => {
    const s = drag(corner(2), vec(100, 50), vec(150, 75), { alt: true });
    near(s.quad[0], vec(-50, -25));
    near(s.reference, vec(50, 25));
  });

  it("side handles scale both axes proportionally, about the centre line", () => {
    const s = drag(edge(1), vec(100, 25), vec(150, 25));
    near(s.quad[1], vec(150, -12.5));
    near(s.quad[2], vec(150, 62.5));
    near(drag(edge(1), vec(100, 25), vec(150, 25), { shift: true }).quad[2], vec(150, 50));
  });

  it("flips when dragged through the anchor", () => {
    const s = drag(edge(1), vec(100, 25), vec(-100, 25), { shift: true });
    near(s.quad[1], vec(-100, 0));
  });

  it("works in a rotated box's own frame", () => {
    const r = rotateAbout(s0, Math.PI / 2);
    const s = drag(corner(2), r.quad[2], vec(r.quad[2].x - 50, r.quad[2].y + 100), { shift: true }, { from: r });
    near(s.quad[0], r.quad[0]);
    expect(Math.hypot(s.quad[1].x - s.quad[0].x, s.quad[1].y - s.quad[0].y)).toBeCloseTo(200, 6);
  });
});

describe("rotate and move", () => {
  it("rotates about the reference point, snapping to 15° with Shift", () => {
    const s = drag({ kind: "rotate" }, vec(150, 25), vec(50, 125));
    expect(s.angle).toBeCloseTo(Math.PI / 2, 6);
    near(s.reference, vec(50, 25));
    expect(drag({ kind: "rotate" }, vec(150, 25), vec(150, 50), { shift: true }).angle).toBeCloseTo(Math.PI / 12, 6); // 14° → 15°
  });

  it("moves, constraining to 45° steps with Shift", () => {
    near(drag({ kind: "move" }, vec(10, 10), vec(30, 13)).quad[0], vec(20, 3));
    near(drag({ kind: "move" }, vec(10, 10), vec(30, 13), { shift: true }).quad[0], vec(20, 0), 0);
  });

  it("rotates on any drag in Rotate mode", () => {
    expect(drag({ kind: "move" }, vec(150, 25), vec(50, 125), {}, { mode: "rotate" }).angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it("drags the reference point", () => {
    near(drag({ kind: "reference" }, vec(50, 25), vec(0, 0)).reference, vec(0, 0));
  });
});

describe("skew, distort, perspective", () => {
  it("Ctrl+corner distorts one corner; Shift locks the axis", () => {
    const s = drag(corner(1), vec(100, 0), vec(110, -20), { mod: true });
    near(s.quad[1], vec(110, -20));
    near(s.quad[0], vec(0, 0));
    near(drag(corner(1), vec(100, 0), vec(110, -20), { mod: true, shift: true }).quad[1], vec(100, -20));
  });

  it("Ctrl+Shift+side skews along the edge; Alt skews the opposite side too", () => {
    const s = drag(edge(0), vec(50, 0), vec(70, 30), { mod: true, shift: true });
    near(s.quad[0], vec(20, 0));
    near(s.quad[1], vec(120, 0));
    near(s.quad[3], vec(0, 50));
    const sym = drag(edge(0), vec(50, 0), vec(70, 30), { mod: true, shift: true, alt: true });
    near(sym.quad[3], vec(-20, 50));
  });

  it("Ctrl+side moves the edge freely", () => {
    near(drag(edge(1), vec(100, 25), vec(120, 35), { mod: true }).quad[2], vec(120, 60));
  });

  it("Ctrl+Alt+Shift+corner applies perspective symmetrically", () => {
    const s = drag(corner(0), vec(0, 0), vec(20, 3), { mod: true, alt: true, shift: true });
    near(s.quad[0], vec(20, 0));
    near(s.quad[1], vec(80, 0));
    near(s.quad[2], vec(100, 50));
    const v = drag(corner(0), vec(0, 0), vec(2, 10), { mod: true, alt: true, shift: true });
    near(v.quad[0], vec(0, 10));
    near(v.quad[3], vec(0, 40));
  });

  it("menu modes apply without modifiers", () => {
    near(drag(edge(0), vec(50, 0), vec(70, 30), {}, { mode: "skew" }).quad[0], vec(20, 0));
    near(drag(corner(1), vec(100, 0), vec(110, -20), {}, { mode: "distort" }).quad[1], vec(110, -20));
    near(drag(corner(0), vec(0, 0), vec(20, 3), {}, { mode: "perspective" }).quad[1], vec(80, 0));
  });

  it("refuses to fold the quad", () => {
    const s = drag(corner(1), vec(100, 0), vec(10, 60), { mod: true });
    expect(s).toBe(s0);
  });

  it("projective mappings send the source centre to the projected centre", () => {
    const s = drag(corner(0), vec(0, 0), vec(30, 0), { mod: true, alt: true, shift: true });
    const c = mapPoint({ source: s.source, quad: s.quad, patch: null }, 0.5, 0.5);
    expect(c.x).toBeCloseTo(50, 6);
    expect(c.y).toBeLessThan(25); // foreshortened towards the narrow (far) edge
  });
});

describe("flip and numeric entry", () => {
  it("flips about the reference point", () => {
    const s = flip(s0, "horizontal");
    near(s.quad[0], vec(100, 0));
    near(s.quad[1], vec(0, 0));
  });

  it("reads back numeric values", () => {
    expect(numeric(s0)).toEqual({ x: 50, y: 25, w: 100, h: 100, angle: 0, hSkew: 0, vSkew: 0 });
    const n = numeric(rotateAbout(withNumeric(s0, { w: 50, hSkew: 30 }), Math.PI / 6));
    expect(n.w).toBeCloseTo(50, 6);
    expect(n.hSkew).toBeCloseTo(30, 6);
    expect(n.angle).toBeCloseTo(30, 6);
  });

  it("applies numeric edits about the reference point", () => {
    const s = withNumeric(s0, { w: 200 });
    near(s.quad[0], vec(-50, 0));
    near(s.quad[1], vec(150, 0));
    near(withNumeric(s0, { x: 60, y: 30 }).quad[0], vec(10, 5));
    const r = withNumeric(s0, { angle: 90 });
    near(r.quad[0], vec(75, -25));
  });

  it("numeric edits preserve existing distortion", () => {
    const d = drag(corner(2), vec(100, 50), vec(120, 70), { mod: true });
    const moved = withNumeric(d, { x: d.reference.x + 10 });
    near(moved.quad[2], vec(130, 70));
  });
});

describe("warp", () => {
  const warpMode = { mode: "warp" as const };

  it("dragging an anchor carries its handles", () => {
    const s = drag({ kind: "warp-point", index: 0 }, vec(0, 0), vec(10, 5), {}, warpMode);
    const pts = warpPoints(s);
    near(pts[0], vec(10, 5));
    near(pts[1], vec(100 / 3 + 10, 5));
    near(pts[4], vec(10, 50 / 3 + 5));
    near(pts[5], vec(100 / 3, 50 / 3));
  });

  it("dragging the surface moves the grabbed point with the cursor", () => {
    const s = drag({ kind: "warp-surface", s: 0.5, t: 0.5 }, vec(50, 25), vec(60, 10), {}, warpMode);
    near(mapPoint({ source: s.source, quad: s.quad, patch: s.patch }, 0.5, 0.5), vec(60, 10));
    expect(s.patch).not.toEqual(IDENTITY_PATCH);
  });

  it("warp composes with perspective (edits happen before the homography)", () => {
    const p = drag(corner(0), vec(0, 0), vec(20, 0), { mod: true, alt: true, shift: true });
    const s = drag({ kind: "warp-point", index: 15 }, p.quad[2], vec(p.quad[2].x + 5, p.quad[2].y), {}, { ...warpMode, from: p });
    near(warpPoints(s)[15], vec(105, 50));
    near(warpPoints(s)[0], p.quad[0]);
  });
});
