import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { click, expectHistory, newDocument } from "./helpers";

const THIN = new URL(import.meta.resolve("@expo-google-fonts/noto-sans-arabic/100Thin/NotoSansArabic_100Thin.ttf"));

async function chooseFromTypeMenu(page: Page, command: string) {
  await page.getByRole("menuitem", { name: "Type", exact: true }).click();
  await page.locator(`[data-command='${command}']`).click();
}

test("uploaded fonts are kept in the browser: added from the Type menu, used, still there after a reload, removable", async ({ page }) => {
  await newDocument(page, 400, 200);
  const chooser = page.waitForEvent("filechooser");
  await chooseFromTypeMenu(page, "type.addFonts");
  await (await chooser).setFiles([
    { name: "NotoSansArabic_100Thin.ttf", mimeType: "font/ttf", buffer: readFileSync(THIN) },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a font") },
  ]);
  // One added; the other explained.
  await expect(page.getByRole("status")).toContainText("Added Noto Sans Arabic.");
  await expect(page.getByRole("status")).toContainText("notes.txt");

  // In the font menus: its family gains the Thin style.
  await page.keyboard.press("t");
  await page.getByTestId("type-font-family").fill("noto");
  await page.getByTestId("type-font-family").press("Enter");
  await page.getByTestId("type-font-style").selectOption("Thin");
  await click(page, 40, 100);
  await page.keyboard.type("Thin");
  await page.keyboard.press("Control+Enter");
  await expectHistory(page, "Type Layer");
  const font = () => page.evaluate(() => (window.__ps!.editor as { active(): { doc(): { layers: { content: { runs: { style: { font: { postScriptName: string } } }[] } }[] } } }).active().doc().layers[1].content.runs[0].style.font.postScriptName);
  expect(await font()).toBe("NotoSansArabic-Thin");

  // Kept: after a reload it's listed, and a new document can use it.
  await page.reload();
  await page.getByTestId("start-new").click();
  await page.getByTestId("new-create").click();
  await chooseFromTypeMenu(page, "type.manageFonts");
  await expect(page.getByTestId("added-font")).toHaveCount(1);
  await expect(page.getByTestId("added-font")).toHaveAttribute("data-font-file", "NotoSansArabic_100Thin.ttf");
  await page.getByTestId("remove-font").click();
  await expect(page.getByTestId("added-font")).toHaveCount(0);
  await page.getByTestId("fonts-done").click();
  await page.reload();
  await page.getByTestId("start-new").click();
  await page.getByTestId("new-create").click();
  await chooseFromTypeMenu(page, "type.manageFonts");
  await expect(page.getByTestId("added-font")).toHaveCount(0);
});

test("type in a font that isn't available shows it in brackets with a warning, and can be replaced", async ({ page }) => {
  await newDocument(page, 400, 200);
  const chooser = page.waitForEvent("filechooser");
  await chooseFromTypeMenu(page, "type.addFonts");
  await (await chooser).setFiles([{ name: "thin.ttf", mimeType: "font/ttf", buffer: readFileSync(THIN) }]);
  await expect(page.getByRole("status")).toContainText("Added");
  await page.keyboard.press("t");
  await page.getByTestId("type-font-family").fill("noto");
  await page.getByTestId("type-font-family").press("Enter");
  await page.getByTestId("type-font-style").selectOption("Thin");
  await click(page, 40, 100);
  await page.keyboard.type("Gone");
  await page.keyboard.press("Control+Enter");
  await expectHistory(page, "Type Layer");
  // Removed while in use: missing.
  await chooseFromTypeMenu(page, "type.manageFonts");
  await page.getByTestId("remove-font").click();
  await page.getByTestId("fonts-done").click();
  await expect(page.getByTestId("type-font-style")).toHaveValue("");
  await expect(page.getByTestId("type-font-family-missing")).toBeVisible();
  await expect(page.getByTestId("type-font-family")).toHaveValue("[Noto Sans Arabic]");
  await chooseFromTypeMenu(page, "type.replaceMissing");
  await expectHistory(page, "Replace All Missing Fonts");
  await expect(page.getByTestId("type-font-family")).toHaveValue("Source Sans 3");
});
