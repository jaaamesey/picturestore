import { expect, test, type Page } from "@playwright/test";
import { click, docPoint, drag, expectHistory, historyLabels, newDocument, screenPixel, settled } from "./helpers";

type TextLike = { kind: string; text?: string; runs?: { length: number; style: { size: number; fauxBold: boolean; underline: boolean } }[]; frame?: { kind: string; width?: number }; transform?: number[] };
type Ed = { active(): { doc(): { width: number; selection: unknown; layers: { name: string; content: TextLike }[] } } };
const layers = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc().layers.map((l) => ({ name: l.name, kind: l.content.kind, text: l.content.text })));
const content = (page: Page, i = 1) => page.evaluate((i) => (window.__ps!.editor as Ed).active().doc().layers[i].content, i);
/** Dark pixels the CPU composite has in a rectangle. */
const ink = (page: Page, x0: number, y0: number, x1: number, y1: number) =>
  page.evaluate(([x0, y0, x1, y1]) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (window.__ps!.pixel!(x, y)[0] < 128) n++;
    return n;
  }, [x0, y0, x1, y1]);
/** The extent of dark pixels in a rectangle. */
const inkBox = (page: Page, x0: number, y0: number, x1: number, y1: number) =>
  page.evaluate(([x0, y0, x1, y1]) => {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        if (window.__ps!.pixel!(x, y)[0] < 128) ((l = Math.min(l, x)), (r = Math.max(r, x)), (t = Math.min(t, y)), (b = Math.max(b, y)));
    return { l, t, r, b };
  }, [x0, y0, x1, y1]);

async function pointType(page: Page, x: number, y: number, text: string) {
  await page.keyboard.press("t");
  await click(page, x, y);
  await expect(page.getByTestId("text-input")).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press("Control+Enter");
  await expectHistory(page, "Type Layer");
}

