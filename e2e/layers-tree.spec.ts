import { expect, test, type Page } from "@playwright/test";
import { newDocument, settled } from "./helpers";

/**
 * GPU compositing of groups, clipping masks, layer masks and adjustment
 * layers against the CPU reference (`core/composite.ts`), on scenes built
 * in the page. The GPU composites in half floats, so values may differ by a
 * step or two; nearly transparent pixels (whose colour is ill-defined) are
 * skipped.
 */

const W = 64, H = 48;

/** Opens a scene built by `build` (run in the page with the test hooks) and compares the GPU composite with the CPU's. */
async function compare(page: Page, build: string, arg: unknown = null) {
  await page.evaluate(
    ([src, a]) => {
      const core = window.__ps!.core!;
      const doc = new Function("core", "arg", src)(core, a);
      (window.__ps!.editor as { openDocument(d: unknown, name: string): void }).openDocument(doc, "scene");
    },
    [build, arg] as const,
  );
  await settled(page);
  return page.evaluate(async () => {
    const ed = window.__ps!.editor as { active(): { doc(): { width: number; height: number } } };
    const doc = ed.active().doc();
    const gpu = await window.__ps!.renderer!.readComposite();
    const cpu = window.__ps!.reference!.flatten(doc as never);
    let worst = 0, over = 0, n = 0;
    for (let i = 0; i < cpu.length; i += 4) {
      if (cpu[i + 3] < 8 && gpu[i + 3] < 8) continue;
      n++;
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(cpu[i + c] - gpu[i + c]));
      worst = Math.max(worst, d);
      if (d > 2) over++;
    }
    return { worst, over, n };
  });
}

/** A colourful backdrop: blocks across hues and greys, some translucent, plus the layers `layers` builds from `core`. */
const SCENE = (layers: string) => `
  const { createLayer, fillPixels, NO_PIXELS, rect } = core;
  let px = NO_PIXELS;
  for (let y = 0; y < ${H}; y += 6)
    for (let x = 0; x < ${W}; x += 8) {
      const h = (x / ${W}) * 6, f = h - Math.floor(h), k = Math.floor(h) % 6;
      const hue = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][k];
      const v = 0.25 + (y / ${H}) * 0.75, grey = x >= ${W - 8};
      const c = grey ? { r: v * 255, g: v * 255, b: v * 255 } : { r: hue[0] * v * 255, g: hue[1] * v * 255, b: hue[2] * v * 255 };
      px = fillPixels(px, rect(x, y, 8, 6), { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) }, null, y > ${H - 8} ? 0.5 : 1);
    }
  const bg = createLayer({ name: "bg", pixels: px });
  const layers = [bg, ...(() => { ${layers} })()];
  return { width: ${W}, height: ${H}, layers, activeLayerId: layers[layers.length - 1].id, selection: null };
`;

