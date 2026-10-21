import { expect, test, type Page } from "@playwright/test";
import { BLACK, cpuPixel, drag, expectClose, expectHistory, gpuPixels, newDocument, rectOnLayer, settled } from "./helpers";

const rows = (page: Page) => page.getByTestId("layer-row");
const row = (page: Page, name: string) => page.locator(`[data-testid=layer-row][data-layer-name="${name}"]`);
const names = async (page: Page) => (await rows(page).evaluateAll((els) => els.map((e) => `${"  ".repeat(Number((e as HTMLElement).dataset.depth))}${(e as HTMLElement).dataset.layerName}${(e as HTMLElement).dataset.clipped === undefined ? "" : "*"}`)));

test.describe("Layers panel: groups, clipping, masks, adjustments", () => {
  test.beforeEach(({ page }) => newDocument(page, 200, 150));

  test("Ctrl+G groups the active layer; groups nest, collapse, and Shift+Ctrl+G ungroups", async ({ page }) => {
    await rectOnLayer(page, 20, 20, 80, 80);
    await page.keyboard.press("Control+g");
    await expectHistory(page, "Group Layers");
    expect(await names(page)).toEqual(["Group 1", "  Layer 1", "Background"]);
    await expect(page.getByTestId("blend-mode")).toHaveValue("pass through");
    // Nest: group the group.
    await page.keyboard.press("Control+g");
    expect(await names(page)).toEqual(["Group 2", "  Group 1", "    Layer 1", "Background"]);
    await row(page, "Group 2").getByTestId("group-toggle").click();
    expect(await names(page)).toEqual(["Group 2", "Background"]);
    await row(page, "Group 2").getByTestId("group-toggle").click();
    await page.keyboard.press("Shift+Control+g");
    expect(await names(page)).toEqual(["Group 1", "  Layer 1", "Background"]);
    // The layer still renders the same, grouped or not.
    expect(await cpuPixel(page, 50, 50)).toEqual(BLACK);
  });

  test("deleting a group asks whether to keep its contents", async ({ page }) => {
    await rectOnLayer(page, 20, 20, 80, 80);
    await page.keyboard.press("Control+g");
    await page.getByTestId("delete-layer").click();
    await page.getByTestId("choice-1").click(); // Group Only
    expect(await names(page)).toEqual(["Layer 1", "Background"]);
    await page.keyboard.press("Control+z");
    await page.getByTestId("delete-layer").click();
    await page.getByTestId("choice-0").click(); // Group and Contents
    expect(await names(page)).toEqual(["Background"]);
  });

  test("Alt-click clips a layer to the one below; Alt+Ctrl+G toggles it", async ({ page }) => {
    await rectOnLayer(page, 20, 20, 80, 80); // black base
    await rectOnLayer(page, 0, 0, 200, 150, "ff0000"); // red, everywhere
    expect(await cpuPixel(page, 150, 120)).toEqual([255, 0, 0, 255]);
    await row(page, "Layer 2").click({ modifiers: ["Alt"] });
    expect(await names(page)).toEqual(["Layer 2*", "Layer 1", "Background"]);
    await expect(row(page, "Layer 2").getByTestId("clip-indicator")).toBeVisible();
    // Shown only where the base is.
    expect(await cpuPixel(page, 150, 120)).toEqual([255, 255, 255, 255]);
    expect(await cpuPixel(page, 50, 50)).toEqual([255, 0, 0, 255]);
    const [inside, outside] = await gpuPixels(page, [[50, 50], [150, 120]]);
    expectClose(inside, [255, 0, 0, 255]);
    expectClose(outside, [255, 255, 255, 255]);
    await page.keyboard.press("Alt+Control+g");
    expect(await names(page)).toEqual(["Layer 2", "Layer 1", "Background"]);
  });

  test("a layer mask hides what's painted black on it; the eraser paints it back", async ({ page }) => {
    await rectOnLayer(page, 0, 0, 200, 150, "ff0000");
    await page.getByTestId("add-mask").click();
    await expectHistory(page, "Add Layer Mask");
    await expect(row(page, "Layer 1").getByTestId("mask-thumbnail")).toBeVisible();
    // The mask is the target: D gives white on black there; X swaps, so the brush paints black, hiding the layer.
    await page.keyboard.press("d");
    await page.keyboard.press("x");
    await page.keyboard.press("b");
    await drag(page, [40, 75], [160, 75], 20);
    await expectHistory(page, "Brush Tool");
    expect(await cpuPixel(page, 100, 75)).toEqual([255, 255, 255, 255]);
    expect(await cpuPixel(page, 100, 20)).toEqual([255, 0, 0, 255]);
    expectClose((await gpuPixels(page, [[100, 75]]))[0], [255, 255, 255, 255]);
    // The eraser paints the background colour (now white): revealing again.
    await page.keyboard.press("e");
    await drag(page, [40, 75], [160, 75], 20);
    await expectHistory(page, "Eraser");
    expect(await cpuPixel(page, 100, 75)).toEqual([255, 0, 0, 255]);
    // Shift-click disables it.
    await page.keyboard.press("b");
    await drag(page, [40, 75], [160, 75], 20);
    await row(page, "Layer 1").getByTestId("mask-thumbnail").click({ modifiers: ["Shift"] });
    expect(await cpuPixel(page, 100, 75)).toEqual([255, 0, 0, 255]);
  });

  test("a mask made from the selection reveals just the selection", async ({ page }) => {
    await rectOnLayer(page, 0, 0, 200, 150, "00ff00");
    await page.keyboard.press("m");
    await drag(page, [50, 50], [100, 100]);
    await page.getByTestId("add-mask").click();
    expect(await cpuPixel(page, 75, 75)).toEqual([0, 255, 0, 255]);
    expect(await cpuPixel(page, 150, 120)).toEqual([255, 255, 255, 255]);
  });

  test("adjustment layers: added from the panel, edited in Properties, rendered on the GPU", async ({ page }) => {
    await rectOnLayer(page, 0, 0, 200, 150, "ff0000");
    await page.getByTestId("new-adjustment").click();
    await page.getByRole("menuitem", { name: "Invert…" }).click();
    await expectHistory(page, "New Invert Layer");
    expect(await names(page)).toEqual(["Invert 1", "Layer 1", "Background"]);
    expect(await cpuPixel(page, 100, 75)).toEqual([0, 255, 255, 255]);
    expectClose((await gpuPixels(page, [[100, 75]]))[0], [0, 255, 255, 255]);

    await page.getByTestId("new-adjustment").click();
    await page.getByRole("menuitem", { name: "Hue/Saturation…" }).click();
    await expect(page.getByTestId("adjustment-editor")).toHaveAttribute("data-kind", "hue-saturation");
    const sat = page.getByTestId("slider-saturation").locator("input[type=number]");
    await sat.fill("-100");
    await sat.press("Enter");
    await expectHistory(page, "Hue/Saturation");
    const [r, g, b] = await cpuPixel(page, 100, 75);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expectClose((await gpuPixels(page, [[100, 75]]))[0], await cpuPixel(page, 100, 75));
  });

  test("Image ▸ Adjustments: previews live, applies on OK, as one step", async ({ page }) => {
    await rectOnLayer(page, 0, 0, 200, 150, "804020");
    await page.keyboard.press("Control+l");
    await expect(page.getByTestId("adjustment-dialog")).toBeVisible();
    await expect(page.getByTestId("histogram")).toBeVisible();
    const white = page.getByTestId("levels-input-white");
    await white.fill("128");
    await white.press("Enter");
    await settled(page);
    // The preview shows on the GPU before anything is committed.
    expectClose((await gpuPixels(page, [[100, 75]]))[0], [255, 128, 64, 255], 3);
    await page.getByTestId("adjustment-ok").click();
    await expectHistory(page, "Levels");
    expectClose(await cpuPixel(page, 100, 75), [255, 128, 64, 255], 1);
    // Ctrl+I inverts straight away.
    await page.keyboard.press("Control+i");
    await expectHistory(page, "Invert");
    expectClose(await cpuPixel(page, 100, 75), [0, 127, 191, 255], 1);
    // Cancel leaves it as it was.
    await page.keyboard.press("Control+u");
    await page.getByTestId("slider-hue").locator("input[type=number]").fill("90");
    await page.getByTestId("slider-hue").locator("input[type=number]").press("Enter");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("adjustment-dialog")).toHaveCount(0);
    await settled(page);
    expectClose((await gpuPixels(page, [[100, 75]]))[0], [0, 127, 191, 255], 2);
  });

  test("dragging a layer down onto an open group's row puts it in the group", async ({ page }) => {
    await rectOnLayer(page, 20, 20, 80, 80);
    await rectOnLayer(page, 100, 20, 160, 80);
    await row(page, "Layer 1").click();
    await page.keyboard.press("Control+g");
    expect(await names(page)).toEqual(["Layer 2", "Group 1", "  Layer 1", "Background"]);
    const from = (await row(page, "Layer 2").boundingBox())!, to = (await row(page, "Group 1").boundingBox())!;
    await page.mouse.move(from.x + 150, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 150, to.y + to.height * 0.9, { steps: 10 });
    await page.mouse.up();
    await expectHistory(page, "Layer Order");
    expect(await names(page)).toEqual(["Group 1", "  Layer 2", "  Layer 1", "Background"]);
  });

  test("moving a group moves everything in it", async ({ page }) => {
    await rectOnLayer(page, 20, 20, 40, 40);
    await rectOnLayer(page, 60, 20, 80, 40, "ff0000");
    await page.keyboard.press("Control+g");
    await page.keyboard.press("v");
    await drag(page, [30, 30], [80, 80]);
    await expectHistory(page, "Move");
    expect(await cpuPixel(page, 30, 30)).toEqual([0, 0, 0, 255]); // Layer 1 isn't in the group
    expect(await cpuPixel(page, 70, 30)).toEqual([255, 255, 255, 255]);
    expect(await cpuPixel(page, 120, 80)).toEqual([255, 0, 0, 255]);
    expectClose((await gpuPixels(page, [[120, 80]]))[0], [255, 0, 0, 255]);
  });
});