test.describe("Type tool", () => {
  test("click, type, commit: a type layer named by its text, drawn from the baseline at the click", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    await expect(page.getByTestId("tool-type-horizontal")).toHaveAttribute("aria-pressed", "true");
    await click(page, 40, 100);
    await expect(page.getByTestId("text-editing")).toBeVisible();
    // New type starts with Lorem Ipsum, selected: typing replaces it.
    await expect(page.getByTestId("text-selection")).toHaveCount(1);
    await page.keyboard.type("Hello");
    await expect(page.getByTestId("text-caret")).toHaveCount(1);
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    expect((await layers(page))[1]).toEqual({ name: "Hello", kind: "text", text: "Hello" });
    expect(await ink(page, 40, 85, 120, 100)).toBeGreaterThan(20);
    expect(await ink(page, 40, 101, 120, 115)).toBe(0);
    expect((await screenPixel(page, 41, 93))[0]).toBeLessThan(250);
    // The Layers panel shows Photoshop's T thumbnail.
    await expect(page.locator("[data-layer-name=Hello] [data-type-thumbnail]")).toBeVisible();
  });

  test("a dragged box wraps its text and shows when it overflows; undo removes the layer", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("t");
    await drag(page, [20, 20], [140, 60]);
    // Filled with Lorem Ipsum, which overflows a small box.
    await expect(page.getByTestId("text-overflow")).toBeVisible();
    await page.keyboard.type("one two three four five six");
    await expect(page.getByTestId("text-overflow")).toHaveCount(0);
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    const c = await content(page);
    expect(c.frame).toEqual({ kind: "box", width: 120, height: 40 });
    // Two lines, the second further down.
    const box = await inkBox(page, 15, 15, 200, 80);
    expect(box.b - box.t).toBeGreaterThan(14);
    expect(box.r).toBeLessThanOrEqual(141);
    await page.keyboard.press("Control+z");
    expect(await layers(page)).toHaveLength(1);
  });

  test("clicking type edits it: the caret goes where clicked, a double-click selects a word, typing replaces it", async ({ page }) => {
    await newDocument(page, 400, 200);
    await pointType(page, 40, 100, "Hello world");
    await page.keyboard.press("v");
    await page.keyboard.press("t");
    const p = await docPoint(page, 80, 95);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.getByTestId("text-selection")).toHaveCount(1);
    await page.keyboard.type("there");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Edit Type Layer");
    expect((await layers(page))[1]).toMatchObject({ text: "Hello there", name: "Hello there" });
  });

  test("keyboard: arrows, Shift to select, Ctrl for words, Backspace, Enter for a new paragraph, undo while typing", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    await click(page, 40, 60);
    await page.keyboard.type("one two three");
    await page.keyboard.press("Control+ArrowLeft");
    await page.keyboard.press("Control+Shift+ArrowLeft");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("2 ");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("four");
    // Undo within the session takes back the last typing.
    await page.keyboard.press("Control+z");
    await page.keyboard.type("4");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.type("IV");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    expect((await layers(page))[1].text).toBe("one 2 three\nIV");
  });

  test("Esc commits (by default); clicking away commits too", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    await click(page, 40, 60);
    await page.keyboard.type("Esc");
    await page.keyboard.press("Escape");
    await expectHistory(page, "Type Layer");
    await click(page, 40, 150);
    await page.keyboard.type("Away");
    await click(page, 300, 20);
    await expectHistory(page, "Type Layer");
    expect((await layers(page)).map((l) => l.text)).toEqual([undefined, "Esc", "Away"]);
    expect(await historyLabels(page)).toEqual(["New", "Type Layer", "Type Layer"]);
  });

  test("Photoshop's formatting shortcuts apply to the selection", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    await click(page, 20, 100);
    await page.keyboard.type("Bold big");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+Shift+b");
    await page.keyboard.press("Control+Shift+u");
    // Size up by 2 pt, twice; with Alt by 10.
    await page.keyboard.press("Control+Shift+Period");
    await page.keyboard.press("Control+Shift+Period");
    await page.keyboard.press("Control+Alt+Shift+Period");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    const c = await content(page);
    expect(c.runs![0].style).toMatchObject({ fauxBold: true, underline: true, size: 26 });
  });

  test("Alt-click asks for a paragraph box's size", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    const p = await docPoint(page, 30, 30);
    await page.keyboard.down("Alt");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Alt");
    await expect(page.getByTestId("paragraph-size")).toBeVisible();
    await page.getByTestId("paragraph-width").fill("150 px");
    await page.getByTestId("paragraph-height").fill("50 px");
    await page.getByTestId("paragraph-size-ok").click();
    await expect(page.getByTestId("text-editing")).toBeVisible();
    await page.keyboard.type("Sized");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    expect((await content(page)).frame).toEqual({ kind: "box", width: 150, height: 50 });
  });

  test("type left empty isn't kept", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    await click(page, 40, 60);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Control+Enter");
    await settled(page);
    expect(await layers(page)).toHaveLength(1);
    expect(await historyLabels(page)).toEqual(["New"]);
  });

  test("the Type Mask tool makes a selection in the shape of the type", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    // Shift+T cycles through the group: Vertical Type, Vertical Type Mask, Horizontal Type Mask.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+t");
    await expect(page.getByTestId("tool-type-mask-horizontal")).toHaveAttribute("aria-pressed", "true");
    await click(page, 40, 120);
    await expect(page.getByTestId("type-mask-overlay")).toBeVisible();
    await page.keyboard.type("MASK");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Mask");
    expect(await layers(page)).toHaveLength(1);
    const sel = await page.evaluate(() => {
      const d = (window.__ps!.editor as Ed).active().doc() as unknown as { selection: { bounds: { x: number; y: number; w: number; h: number } } | null };
      return d.selection?.bounds ?? null;
    });
    expect(sel).not.toBeNull();
    expect(sel!.x).toBeGreaterThanOrEqual(39);
    expect(sel!.y + sel!.h).toBeLessThanOrEqual(122);
  });

  test("Image Size scales type as type: sharp, the same text, a scaled transform", async ({ page }) => {
    await newDocument(page, 300, 150);
    await pointType(page, 20, 80, "Scale");
    const before = await inkBox(page, 0, 40, 300, 100);
    await page.keyboard.press("Alt+Control+i");
    await page.getByTestId("image-size-width").fill("600");
    await page.getByTestId("image-size-width").press("Tab");
    await page.getByTestId("image-size-ok").click();
    await expectHistory(page, "Image Size");
    const c = await content(page);
    expect(c.kind).toBe("text");
    expect(c.runs![0].style.size).toBe(12);
    expect(c.transform![0]).toBeCloseTo(2, 5);
    const after = await inkBox(page, 0, 80, 600, 200);
    expect(after.r - after.l).toBeGreaterThanOrEqual((before.r - before.l) * 2 - 3);
    expect(after.r - after.l).toBeLessThanOrEqual((before.r - before.l) * 2 + 3);
  });

  test("Free Transform scales type exactly; Ctrl on a corner doesn't distort it", async ({ page }) => {
    await newDocument(page, 400, 200);
    await pointType(page, 40, 100, "Transform");
    await page.keyboard.press("v");
    await page.keyboard.press("Control+t");
    await expect(page.getByTestId("transform-box")).toBeVisible();
    // Ctrl-drag a corner: Distort elsewhere, plain scaling on type.
    const c0 = await content(page);
    const corner = await page.evaluate(() => {
      const el = document.querySelector("[data-testid=transform-box] polygon")!;
      const [x, y] = el.getAttribute("points")!.split(" ")[2].split(",").map(Number);
      const r = document.querySelector("[data-testid=viewport]")!.getBoundingClientRect();
      return { x: x + r.left, y: y + r.top };
    });
    await page.mouse.move(corner.x, corner.y);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(corner.x + 40, corner.y + 10, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await page.keyboard.press("Enter");
    await expectHistory(page, "Free Transform");
    const c1 = await content(page);
    expect(c1.kind).toBe("text");
    // Still an affine map with the same text: wider, and no perspective possible.
    expect(c1.transform!.length).toBe(6);
    expect(c1.transform![0]).toBeGreaterThan(c0.transform![0]);
    expect(c1.text).toBe("Transform");
  });

  test("double-clicking a type layer's thumbnail selects all its text for editing", async ({ page }) => {
    await newDocument(page, 400, 200);
    await pointType(page, 40, 100, "Thumb");
    await page.keyboard.press("m");
    await page.locator("[data-layer-name=Thumb] [data-type-thumbnail]").dblclick();
    await expect(page.getByTestId("tool-type-horizontal")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("text-selection")).toHaveCount(1);
    await page.keyboard.type("Nail");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Edit Type Layer");
    expect((await layers(page))[1].text).toBe("Nail");
  });

  test("smart quotes, and copying and pasting styled type", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    await click(page, 20, 100);
    await page.keyboard.type(`"Hi," it's`);
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.keyboard.press("Control+Shift+b");
    await page.keyboard.press("Control+c");
    await page.keyboard.press("End");
    await page.keyboard.press("Control+v");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    const c = await content(page);
    expect(c.text).toBe("“Hi,” it’s“Hi,” it’s");
    expect(c.runs!.every((r) => r.style.fauxBold)).toBe(true);
  });
});

