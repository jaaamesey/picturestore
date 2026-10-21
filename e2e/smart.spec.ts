import { expect, test, type Page } from "@playwright/test";
import { cpuPixel, drag, expectHistory, gpuPixels, historyLabels, newDocument, rectOnLayer, setForeground } from "./helpers";

const rows = (page: Page) => page.getByTestId("layer-row");
const kinds = (page: Page) => rows(page).evaluateAll((r) => r.map((x) => x.getAttribute("data-kind")));

/** Dispatches a drop or paste of a generated solid-colour PNG, as the OS would deliver it. */
async function deliverImage(page: Page, kind: "drop" | "paste", width: number, height: number, color: string) {
  await page.evaluate(
    async ({ kind, width, height, color }) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      const file = new File([await canvas.convertToBlob({ type: "image/png" })], "photo.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      const target = document.querySelector("[data-testid=viewport]")!;
      if (kind === "drop") target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      else document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { kind, width, height, color },
  );
}

test("shape tools draw live shape layers; options edit the selected shape", async ({ page }) => {
  await newDocument(page);
  await setForeground(page, "ff0000");
  await page.keyboard.press("u");
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [50, 50], [150, 120]);
  // Drawn on the GPU; the layer's pixels are read back for the history step.
  await expectHistory(page, "Rectangle Tool");
  await expect(rows(page).first()).toHaveAttribute("data-layer-name", "Rectangle 1");
  expect((await kinds(page))[0]).toBe("shape");
  expect(await cpuPixel(page, 100, 80)).toEqual([255, 0, 0, 255]);
  expect(await gpuPixels(page, [[100, 80]])).toEqual([[255, 0, 0, 255]]);

  // Fill: none, with an outside stroke.
  await page.getByTestId("shape-fill").click();
  await page.getByTestId("shape-fill-popover").getByTestId("color-none").click();
  await expect.poll(() => cpuPixel(page, 100, 80)).toEqual([255, 255, 255, 255]);
  await page.getByTestId("shape-stroke").click();
  await page.getByTestId("hex-input").fill("0000ff");
  await page.getByTestId("hex-input").press("Enter");
  await page.getByTestId("color-ok").click();
  await page.getByTestId("shape-stroke-align").selectOption("outside");
  await expect.poll(() => cpuPixel(page, 48, 80)).toEqual([0, 0, 255, 255]);
  expect(await gpuPixels(page, [[48, 80]])).toEqual([[0, 0, 255, 255]]);
  expect((await historyLabels(page)).filter((l) => l === "Shape Properties").length).toBeLessThanOrEqual(3);

  // Shift+U cycles through the group; the flyout lists it.
  await page.keyboard.press("Shift+u");
  await expect(page.getByTestId("tool-ellipse")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("tool-ellipse").click({ button: "right" });
  await page.getByTestId("flyout-polygon").click();
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [200, 150], [300, 250]);
  await expect(rows(page).first()).toHaveAttribute("data-layer-name", "Polygon 1");
});

test("painting on a shape asks to rasterize it, with Photoshop's prompt", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("u");
  await drag(page, [50, 50], [150, 120]);
  await expectHistory(page, "Rectangle Tool");
  await page.keyboard.press("b");
  await drag(page, [60, 60], [70, 70]);
  await expect(page.getByTestId("confirm-dialog")).toContainText("This shape layer must be rasterized before proceeding.");
  await page.getByTestId("confirm-cancel").click();
  expect((await kinds(page))[0]).toBe("shape");
  await drag(page, [60, 60], [70, 70]);
  await page.getByTestId("confirm-ok").click();
  await expect.poll(async () => (await kinds(page))[0]).toBe("pixels");
  await expectHistory(page, "Rasterize Layer");
});

