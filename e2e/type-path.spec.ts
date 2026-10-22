import { expect, test, type Page } from "@playwright/test";
import { docPoint, drag, historyLabels, newDocument, settled } from "./helpers";

/** The active document's text layers' frames. */
const frames = (page: Page) =>
  page.evaluate(() => {
    const ed = window.__ps!.editor as { active(): { doc(): { layers: { content: { kind: string; frame?: { kind: string; start?: number; flipped?: boolean; closed?: boolean } } }[] } } };
    return ed.active().doc().layers.flatMap((l) => (l.content.kind === "text" ? [l.content.frame!] : []));
  });

async function pen(page: Page, x: number, y: number) {
  const p = await docPoint(page, x, y);
  const before = (await historyLabels(page)).length;
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await historyLabels(page)).length).toBeGreaterThan(before);
  await settled(page);
}

test.describe("Type on any path", () => {
  test("type follows an open work path, and Ctrl-dragging slides it along and across", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await pen(page, 40, 150);
    await pen(page, 360, 150);
    await page.keyboard.press("Escape");
    // The path stays the current one while the Type tool is used.
    await page.keyboard.press("t");
    const p = await docPoint(page, 100, 150);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.insertText("Slide me along");
    await page.keyboard.press("Control+Enter");
    await settled(page);
    let [frame] = await frames(page);
    expect(frame).toMatchObject({ kind: "path", closed: false, flipped: false });
    expect(frame.start).toBeCloseTo(60, 0);

    // Back into the type, then Ctrl-drag along the path.
    const on = await docPoint(page, 120, 150);
    await page.mouse.click(on.x, on.y);
    await page.keyboard.down("Control");
    await drag(page, [120, 150], [180, 150]);
    await page.keyboard.up("Control");
    await page.keyboard.press("Control+Enter");
    await settled(page);
    [frame] = await frames(page);
    expect(frame.start!).toBeGreaterThan(100);
    expect(frame.flipped).toBe(false);

    // And across it: the type goes to the other side.
    const again = await docPoint(page, 210, 145);
    await page.mouse.click(again.x, again.y);
    await page.keyboard.down("Control");
    await drag(page, [210, 145], [210, 195]);
    await page.keyboard.up("Control");
    await page.keyboard.press("Control+Enter");
    await settled(page);
    [frame] = await frames(page);
    expect(frame.flipped).toBe(true);
  });

  test("type fills a closed saved path clicked inside", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    for (const [x, y] of [[80, 60], [320, 60], [320, 240], [80, 240], [80, 60]]) await pen(page, x, y);
    await page.keyboard.press("t");
    const p = await docPoint(page, 210, 145);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.insertText("Area type in a work path");
    await page.keyboard.press("Control+Enter");
    await settled(page);
    const [frame] = await frames(page);
    expect(frame.kind).toBe("area");
  });
});
