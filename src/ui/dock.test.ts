import { describe, expect, it } from "vitest";
import { DEFAULT_DOCK, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, PANEL_MIN_HEIGHT, dividerPanels, dragDivider, normalizeDock, toggleMinimized, withWidth } from "./dock";

describe("dock layout", () => {
  it("keeps its width within bounds", () => {
    expect(withWidth(DEFAULT_DOCK, 10).width).toBe(DOCK_MIN_WIDTH);
    expect(withWidth(DEFAULT_DOCK, 5000).width).toBe(DOCK_MAX_WIDTH);
  });

  it("a divider trades height between the panels either side, down to their minimum", () => {
    const heights = [200, 250, 400];
    const d = dragDivider(DEFAULT_DOCK, heights, 0, 50);
    expect(d.panels.map((p) => p.size)).toEqual([250, 200, 400]);
    const squeezed = dragDivider(DEFAULT_DOCK, heights, 1, 1000);
    expect(squeezed.panels.map((p) => p.size)).toEqual([200, 650 - PANEL_MIN_HEIGHT, PANEL_MIN_HEIGHT]);
  });

  it("skips minimized panels: a divider resizes the nearest open ones", () => {
    const d = toggleMinimized(DEFAULT_DOCK, "properties");
    expect(dividerPanels(d, 0)).toEqual([0, 2]);
    expect(dividerPanels(d, 1)).toEqual([0, 2]);
    expect(dividerPanels(toggleMinimized(d, "layers"), 0)).toBeNull();
    expect(dragDivider(d, [200, 24, 400], 0, -40).panels.map((p) => p.size)).toEqual([160, DEFAULT_DOCK.panels[1].size, 440]);
  });

  it("restores a stored layout, repairing what's missing or invalid", () => {
    const d = normalizeDock({ width: 300, panels: [{ id: "layers", size: 500, minimized: true }, { id: "bogus" }, { id: "history", size: -1 }] });
    expect(d.width).toBe(300);
    expect(d.panels.map((p) => p.id)).toEqual(["layers", "history", "properties"]);
    expect(d.panels[0]).toEqual({ id: "layers", size: 500, minimized: true });
    expect(d.panels[1].size).toBe(DEFAULT_DOCK.panels[0].size);
    expect(normalizeDock("nonsense")).toEqual(DEFAULT_DOCK);
  });
});
