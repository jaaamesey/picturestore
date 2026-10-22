import { expect, test, type Page } from "@playwright/test";
import { click, expectHistory, newDocument } from "./helpers";

type Ed = { active(): { doc(): { layers: { name: string; content: { text: string } }[] } }; type: { session(): { anchor: number; focus: number; content: { text: string } } | null } };
const texts = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc().layers.slice(1).map((l) => l.content.text));
const selected = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__ps!.editor as Ed).type.session();
    return s ? s.content.text.slice(Math.min(s.anchor, s.focus), Math.max(s.anchor, s.focus)) : null;
  });

async function typeLayer(page: Page, y: number, text: string) {
  await page.keyboard.press("t");
  await click(page, 30, y);
  await page.keyboard.type(text);
  await page.keyboard.press("Control+Enter");
  await expectHistory(page, "Type Layer");
}

async function editMenu(page: Page, command: string) {
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.locator(`[data-command='${command}']`).click();
}

test("Find and Replace Text finds across type layers, changes one, then all", async ({ page }) => {
  await newDocument(page, 400, 300);
  await typeLayer(page, 60, "The cat sat");
  await typeLayer(page, 160, "A Cat and a catalogue");
  await editMenu(page, "edit.findReplace");
  await page.getByTestId("find-what").fill("cat");
  await page.getByTestId("change-to").fill("dog");
  await page.getByTestId("find-whole").check();
  await page.getByTestId("find-next").click();
  await expect.poll(() => selected(page)).toBe("Cat");
  await page.getByTestId("find-change").click();
  await page.getByTestId("find-next").click();
  // On to the other layer; "catalogue" isn't a whole word match.
  await expect.poll(() => selected(page)).toBe("cat");
  await page.getByTestId("find-change-all").click();
  await expect(page.getByRole("status")).toContainText("Replaced 1 occurrence");
  expect(await texts(page)).toEqual(["The dog sat", "A dog and a catalogue"]);
  await page.getByTestId("find-done").click();
  await expect(page.getByTestId("find-replace")).toHaveCount(0);
});

test("Check Spelling walks through unknown words: change, ignore, add", async ({ page }) => {
  await newDocument(page, 400, 300);
  await typeLayer(page, 60, "Teh quick brwon fox Picturestore");
  await editMenu(page, "edit.checkSpelling");
  await expect(page.getByTestId("spelling-word")).toHaveText("Teh");
  // Suggestions: pick "The".
  await page.getByRole("listbox", { name: "Suggestions" }).getByRole("option", { name: "The", exact: true }).click();
  await expect(page.getByTestId("spelling-change-to")).toHaveValue("The");
  await page.getByTestId("spelling-change").click();
  await expect(page.getByTestId("spelling-word")).toHaveText("brwon");
  await page.getByTestId("spelling-change-to").fill("brown");
  await page.getByTestId("spelling-change").click();
  await expect(page.getByTestId("spelling-word")).toHaveText("Picturestore");
  await page.getByTestId("spelling-add").click();
  await expect(page.getByTestId("spelling-complete")).toBeVisible();
  await page.getByTestId("spelling-done").click();
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => texts(page)).toEqual(["The quick brown fox Picturestore"]);
});
