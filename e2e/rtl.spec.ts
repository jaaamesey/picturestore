import { expect, test, type Page } from "@playwright/test";
import { click, docPoint, expectHistory, newDocument, screenPixel, settled } from "./helpers";

type Ed = { active(): { doc(): { layers: { name: string; content: { text: string; paragraphs: { style: { direction: string } }[] } }[] } } };
const layer = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc().layers[1]);
/** Ink (dark pixels) along a row of the CPU composite: the longest unbroken stretch, and the extent. */
const row = (page: Page, y: number, x0: number, x1: number) =>
  page.evaluate(([y, x0, x1]) => {
    let run = 0, longest = 0, first = -1, last = -1;
    for (let x = x0; x < x1; x++) {
      const dark = window.__ps!.pixel!(x, y)[0] < 140;
      run = dark ? run + 1 : 0;
      longest = Math.max(longest, run);
      if (dark) ((last = x), first < 0 && (first = x));
    }
    return { longest, first, last };
  }, [y, x0, x1]);

test.describe("Right-to-left type", () => {
  test("Arabic typed with the Type tool is shaped, joined and set right to left; arrows move on screen, Backspace in reading order", async ({ page }) => {
    await newDocument(page, 500, 200);
    await page.keyboard.press("t");
    await click(page, 60, 120);
    await page.getByTestId("text-input").evaluate((el) => el.focus());
    await page.keyboard.type("سلام");
    // (Playwright sends Arabic as text input, which can land after a following key: wait until it's shown.)
    await expect.poll(() => page.evaluate(() => (window.__ps!.editor as { type: { session(): { content: { text: string } } | null } }).type.session()?.content.text)).toBe("سلام");
    // The caret is at the reading end: on the left of the word. Right moves it right on screen, one letter back in reading order.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    const l = await layer(page);
    // "ا" (before the caret after one step right) went: Backspace deletes in reading order.
    expect(l.content.text).toBe("سلم");
    expect(l.name).toBe("سلم");

    // Drawn, in the Arabic font (no missing-glyph boxes), and joined: one unbroken stroke runs along the baseline.
    await settled(page);
    const base = await (async () => {
      for (let y = 121; y > 95; y--) if ((await row(page, y, 40, 300)).longest > 0) return y;
      return 120;
    })();
    let best = 0;
    for (let y = base; y > base - 6; y--) best = Math.max(best, (await row(page, y, 40, 300)).longest);
    expect(best).toBeGreaterThan(12);
    expect((await screenPixel(page, 30, 60))[0]).toBeGreaterThan(250);
  });

  test("a right-to-left paragraph (Paragraph panel menu) reads Latin and Arabic in its order", async ({ page }) => {
    await newDocument(page, 500, 200);
    await page.keyboard.press("t");
    await page.getByTestId("type-size").fill("36");
    await page.getByTestId("type-size").press("Enter");
    await click(page, 450, 120);
    await page.getByTestId("type-panels").click();
    await page.getByTestId("panel-tab-paragraph").click();
    await page.getByTestId("panel-menu-paragraph").click();
    await page.locator("[data-command='para.direction.rtl']").click();
    await page.getByTestId("para-align-right").click();
    await page.getByTestId("text-input").evaluate((el) => el.focus());
    await page.keyboard.type("abc سلام");
    await expect.poll(() => page.evaluate(() => (window.__ps!.editor as { type: { session(): { content: { text: string } } | null } }).type.session()?.content.text)).toBe("abc سلام");
    // Home: the caret goes to the start of the text, which is read first, so is on the right.
    await page.keyboard.press("Home");
    const caret = (await page.getByTestId("text-caret").boundingBox())!;
    const origin = await docPoint(page, 0, 0);
    const caretX = caret.x + caret.width / 2 - origin.x;
    await page.keyboard.press("Control+Enter");
    await expectHistory(page, "Type Layer");
    expect((await layer(page)).content.paragraphs[0].style.direction).toBe("rtl");
    await settled(page);
    // Right-aligned to the click.
    let ink = { first: -1, last: -1 };
    for (let y = 95; y < 130; y++) {
      const r = await row(page, y, 150, 499);
      if (r.first >= 0) ink = { first: ink.first < 0 ? r.first : Math.min(ink.first, r.first), last: Math.max(ink.last, r.last) };
    }
    expect(ink.last).toBeLessThanOrEqual(452);
    expect(ink.last).toBeGreaterThan(440);
    // "abc" (three letters, ~0.4 of the line) is the right part: the caret before "a" is right of the middle.
    expect(caretX).toBeGreaterThan((ink.first + ink.last) / 2);
    expect(caretX).toBeLessThan(ink.last - 20);
  });
});
