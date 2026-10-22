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

  /** Presses on a row and drags it (in steps, as a hand would) to a point down `at` (0–1) another row's height; `during` runs before the release. */
  async function dragRow(page: Page, name: string, onto: string, at: number, during?: () => Promise<void>) {
    // Rows animate into place: measure once they've settled.
    await expect.poll(() => rows(page).evaluateAll((els) => els.flatMap((e) => e.getAnimations()).length)).toBe(0);
    const from = (await row(page, name).boundingBox())!, to = (await row(page, onto).boundingBox())!;
    await page.mouse.move(from.x + 150, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 150, to.y + to.height * at, { steps: 12 });
    await during?.();
    await page.mouse.up();
  }

  /** Layer 3, Group 1 (holding Layer 2), Layer 1, Background. */
  async function groupInMiddle(page: Page) {
    await rectOnLayer(page, 20, 20, 40, 40);
    await rectOnLayer(page, 60, 20, 80, 40);
    await rectOnLayer(page, 100, 20, 120, 40);
    await row(page, "Layer 2").click();
    await page.keyboard.press("Control+g");
    expect(await names(page)).toEqual(["Layer 3", "Group 1", "  Layer 2", "Layer 1", "Background"]);
  }

  test("dropped on a collapsed group's folder, from above or below, a layer goes in at the bottom", async ({ page }) => {
    await groupInMiddle(page);
    await row(page, "Group 1").getByTestId("group-toggle").click();
    expect(await names(page)).toEqual(["Layer 3", "Group 1", "Layer 1", "Background"]);
    // From below: the group is outlined while over it.
    await dragRow(page, "Layer 1", "Group 1", 0.5, async () => {
      await expect(row(page, "Group 1")).toHaveAttribute("data-drop", "inside-bottom");
    });
    await expectHistory(page, "Layer Order");
    await expect(row(page, "Group 1")).not.toHaveAttribute("data-drop");
    expect(await names(page)).toEqual(["Layer 3", "Group 1", "Background"]);
    // From above.
    await dragRow(page, "Layer 3", "Group 1", 0.5);
    expect(await names(page)).toEqual(["Group 1", "Background"]);
    await row(page, "Group 1").getByTestId("group-toggle").click();
    expect(await names(page)).toEqual(["Group 1", "  Layer 2", "  Layer 1", "  Layer 3", "Background"]);
    // Still drawn: what was in front is in front.
    expect(await cpuPixel(page, 30, 30)).toEqual(BLACK);
  });

  test("an open group: the middle of its row drops in at the bottom, just under its header at the top", async ({ page }) => {
    await groupInMiddle(page);
    // From above, onto the middle: in at the bottom.
    await dragRow(page, "Layer 3", "Group 1", 0.5, async () => {
      await expect(row(page, "Group 1")).toHaveAttribute("data-drop", "inside-bottom");
    });
    expect(await names(page)).toEqual(["Group 1", "  Layer 2", "  Layer 3", "Layer 1", "Background"]);
    // From below, onto the header's lower edge: in at the top, marked by a line under the header.
    await dragRow(page, "Layer 1", "Group 1", 0.9, async () => {
      await expect(row(page, "Group 1")).toHaveAttribute("data-drop", "inside");
    });
    expect(await names(page)).toEqual(["Group 1", "  Layer 1", "  Layer 2", "  Layer 3", "Background"]);
    // Onto its top edge: above it, outside.
    await dragRow(page, "Layer 2", "Group 1", 0.1, async () => {
      await expect(row(page, "Group 1")).toHaveAttribute("data-drop", "above");
    });
    expect(await names(page)).toEqual(["Layer 2", "Group 1", "  Layer 1", "  Layer 3", "Background"]);
  });

  test("dragging a layer out of a group, and a group with everything in it", async ({ page }) => {
    await groupInMiddle(page);
    // Out: onto the lower half of the layer below the group.
    await dragRow(page, "Layer 2", "Layer 1", 0.75);
    expect(await names(page)).toEqual(["Layer 3", "Group 1", "Layer 1", "Layer 2", "Background"]);
    await page.keyboard.press("Control+z");
    expect(await names(page)).toEqual(["Layer 3", "Group 1", "  Layer 2", "Layer 1", "Background"]);
    // A group's contents lift and move with it.
    await dragRow(page, "Group 1", "Layer 3", 0.25, async () => {
      await expect(row(page, "Layer 2")).toHaveAttribute("data-dragging", "");
    });
    expect(await names(page)).toEqual(["Group 1", "  Layer 2", "Layer 3", "Layer 1", "Background"]);
    // Dropped back where it started: nothing changes, nothing is recorded.
    const steps = await page.getByTestId("history-entry").count();
    await dragRow(page, "Layer 3", "Layer 3", 0.5);
    await page.mouse.move(0, 0);
    expect(await names(page)).toEqual(["Group 1", "  Layer 2", "Layer 3", "Layer 1", "Background"]);
    await expect(page.getByTestId("history-entry")).toHaveCount(steps);
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
