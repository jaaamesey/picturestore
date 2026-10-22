import { expect, test, type Page } from "@playwright/test";
import { click, expectHistory, newDocument, settled } from "./helpers";

type TextLike = { kind: string; text: string; antiAlias: string; warp: { style: string; bend: number } | null; frame: { kind: string }; runs: { length: number; style: { size: number; tracking: number; font: { family: string; style: string } } }[]; paragraphs: { style: { align: string } }[] };
const content = (page: Page, i = 1) =>
  page.evaluate((i) => (window.__ps!.editor as { active(): { doc(): { layers: { content: TextLike }[] } } }).active().doc().layers[i].content, i);

async function pointType(page: Page, text: string) {
  await page.keyboard.press("t");
  await click(page, 40, 100);
  await page.keyboard.type(text);
  await page.keyboard.press("Control+Enter");
  await expectHistory(page, "Type Layer");
}

test.describe("Type panels, options bar and Type menu", () => {
  test("the options bar's panel button opens Character and Paragraph; their fields format the active type layer", async ({ page }) => {
    await newDocument(page, 400, 200);
    await pointType(page, "Panels");
    await page.getByTestId("type-panels").click();
    await expect(page.getByTestId("panel-tab-character")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("panel-tab-paragraph")).toBeVisible();
    // Size shows in points (72 ppi: 12 px = 12 pt).
    await expect(page.getByTestId("char-size")).toHaveValue("12 pt");
    await page.getByTestId("char-size").fill("30");
    await page.getByTestId("char-size").press("Enter");
    await expectHistory(page, "Edit Type Layer");
    await page.getByTestId("char-tracking").fill("100");
    await page.getByTestId("char-tracking").press("Enter");
    await page.getByTestId("char-font-style").selectOption("Bold");
    await settled(page);
    const c = await content(page);
    expect(c.runs[0].style).toMatchObject({ size: 30, tracking: 100, font: { family: "Source Sans 3", style: "Bold" } });
    // Paragraph: centred.
    await page.getByTestId("panel-tab-paragraph").click();
    await page.getByTestId("para-align-center").click();
    await settled(page);
    expect((await content(page)).paragraphs[0].style.align).toBe("center");
    // Window menu: Character is checked; choosing it closes it.
    await page.getByRole("menuitem", { name: "Window" }).click();
    await expect(page.locator("[data-command='window.paragraph']")).toHaveAttribute("aria-checked", "true");
    await page.locator("[data-command='window.paragraph']").click();
    await expect(page.getByTestId("panel-tab-paragraph")).toHaveCount(0);
  });

  test("the font family menu finds a family as it's typed", async ({ page }) => {
    await newDocument(page, 400, 200);
    await page.keyboard.press("t");
    await page.getByTestId("type-font-family").click();
    await page.getByTestId("type-font-family").fill("serif");
    await expect(page.getByTestId("type-font-family-list").locator("[data-family]").first()).toHaveAttribute("data-family", "Source Serif 4");
    await page.getByTestId("type-font-family").press("Enter");
    await expect(page.getByTestId("type-font-family")).toHaveValue("Source Serif 4");
    await click(page, 40, 100);
    await page.keyboard.type("Serif");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    expect((await content(page)).runs[0].style.font.family).toBe("Source Serif 4");
  });

  test("Type menu: anti-aliasing, Convert to Paragraph Text, Warp Text with a live preview, Convert to Shape", async ({ page }) => {
    await newDocument(page, 400, 200);
    await pointType(page, "Menu");
    const menu = async (path: string[], command: string) => {
      await page.getByRole("menuitem", { name: "Type", exact: true }).click();
      for (const p of path) await page.getByRole("menuitem", { name: p }).hover();
      await page.locator(`[data-command='${command}']`).click();
    };
    await menu(["Anti-Alias"], "type.antiAlias.smooth");
    await expectHistory(page, "Anti-Alias");
    expect((await content(page)).antiAlias).toBe("smooth");
    await menu([], "type.convertShapeType");
    await expectHistory(page, "Convert to Paragraph Text");
    expect((await content(page)).frame.kind).toBe("box");

    await menu([], "type.warp");
    await expect(page.getByTestId("warp-text")).toBeVisible();
    await page.getByTestId("warp-style").selectOption("arc");
    await page.getByTestId("warp-ok").click();
    await expectHistory(page, "Warp Text");
    expect((await content(page)).warp).toMatchObject({ style: "arc", bend: 0.5 });

    await menu([], "type.convertToShape");
    await expectHistory(page, "Convert to Shape");
    expect((await content(page)).kind).toBe("shape");
  });
});
