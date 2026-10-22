import { expect, test, type Page } from "@playwright/test";
import { click, docPoint, drag, expectHistory, newDocument, screenPixel, settled } from "./helpers";

type Ed = { active(): { doc(): { layers: { name: string; content: { kind: string; text?: string } }[] } } };
const layers = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc().layers.map((l) => ({ name: l.name, kind: l.content.kind, text: l.content.text })));
/** Ink (non-white) pixels the CPU composite has in a rectangle. */
const ink = (page: Page, x0: number, y0: number, x1: number, y1: number) =>
  page.evaluate(([x0, y0, x1, y1]) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (window.__ps!.pixel!(x, y)[0] < 128) n++;
    return n;
  }, [x0, y0, x1, y1]);

test("click with the Type tool, type, commit: a type layer named by its text", async ({ page }) => {
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
  // Drawn on the baseline at the click, rising above it.
  expect(await ink(page, 40, 85, 120, 100)).toBeGreaterThan(20);
  expect(await ink(page, 40, 101, 120, 115)).toBe(0);
  expect((await screenPixel(page, 41, 93))[0]).toBeLessThan(250);
});
