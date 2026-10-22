import { describe, expect, it } from "vitest";
import { DEFAULT_DOCK, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, PANEL_MIN_HEIGHT, closePanel, dividerPanels, dragDivider, isOpen, normalizeDock, openPanel, toggleMinimized, togglePanel, togglePanels, withWidth } from "./dock";

describe("dock layout", () => {
  it("keeps its width within bounds", () => {
    expect(withWidth(DEFAULT_DOCK, 10).width).toBe(DOCK_MIN_WIDTH);
    expect(withWidth(DEFAULT_DOCK, 5000).width).toBe(DOCK_MAX_WIDTH);
  });

  it("a divider trades height between the panels either side, down to their minimum", () => {
    const heights = [200, 250, 400];
    const d = dragDivider(DEFAULT_DOCK, heights, 0, 50);
    expect(d.groups.map((p) => p.size)).toEqual([250, 200, 400]);
    const squeezed = dragDivider(DEFAULT_DOCK, heights, 1, 1000);
    expect(squeezed.groups.map((p) => p.size)).toEqual([200, 650 - PANEL_MIN_HEIGHT, PANEL_MIN_HEIGHT]);
  });

  it("skips minimized panels: a divider resizes the nearest open ones", () => {
    const d = toggleMinimized(DEFAULT_DOCK, "properties");
    expect(dividerPanels(d, 0)).toEqual([0, 2]);
    expect(dividerPanels(d, 1)).toEqual([0, 2]);
    expect(dividerPanels(toggleMinimized(d, "layers"), 0)).toBeNull();
    expect(dragDivider(d, [200, 24, 400], 0, -40).groups.map((p) => p.size)).toEqual([160, DEFAULT_DOCK.groups[1].size, 440]);
  });

  it("restores a stored layout, repairing what's missing or invalid; a layout from before groups gains them", () => {
    const d = normalizeDock({ width: 300, panels: [{ id: "layers", size: 500, minimized: true }, { id: "bogus" }, { id: "history", size: -1 }] });
    expect(d.width).toBe(300);
    expect(d.groups.map((g) => g.id)).toEqual(["layers", "history", "properties"]);
    expect(d.groups[0]).toEqual({ id: "layers", tabs: ["layers"], active: "layers", size: 500, minimized: true });
    expect(d.groups[1].size).toBe(DEFAULT_DOCK.groups[0].size);
    expect(normalizeDock("nonsense")).toEqual(DEFAULT_DOCK);
    // A closed panel stays closed.
    const closed = closePanel(DEFAULT_DOCK, "history");
    expect(normalizeDock(JSON.parse(JSON.stringify(closed))).groups.map((g) => g.id)).toEqual(["properties", "layers"]);
    // Tabs are kept once each, the front one valid.
    const g = normalizeDock({ groups: [{ tabs: ["character", "paragraph", "character"], active: "nope", size: 100 }, { tabs: ["paragraph"] }] });
    expect(g.groups).toEqual([{ id: "character", tabs: ["character", "paragraph"], active: "character", size: 100, minimized: false }]);
  });

  it("opens panels in Photoshop's groups, to the front; closes them tab by tab", () => {
    const d = openPanel(DEFAULT_DOCK, "paragraph");
    expect(d.groups[0]).toMatchObject({ tabs: ["character", "paragraph"], active: "paragraph" });
    expect(isOpen(d, "paragraph")).toBe(true);
    expect(isOpen(d, "character")).toBe(false);
    const c = togglePanel(d, "character");
    expect(c.groups[0].active).toBe("character");
    const closed = togglePanel(c, "character");
    expect(closed.groups[0]).toMatchObject({ tabs: ["paragraph"], active: "paragraph" });
    // Reopened: it doesn't take Paragraph from where it is.
    expect(openPanel(closed, "character").groups[0]).toMatchObject({ tabs: ["character"] });
    expect(togglePanel(closed, "paragraph").groups.map((g) => g.id)).toEqual(["history", "properties", "layers"]);
    // Opening restores a minimized group.
    expect(openPanel(toggleMinimized(d, "character"), "character").groups[0]).toMatchObject({ minimized: false, active: "character" });
  });

  it("toggles Character and Paragraph together, as the Type tools' panel button does", () => {
    const d = togglePanels(DEFAULT_DOCK, ["character", "paragraph"]);
    expect(d.groups[0]).toMatchObject({ tabs: ["character", "paragraph"], active: "character" });
    expect(togglePanels(d, ["character", "paragraph"])).toEqual(DEFAULT_DOCK);
  });
});