test.describe("GPU compositing matches the CPU reference", () => {
  test.beforeEach(({ page }) => newDocument(page, 32, 32));

  test("groups: pass-through, isolated, with opacity and masks, nested", async ({ page }) => {
    const r = await compare(
      page,
      SCENE(`
        const { createGroup, REVEAL_ALL } = core;
        const red = createLayer({ name: "r", pixels: fillPixels(NO_PIXELS, rect(4, 4, 30, 20), { r: 220, g: 40, b: 40 }), blendMode: "screen", opacity: 0.8 });
        const blue = createLayer({ name: "b", pixels: fillPixels(NO_PIXELS, rect(20, 10, 30, 30), { r: 30, g: 60, b: 230 }), blendMode: "multiply" });
        const mask = { ...REVEAL_ALL, pixels: fillPixels(NO_PIXELS, rect(0, 0, 32, 48), { r: 60, g: 60, b: 60 }) };
        const inner = { ...createGroup("inner", [blue]), blendMode: "normal", opacity: 0.7 };
        const pass = { ...createGroup("pass", [red, inner]), opacity: 0.6, mask };
        const iso = { ...createGroup("iso", [createLayer({ name: "o", pixels: fillPixels(NO_PIXELS, rect(36, 0, 20, 48), { r: 250, g: 200, b: 20 }), blendMode: "overlay" })]), blendMode: "difference" };
        return [pass, iso];
      `),
    );
    expect(r.n).toBeGreaterThan(2000);
    expect(r.over).toBe(0);
  });

  test("clipping masks: blend modes and opacity in the group, base masks, a group as base", async ({ page }) => {
    const r = await compare(
      page,
      SCENE(`
        const { createGroup, HIDE_ALL, REVEAL_ALL } = core;
        const base = createLayer({ name: "base", pixels: fillPixels(NO_PIXELS, rect(8, 8, 40, 30), { r: 200, g: 200, b: 200 }), opacity: 0.9, blendMode: "hard light",
          mask: { ...REVEAL_ALL, pixels: fillPixels(NO_PIXELS, rect(8, 8, 12, 30), { r: 0, g: 0, b: 0 }) } });
        const c1 = createLayer({ name: "c1", clipped: true, pixels: fillPixels(NO_PIXELS, rect(0, 0, 64, 20), { r: 255, g: 0, b: 120 }), blendMode: "color burn", opacity: 0.7 });
        const c2 = createLayer({ name: "c2", clipped: true, pixels: fillPixels(NO_PIXELS, rect(30, 0, 34, 48), { r: 0, g: 180, b: 255 }),
          mask: { ...HIDE_ALL, pixels: fillPixels(NO_PIXELS, rect(30, 20, 34, 28), { r: 255, g: 255, b: 255 }) } });
        const g = createGroup("g", [createLayer({ name: "gl", pixels: fillPixels(NO_PIXELS, rect(44, 24, 20, 24), { r: 90, g: 220, b: 90 }) })]);
        const c3 = createLayer({ name: "c3", clipped: true, pixels: fillPixels(NO_PIXELS, rect(0, 30, 64, 18), { r: 255, g: 255, b: 0 }), blendMode: "luminosity" });
        return [base, c1, c2, g, c3];
      `),
    );
    expect(r.over).toBe(0);
  });

  const ADJUSTED: Record<string, string> = {
    "brightness-contrast": `({ ...a, brightness: 60, contrast: 40 })`,
    "brightness-contrast (legacy)": `({ ...a, kind: "brightness-contrast", brightness: -30, contrast: 50, legacy: true })`,
    levels: `({ ...a, channels: { ...a.channels, rgb: { ...a.channels.rgb, inBlack: 30, inWhite: 220, gamma: 1.4 }, blue: { ...a.channels.blue, outBlack: 40 } } })`,
    curves: `({ ...a, channels: { ...a.channels, rgb: [{ x: 0, y: 20 }, { x: 90, y: 60 }, { x: 180, y: 220 }, { x: 255, y: 255 }], red: [{ x: 0, y: 0 }, { x: 128, y: 160, corner: true }, { x: 255, y: 255 }] } })`,
    exposure: `({ ...a, exposure: 0.8, offset: -0.05, gamma: 1.2 })`,
    vibrance: `({ ...a, vibrance: 60, saturation: -20 })`,
    "hue-saturation": `({ ...a, master: { hue: 40, saturation: 30, lightness: -10 }, ranges: { ...a.ranges, blues: { ...a.ranges.blues, hue: -60, lightness: 30 } } })`,
    "hue-saturation (colorize)": `({ ...a, kind: "hue-saturation", colorize: true, master: { hue: 200, saturation: 50, lightness: 10 } })`,
    "color-balance": `({ ...a, midtones: [40, -20, 10], highlights: [-30, 0, 25] })`,
    "black-white": `({ ...a, reds: 120, blues: -40, tint: true })`,
    "photo-filter": `({ ...a, density: 60 })`,
    "channel-mixer": `({ ...a, red: { red: 50, green: 50, blue: 0, constant: 5 }, blue: { red: 0, green: 30, blue: 80, constant: -10 } })`,
    "color-lookup": `({ ...a, lut: core.parseCube(["LUT_3D_SIZE 3", ...Array.from({ length: 27 }, (_, i) => [i % 3, Math.floor(i / 3) % 3, Math.floor(i / 9)].map((v, c) => (c === 0 ? (2 - v) / 2 : v / 2) ** 1.3).join(" "))].join("\\n"), "t") })`,
    invert: `a`,
    posterize: `({ ...a, levels: 5 })`,
    threshold: `({ ...a, level: 110 })`,
    "gradient-map": `({ ...a, gradient: { stops: [{ location: 0, midpoint: 0.5, color: { r: 20, g: 0, b: 80 } }, { location: 0.4, midpoint: 0.3, color: { r: 250, g: 80, b: 0 } }, { location: 1, midpoint: 0.5, color: { r: 255, g: 255, b: 200 } }] } })`,
    "selective-color": `({ ...a, absolute: true, colors: { ...a.colors, reds: { cyan: 40, magenta: -20, yellow: 0, black: 10 }, neutrals: { cyan: 0, magenta: 0, yellow: 20, black: -10 } } })`,
  };

  for (const [name, settings] of Object.entries(ADJUSTED)) {
    test(`adjustment layer: ${name}, through a mask, opacity and blend mode, and clipped`, async ({ page }) => {
      const kind = name.split(" ")[0];
      const r = await compare(
        page,
        SCENE(`
          const { defaultAdjustment, REVEAL_ALL } = core;
          const a = defaultAdjustment(arg.kind, { r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
          const adjustment = ${settings};
          const mask = { ...REVEAL_ALL, pixels: fillPixels(NO_PIXELS, rect(0, 0, 16, 48), { r: 0, g: 0, b: 0 }) };
          const full = createLayer({ name: "adj", content: { kind: "adjustment", adjustment }, mask });
          const faded = createLayer({ name: "adj2", content: { kind: "adjustment", adjustment }, mask: REVEAL_ALL, opacity: 0.5, blendMode: "luminosity" });
          const base = createLayer({ name: "base", pixels: fillPixels(NO_PIXELS, rect(40, 4, 20, 40), { r: 180, g: 90, b: 30 }) });
          const clipped = createLayer({ name: "clip", content: { kind: "adjustment", adjustment }, mask: REVEAL_ALL, clipped: true });
          return [full, faded, base, clipped];
        `),
        { kind },
      );
      expect(r.n).toBeGreaterThan(2000);
      expect(r.over).toBe(0);
    });
  }

  test("Image ▸ Adjustments on the GPU matches the CPU reference, within the selection", async ({ page }) => {
    await page.evaluate(() => {
      const core = window.__ps!.core!;
      const ed = window.__ps!.editor as { openDocument(d: unknown, n: string): void };
      let px = core.NO_PIXELS;
      for (let i = 0; i < 16; i++) px = core.fillPixels(px, core.rect(i * 4, 0, 4, 32), { r: i * 16, g: 255 - i * 12, b: (i * 53) % 255 });
      const l = core.createLayer({ name: "l", pixels: px });
      ed.openDocument({ width: 64, height: 32, layers: [l], activeLayerId: l.id, selection: null }, "adjust");
    });
    await settled(page);
    const diff = await page.evaluate(async () => {
      const core = window.__ps!.core!;
      const ed = window.__ps!.editor as { active(): { doc(): { layers: { pixels: never }[] } } };
      const pixels = ed.active().doc().layers[0].pixels;
      const hs = core.defaultAdjustment("hue-saturation") as never as { master: object };
      const p = core.compile({ ...hs, master: { hue: 70, saturation: 40, lightness: 10 } } as never);
      const mask = { bounds: core.rect(10, 4, 40, 20), width: 64, height: 32, data: new Uint8Array(40 * 20).map((_, i) => (i % 40) * 6) };
      const gpu = await window.__ps!.renderer!.adjust(pixels, p, mask as never);
      const cpu = core.adjustPixels(pixels, p, mask as never);
      const r = window.__ps!.reference!.readRect;
      const a = r(gpu, core.rect(0, 0, 64, 32)), b = r(cpu, core.rect(0, 0, 64, 32));
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      return worst;
    });
    expect(diff).toBeLessThanOrEqual(1);
  });
});
