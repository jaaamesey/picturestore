import { expect, test, type Page } from "@playwright/test";
import { click, expectHistory, newDocument, settled } from "./helpers";

type Run = { length: number; styleId: string | null; style: { fauxBold: boolean; underline: boolean; size: number } };
type Ed = { active(): { doc(): { layers: { content: { text: string; runs: Run[]; paragraphs: { styleId: string | null; style: { align: string } }[] } }[]; textStyles?: { character: { id: string; name: string }[]; paragraph: { id: string; name: string }[] } } } };
const doc = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc());

async function typeLayer(page: Page, x: number, y: number, text: string) {
  await page.keyboard.press("t");
  await click(page, x, y);
  await page.keyboard.type(text);
  await page.keyboard.press("Control+Enter");
  await expectHistory(page, "Type Layer");
}

test("character styles: made from formatted text, applied elsewhere, overridden, redefined everywhere, renamed and deleted", async ({ page }) => {
  await newDocument(page, 400, 300);
  // Format some type, then make a style from it.
  await page.keyboard.press("t");
  await click(page, 30, 60);
  await page.keyboard.type("Styled");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+Shift+b");
  await page.getByRole("menuitem", { name: "Window" }).click();
  await page.locator("[data-command='window.characterStyles']").click();
  await page.getByTestId("character-style-new").click();
  await expectHistory(page, "New Character Style");
  const styles = page.getByTestId("character-styles");
  await expect(styles.locator("[data-style='Character Style 1']")).toBeVisible();
  // Apply it to the selected text, then to a second layer.
  await page.keyboard.press("t");
  await click(page, 50, 60);
  await page.keyboard.press("Control+a");
  await styles.locator("[data-style='Character Style 1']").click();
  await page.keyboard.press("Control+Enter");
  await typeLayer(page, 30, 150, "Plain");
  await styles.locator("[data-style='Character Style 1']").click();
  await expectHistory(page, "Apply Character Style");
  let d = await doc(page);
  const id = d.textStyles!.character[0].id;
  expect(d.layers[2].content.runs[0]).toMatchObject({ styleId: id, style: { fauxBold: true } });
  await expect(styles.locator("[data-style='Character Style 1']")).toHaveAttribute("aria-selected", "true");

  // Override it on the second layer (underline): "+"; Redefine merges the override into the style, and the first layer follows.
  await page.keyboard.press("t");
  await click(page, 50, 150);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+Shift+u");
  await expect(styles.locator("[data-style='Character Style 1']")).toContainText("Character Style 1+");
  await page.getByTestId("character-style-redefine").click();
  await expectHistory(page, "Redefine Character Style");
  d = await doc(page);
  expect(d.layers[1].content.runs[0].style).toMatchObject({ fauxBold: true, underline: true });

  // Rename by double-click; delete: the text keeps its formatting, with no style.
  await styles.locator("[data-style='Character Style 1']").dblclick();
  await page.getByTestId("style-rename").fill("Strong");
  await page.getByTestId("style-rename").press("Enter");
  await expect(styles.locator("[data-style='Strong']")).toBeVisible();
  await page.getByTestId("character-style-delete").click();
  await expectHistory(page, "Delete Character Style");
  d = await doc(page);
  expect(d.textStyles!.character).toEqual([]);
  expect(d.layers[1].content.runs[0]).toMatchObject({ styleId: null, style: { fauxBold: true, underline: true } });
});

test("paragraph styles, and default type styles that new documents start with", async ({ page }) => {
  await newDocument(page, 400, 300);
  await page.keyboard.press("t");
  await click(page, 200, 60);
  await page.keyboard.type("Centred");
  await page.getByTestId("type-align-center").click();
  await page.keyboard.press("Control+Enter");
  await expectHistory(page, "Type Layer");
  await page.getByRole("menuitem", { name: "Window" }).click();
  await page.locator("[data-command='window.paragraphStyles']").click();
  await page.getByTestId("paragraph-style-new").click();
  await expectHistory(page, "New Paragraph Style");
  await typeLayer(page, 30, 150, "Left");
  await page.getByTestId("paragraph-styles").locator("[data-style='Paragraph Style 1']").click();
  await expectHistory(page, "Apply Paragraph Style");
  expect((await doc(page)).layers[2].content.paragraphs[0].style.align).toBe("center");

  // Saved as defaults: a new document has them.
  await page.getByRole("menuitem", { name: "Type", exact: true }).click();
  await page.locator("[data-command='type.saveDefaultStyles']").click();
  await page.keyboard.press("Alt+Control+n");
  await page.getByTestId("new-create").click();
  await expect(page.getByTestId("doc-tab")).toHaveCount(2);
  await settled(page);
  expect((await doc(page)).textStyles!.paragraph.map((s) => s.name)).toEqual(["Paragraph Style 1"]);
});
