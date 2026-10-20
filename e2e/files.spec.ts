import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { cpuPixel, drag, newDocument, setForeground, stubFilePickers } from "./helpers";

async function paintSomething(page: Page) {
  await page.getByTestId("new-layer").click();
  await setForeground(page, "336699");
  await page.keyboard.press("b");
  await drag(page, [50, 50], [350, 250]);
}

async function reopen(page: Page, path: string, tabs = 2) {
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+o");
  await (await chooser).setFiles(path);
  await expect(page.getByTestId("doc-tab")).toHaveCount(tabs);
}

/** Bytes of the n-th file "written" through the stubbed save picker. */
const savedBytes = (page: Page, n: number) =>
  page.evaluate(async (i) => {
    const saved = (window as unknown as { __saved: { blob: Blob }[] }).__saved;
    return [...new Uint8Array(await saved[i].blob.arrayBuffer())];
  }, n);

test("saves PSD in place: asks once, then overwrites", async ({ page }, info) => {
  await stubFilePickers(page);
  await newDocument(page);
  await paintSomething(page);
  const before = await cpuPixel(page, 200, 150);
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("doc-tab").first()).not.toContainText("*");
  const first = await savedBytes(page, 0);
  expect(String.fromCharCode(...first.slice(0, 4))).toBe("8BPS");

  await page.keyboard.press("b");
  await drag(page, [20, 280], [380, 280]);
  await expect(page.getByTestId("doc-tab").first()).toContainText("*");
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("doc-tab").first()).not.toContainText("*");
  expect(await page.evaluate(() => (window as unknown as { __savePrompts: number }).__savePrompts)).toBe(1);

  const path = info.outputPath("first.psd");
  await writeFile(path, Buffer.from(first));
  await reopen(page, path);
  await expect(page.getByTestId("layer-row")).toHaveCount(2);
  expect(await cpuPixel(page, 200, 150)).toEqual(before);
});

test("falls back to downloading the PSD without File System Access", async ({ page }) => {
  await stubFilePickers(page, { saveInPlace: false });
  await newDocument(page);
  await paintSomething(page);
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await download;
  expect(file.suggestedFilename()).toBe("Untitled.psd");
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(0, 4).toString()).toBe("8BPS");
  await reopen(page, await file.path());
  const names = await page.getByTestId("layer-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-layer-name")));
  expect(names).toEqual(["Layer 1", "Background"]);
});

test("exports PNG at document size", async ({ page }) => {
  await stubFilePickers(page);
  await newDocument(page, 320, 200);
  await paintSomething(page);
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "File" }).click();
  await page.locator('[data-command="file.export.png"]').click();
  const file = await download;
  const png = await readFile(await file.path());
  expect(png.readUInt32BE(16)).toBe(320);
  expect(png.readUInt32BE(20)).toBe(200);
  await reopen(page, await file.path());
  await expect(page.getByTestId("layer-row")).toHaveCount(1);
});
