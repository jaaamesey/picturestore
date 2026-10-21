import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectHistory, newDocument, rectOnLayer } from "./helpers";

/** Drags a slider's handle from where it is to a fraction of its track, in small steps like a hand would. */
async function dragSlider(page: Page, slider: Locator, to: number) {
  const range = slider.locator("input[type=range]");
  const box = (await range.boundingBox())!;
  const [min, max, value] = await range.evaluate((el: HTMLInputElement) => [Number(el.min), Number(el.max), Number(el.value)]);
  // The handle (12px) sits at the value's position, inset by half its width at the ends.
  const at = (f: number) => box.x + 6 + f * (box.width - 12);
  const y = box.y + box.height / 2;
  await page.mouse.move(at((value - min) / (max - min)), y);
  await page.mouse.down();
  await page.mouse.move(at(to), y, { steps: 20 });
  await page.mouse.up();
}

const valueOf = (slider: Locator) => slider.locator("input[type=number]").inputValue().then(Number);

test.describe("sliders can be dragged", () => {
  test.beforeEach(async ({ page }) => {
    await newDocument(page, 200, 150);
    await rectOnLayer(page, 0, 0, 200, 150, "ff0000");
  });

  test("in the Properties panel, as one history step", async ({ page }) => {
    await page.getByTestId("new-adjustment").click();
    await page.getByRole("menuitem", { name: "Hue/Saturation…" }).click();
    const hue = page.getByTestId("properties-panel").getByTestId("slider-hue");
    await dragSlider(page, hue, 1);
    expect(await valueOf(hue)).toBe(180);
    await dragSlider(page, hue, 0.25);
    expect(Math.abs((await valueOf(hue)) - -90)).toBeLessThanOrEqual(3);
    await expectHistory(page, "Hue/Saturation");
  });

  test("in an Image ▸ Adjustments dialog", async ({ page }) => {
    await page.keyboard.press("Control+u");
    const sat = page.getByTestId("adjustment-dialog").getByTestId("slider-saturation");
    await dragSlider(page, sat, 0);
    expect(await valueOf(sat)).toBe(-100);
  });

  test("a mask's Density", async ({ page }) => {
    await page.getByTestId("add-mask").click();
    const density = page.getByTestId("mask-properties").getByTestId("slider-density");
    await dragSlider(page, density, 0.5);
    expect(Math.abs((await valueOf(density)) - 50)).toBeLessThanOrEqual(2);
  });

  test("Levels' handles: black, grey (gamma) and white input, and output", async ({ page }) => {
    await page.getByTestId("new-adjustment").click();
    await page.getByRole("menuitem", { name: "Levels…" }).click();
    const panel = page.getByTestId("properties-panel");
    const handles = panel.getByTestId("levels-input").getByTestId("handle");
    const bar = (await panel.getByTestId("levels-input").boundingBox())!;
    const dragHandle = async (i: number, to: number) => {
      const h = (await handles.nth(i).boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(bar.x + (to / 255) * bar.width, h.y + h.height / 2, { steps: 15 });
      await page.mouse.up();
    };
    await dragHandle(0, 64);
    expect(Math.abs(Number(await panel.getByTestId("levels-input-black").inputValue()) - 64)).toBeLessThanOrEqual(2);
    await dragHandle(2, 192);
    expect(Math.abs(Number(await panel.getByTestId("levels-input-white").inputValue()) - 192)).toBeLessThanOrEqual(2);
    // Grey to a quarter of the way between them brightens: gamma 2.
    await dragHandle(1, 64 + (192 - 64) * 0.25);
    expect(Math.abs(Number(await panel.getByTestId("levels-gamma").inputValue()) - 2)).toBeLessThanOrEqual(0.1);
    await expectHistory(page, "Levels");
  });

  test("Curves: a point added by pressing on the graph follows the drag", async ({ page }) => {
    await page.getByTestId("new-adjustment").click();
    await page.getByRole("menuitem", { name: "Curves…" }).click();
    const graph = page.getByTestId("properties-panel").getByTestId("curves-graph");
    const g = (await graph.boundingBox())!;
    const at = (x: number, y: number) => [g.x + (x / 255) * g.width, g.y + (1 - y / 255) * g.height] as const;
    await page.mouse.move(...at(128, 128));
    await page.mouse.down();
    await page.mouse.move(...at(128, 200), { steps: 15 });
    await page.mouse.up();
    const points = await graph.getByTestId("curve-point").evaluateAll((els) => els.map((e) => 255 - (Number(e.getAttribute("y")) + 3)));
    expect(points).toHaveLength(3);
    expect(Math.abs(points[1] - 200)).toBeLessThanOrEqual(3);
    await expectHistory(page, "Curves");
  });
});
