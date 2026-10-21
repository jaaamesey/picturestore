import { describe, expect, it } from "vitest";
import { docToScreen, followRemap, screenToDoc } from "./view";

describe("followRemap", () => {
  const viewport = { width: 800, height: 600 };
  it("Image Size: keeps the zoom and the centred image point centred", () => {
    // At 100%, looking at (1000, 700) of a 3000×2000 image.
    const v = { zoom: 1, panX: 400 - 1000, panY: 300 - 700 };
    const half = followRemap(v, viewport, { width: 1500, height: 1000 }, (p) => ({ x: p.x / 2, y: p.y / 2 }), true);
    expect(half.zoom).toBe(1);
    expect(screenToDoc(half, { x: 400, y: 300 })).toEqual({ x: 500, y: 350 });
  });

  it("Image Size: centres an axis the new image fits within", () => {
    const v = { zoom: 1, panX: 400 - 1000, panY: 300 - 700 };
    const small = followRemap(v, viewport, { width: 600, height: 400 }, (p) => ({ x: p.x / 5, y: p.y / 5 }), true);
    expect(small).toEqual({ zoom: 1, panX: 100, panY: 100 });
  });

  it("Canvas Size: existing content stays where it was on screen", () => {
    const v = { zoom: 0.5, panX: 37, panY: -12 };
    const grown = followRemap(v, viewport, { width: 600, height: 400 }, (p) => ({ x: p.x + 100, y: p.y + 50 }), false);
    // Old document point (0, 0) is now (100, 50): same screen position.
    expect(docToScreen(grown, { x: 100, y: 50 })).toEqual(docToScreen(v, { x: 0, y: 0 }));
  });
});