test.describe("Type and shapes", () => {
  /** The active layer's content (new type goes above the active layer). */
  const activeContent = (page: Page) =>
    page.evaluate(() => {
      const d = (window.__ps!.editor as { active(): { doc(): { activeLayerId: string; layers: { id: string; content: { kind: string; frame?: { kind: string; start?: number } } }[] } } }).active().doc();
      return d.layers.find((l) => l.id === d.activeLayerId)!.content;
    });

  test("clicking inside a shape with a Type tool fills it with area type; on its outline, type runs along it", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("u");
    // The Ellipse tool (U cycles the shape tools: rectangle, ellipse…).
    await page.keyboard.press("Shift+u");
    await drag(page, [100, 50], [300, 250]);
    await expectHistory(page, "Ellipse Tool");
    // Inside: area type, filled with Lorem Ipsum, which stays inside the ellipse.
    await page.keyboard.press("t");
    await click(page, 200, 150);
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    expect((await activeContent(page)).frame!.kind).toBe("area");
    // With the (black) ellipse hidden: type inside it, none in its bounding box's corners.
    const shapeRow = page.getByTestId("layer-row").filter({ hasNotText: "Lorem" }).filter({ hasNotText: "Background" });
    await shapeRow.getByTestId("layer-visibility").click();
    await settled(page);
    expect(await ink(page, 150, 100, 250, 200)).toBeGreaterThan(50);
    expect(await ink(page, 100, 50, 125, 75)).toBe(0);
    expect(await ink(page, 275, 225, 300, 250)).toBe(0);
    await shapeRow.getByTestId("layer-visibility").click();

    // On the outline (the ellipse's right): type on a path, from where it was clicked.
    await shapeRow.click();
    await page.keyboard.press("t");
    await click(page, 300, 150);
    await page.keyboard.type("Along the path");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    const along = await activeContent(page);
    expect(along.frame!.kind).toBe("path");
    // A quarter of the way round (the ellipse's path starts at its top), give or take.
    const perimeter = Math.PI * 200;
    expect(along.frame!.start! / perimeter).toBeGreaterThan(0.2);
    expect(along.frame!.start! / perimeter).toBeLessThan(0.3);
    // Drawn along the outline: ink near the ellipse's right edge, below the click.
    await settled(page);
    expect(await ink(page, 270, 150, 310, 220)).toBeGreaterThan(20);
  });
});
