import { describe, expect, it } from "vitest";
import { findCommand, formatShortcut, matchShortcut, stepBrushSize, toolForKey, type KeyLike } from "./commands";

const key = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("shortcuts", () => {
  it("matches modifiers exactly", () => {
    expect(matchShortcut("Mod+Z", key("z", { ctrlKey: true }))).toBe(true);
    expect(matchShortcut("Mod+Z", key("z", { metaKey: true }))).toBe(true);
    expect(matchShortcut("Mod+Z", key("z", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchShortcut("Mod+Z", key("z"))).toBe(false);
  });

  it("matches letters by physical key (macOS Alt changes `key`)", () => {
    expect(matchShortcut("Alt+Mod+T", { ...key("†", { altKey: true, metaKey: true }), code: "KeyT" })).toBe(true);
  });

  it("treats = and + as the same key", () => {
    expect(matchShortcut("Mod+=", key("+", { ctrlKey: true, shiftKey: false }))).toBe(true);
  });

  it("finds commands", () => {
    expect(findCommand(key("z", { ctrlKey: true, shiftKey: true }))?.id).toBe("edit.redo");
    expect(findCommand(key("Backspace", { altKey: true }))?.id).toBe("edit.fillForeground");
    expect(findCommand(key("Delete"))?.id).toBe("edit.clear");
    expect(findCommand(key("q"))).toBeUndefined();
  });

  it("formats per platform", () => {
    expect(formatShortcut("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(formatShortcut("Mod+Shift+Z", true)).toBe("⌘⇧Z");
  });
});

describe("tool keys", () => {
  it("selects, keeps, and cycles tool groups", () => {
    expect(toolForKey("b", "move", false)).toBe("brush");
    expect(toolForKey("m", "brush", false)).toBe("marquee-rect");
    expect(toolForKey("m", "marquee-ellipse", false)).toBe("marquee-ellipse");
    expect(toolForKey("M", "marquee-rect", true)).toBe("marquee-ellipse");
    expect(toolForKey("m", "marquee-ellipse", true)).toBe("marquee-rect");
    expect(toolForKey("q", "brush", false)).toBeNull();
  });
});

it("steps brush sizes like Photoshop", () => {
  expect(stepBrushSize(5, 1)).toBe(6);
  expect(stepBrushSize(20, 1)).toBe(25);
  expect(stepBrushSize(20, -1)).toBe(15);
  expect(stepBrushSize(1, -1)).toBe(1);
  expect(stepBrushSize(200, 1)).toBe(225);
});