test("dropping an image onto a document places it as a smart object", async ({ page }) => {
  await newDocument(page, 400, 300);
  await deliverImage(page, "drop", 800, 200, "#00ff00");
  await expect(page.getByTestId("transform-box")).toBeVisible();
  await page.keyboard.press("Enter");
  await expectHistory(page, "Place Embedded");
  expect(await kinds(page)).toEqual(["smart", "pixels"]);
  await expect(rows(page).first()).toHaveAttribute("data-layer-name", "photo");
  // Fitted to the canvas: 800×200 → 400×100, centred.
  expect(await cpuPixel(page, 5, 150)).toEqual([0, 255, 0, 255]);
  expect(await cpuPixel(page, 200, 95)).toEqual([255, 255, 255, 255]);

  // Escape during placement discards it.
  await deliverImage(page, "drop", 50, 50, "#ff00ff");
  await expect(page.getByTestId("transform-box")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCount(2);

  // Scaling down (W is relative to the source) then back up re-renders from the source: no loss.
  await page.keyboard.press("Alt+Control+t");
  await page.getByTestId("transform-w").fill("10");
  await page.getByTestId("transform-w").press("Enter");
  await page.getByTestId("transform-commit").click();
  await expectHistory(page, "Free Transform");
  await page.keyboard.press("Alt+Control+t");
  await page.getByTestId("transform-w").fill("100");
  await page.getByTestId("transform-w").press("Enter");
  await page.getByTestId("transform-commit").click();
  await expect.poll(async () => (await historyLabels(page)).length).toBe(4);
  expect(await cpuPixel(page, 5, 150)).toEqual([0, 255, 0, 255]);
});

test("right-clicking a layer offers smart object and rasterize commands", async ({ page }) => {
  await newDocument(page);
  await rectOnLayer(page, 10, 10, 100, 100, "ff0000");
  await rows(page).first().click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Convert to Smart Object").click();
  await expect.poll(async () => (await kinds(page))[0]).toBe("smart");
  await expect(rows(page).first().getByTestId("layer-badge")).toBeVisible();
  await rows(page).first().click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Rasterize Layer").click();
  await expect.poll(async () => (await kinds(page))[0]).toBe("pixels");
  await expect(page.getByTestId("context-menu")).toHaveCount(0);
});

test("Edit Contents opens the smart object; saving updates it in the parent", async ({ page }) => {
  await newDocument(page);
  await rectOnLayer(page, 0, 0, 100, 100, "ff0000");
  await page.getByRole("menuitem", { name: "Layer" }).click();
  await page.getByText("Smart Objects").hover();
  await page.getByText("Convert to Smart Object").click();
  await page.getByRole("menuitem", { name: "Layer" }).click();
  await page.getByText("Smart Objects").hover();
  await page.getByText("Edit Contents").click();
  await expect(page.getByTestId("doc-tab")).toHaveCount(2);
  await setForeground(page, "0000ff");
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+s");
  await page.getByTestId("doc-tab").first().click();
  await expectHistory(page, "Update Smart Object");
  expect(await cpuPixel(page, 50, 50)).toEqual([0, 0, 255, 255]);
});

test("copy and paste: our own copies and images from other applications", async ({ page }) => {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 10, 10, 50, 50, "ff0000");
  await page.keyboard.press("m");
  await drag(page, [10, 10], [50, 50]);
  await page.keyboard.press("Control+c");
  // Menu paste falls back to our own copy when clipboard reading isn't permitted.
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.locator('[data-command="edit.paste"]').click();
  await expectHistory(page, "Paste");
  // Centred on the selection, which is where it came from; the selection is dropped.
  expect(await cpuPixel(page, 30, 30)).toEqual([255, 0, 0, 255]);
  await expect(rows(page)).toHaveCount(3);

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+d");
  await deliverImage(page, "paste", 20, 20, "#0000ff");
  await expectHistory(page, "Paste");
  await expect(rows(page)).toHaveCount(4);
  expect(await cpuPixel(page, 200, 150)).toEqual([0, 0, 255, 255]);
});

test("changing a smart object's canvas in Edit Contents keeps its scale, centred where it was (as Photoshop does)", async ({ page }) => {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 100, 100, 200, 200, "ff0000");
  await rows(page).first().click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Convert to Smart Object").click();
  // Scale it 2× about its centre (150, 150): it now covers 50–250.
  await page.keyboard.press("Alt+Control+t");
  await page.getByTestId("transform-w").fill("200");
  await page.getByTestId("transform-w").press("Enter");
  await page.getByTestId("transform-commit").click();
  await expectHistory(page, "Free Transform");
  expect(await cpuPixel(page, 60, 150)).toEqual([255, 0, 0, 255]);

  await rows(page).first().click({ button: "right" });
  await page.getByTestId("context-menu").getByText("Edit Contents").click();
  await expect(page.getByTestId("doc-tab")).toHaveCount(2);
  // Canvas Size: 100 px more on the right (anchored left).
  await page.keyboard.press("Alt+Control+c");
  await page.getByTestId("canvas-relative").check();
  await page.getByTestId("canvas-width").fill("100");
  await page.getByTestId("canvas-width").press("Tab");
  await page.getByTestId("canvas-anchor-0-0.5").click();
  await page.getByTestId("canvas-ok").click();
  await expectHistory(page, "Canvas Size");
  await page.keyboard.press("Control+s");
  await page.getByTestId("doc-tab").first().click();
  await expectHistory(page, "Update Smart Object");

  // Still 2× (200 source px → 400 doc px), centred on 150: the red half now spans -50–150.
  expect(await cpuPixel(page, 10, 150)).toEqual([255, 0, 0, 255]);
  expect(await cpuPixel(page, 140, 150)).toEqual([255, 0, 0, 255]);
  expect(await cpuPixel(page, 200, 150)).toEqual([255, 255, 255, 255]);
  // Height unchanged: 50–250.
  expect(await cpuPixel(page, 100, 40)).toEqual([255, 255, 255, 255]);
  expect(await cpuPixel(page, 100, 60)).toEqual([255, 0, 0, 255]);
});

test("Fill on a shape asks to rasterize, then fills (one action, two steps, as in Photoshop)", async ({ page }) => {
  await newDocument(page);
  await setForeground(page, "00ff00");
  await page.keyboard.press("u");
  await drag(page, [50, 50], [150, 120]);
  await expectHistory(page, "Rectangle Tool");
  await setForeground(page, "ff00ff");
  await page.keyboard.press("Alt+Backspace");
  await page.getByTestId("confirm-ok").click();
  await expectHistory(page, "Fill");
  const labels = await historyLabels(page);
  expect(labels.slice(-2)).toEqual(["Rasterize Layer", "Fill"]);
  expect((await kinds(page))[0]).toBe("pixels");
  expect(await cpuPixel(page, 10, 10)).toEqual([255, 0, 255, 255]);
});
