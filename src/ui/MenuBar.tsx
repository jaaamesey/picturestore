import { For, Show, createSignal, useContext } from "solid-js";
import { ADJUSTMENTS } from "../core/adjustments";
import { command, formatShortcut, isEnabled, runCommand, type CommandId } from "../editor/commands";
import { AppContext, isMac } from "./context";
import { Popover } from "./Popover";

type MenuItem = CommandId | "-" | { readonly submenu: string; readonly items: readonly MenuItem[] };

export const TRANSFORM_MENU: readonly MenuItem[] = [
  "edit.transform.scale",
  "edit.transform.rotate",
  "edit.transform.skew",
  "edit.transform.distort",
  "edit.transform.perspective",
  "edit.transform.warp",
  "-",
  "edit.transform.rotate180",
  "edit.transform.rotate90cw",
  "edit.transform.rotate90ccw",
  "-",
  "edit.transform.flipHorizontal",
  "edit.transform.flipVertical",
];

/** Layer ▸ New Adjustment Layer, in Photoshop's order and grouping. */
export const ADJUSTMENT_LAYER_MENU: readonly MenuItem[] = ADJUSTMENTS.flatMap(({ kind }) => [
  ...(kind === "levels" || kind === "vibrance" || kind === "invert" ? (["-"] as const) : []),
  `layer.adjustment.${kind}` as const,
]);

/** Image ▸ Adjustments, in Photoshop's order and grouping. */
const IMAGE_ADJUSTMENTS_MENU: readonly MenuItem[] = [
  ...ADJUSTMENTS.flatMap(({ kind }) => [...(kind === "vibrance" || kind === "invert" ? (["-"] as const) : []), `image.adjust.${kind}` as const]),
  "-",
  "image.desaturate",
  "image.equalize",
];

const LAYER_MASK_MENU: readonly MenuItem[] = [
  "layer.mask.revealAll",
  "layer.mask.hideAll",
  "layer.mask.revealSelection",
  "layer.mask.hideSelection",
  "-",
  "layer.mask.delete",
  "layer.mask.apply",
  "-",
  "layer.mask.disable",
];

/** Right-click on a layer (and on the canvas, outside selection tools). */
export const LAYER_MENU: readonly MenuItem[] = [
  "layer.duplicate",
  "layer.delete",
  "-",
  "layer.group",
  "layer.ungroup",
  "-",
  "layer.convertToSmart",
  "layer.editContents",
  "layer.rasterize",
  "-",
  "layer.mask.delete",
  "layer.mask.apply",
  "layer.mask.disable",
  "-",
  "layer.clippingMask",
  "layer.releaseClippingMask",
  "-",
  "layer.mergeDown",
];

/** Right-click on the canvas with the Crop tools. */
export const CROP_MENU: readonly MenuItem[] = ["crop.commit", "crop.reset", "-", "crop.rotateBox"];

/** Right-click on the canvas with a selection tool. */
export const SELECTION_MENU: readonly MenuItem[] = [
  "select.deselect",
  "select.inverse",
  "-",
  "layer.viaCopy",
  "layer.viaCut",
  "-",
  "edit.freeTransform",
];

/** Window ▸ Character panel's menu. */
export const CHARACTER_MENU: readonly MenuItem[] = [
  "type.orientation.horizontal",
  "type.orientation.vertical",
  "char.verticalRoman",
  "char.tateChuYoko",
  "-",
  { submenu: "OpenType", items: ["char.oldStyle", "char.ornaments"] },
  "-",
  "char.fauxBold",
  "char.fauxItalic",
  "char.allCaps",
  "char.smallCaps",
  "char.superscript",
  "char.subscript",
  "char.underline",
  "char.strikethrough",
  "-",
  "char.underlineRight",
  "char.underlineLeft",
  "-",
  "char.fractionalWidths",
  "char.noBreak",
  "-",
  { submenu: "Digits", items: ["char.digits.default", "char.digits.arabic", "char.digits.hindi", "char.digits.farsi"] },
  "-",
  "char.reset",
];

/** Window ▸ Paragraph panel's menu. */
export const PARAGRAPH_MENU: readonly MenuItem[] = [
  "para.hangingPunctuation",
  "-",
  "para.composer.single",
  "para.composer.every",
  "-",
  "para.direction.ltr",
  "para.direction.rtl",
  "-",
  "para.reset",
];

const TYPE_MENU: readonly MenuItem[] = [
  { submenu: "Panels", items: ["type.panels.character", "type.panels.paragraph", "type.panels.glyphs"] },
  {
    submenu: "Anti-Alias",
    items: ["type.antiAlias.none", "type.antiAlias.sharp", "type.antiAlias.crisp", "type.antiAlias.strong", "type.antiAlias.smooth", "-", "type.antiAlias.platformLCD", "type.antiAlias.platform"],
  },
  { submenu: "Orientation", items: ["type.orientation.horizontal", "type.orientation.vertical"] },
  "-",
  "type.convertToShape",
  "-",
  "type.rasterize",
  "type.convertShapeType",
  "type.warp",
  "-",
  {
    submenu: "Font Preview Size",
    items: ["type.previewSize.none", "type.previewSize.small", "type.previewSize.medium", "type.previewSize.large", "type.previewSize.extraLarge", "type.previewSize.huge"],
  },
  "-",
  "type.addFonts",
  "type.manageFonts",
  "-",
  "type.updateAll",
  "type.replaceMissing",
  "-",
  "type.pasteLorem",
];

const MENUS: readonly { readonly title: string; readonly items: readonly MenuItem[] }[] = [
  {
    title: "File",
    items: ["file.new", "file.open", "-", "file.placeEmbedded", "-", "file.save", "file.saveAs", "-", "file.export.png", "file.export.jpeg", "file.export.webp", "-", "file.close"],
  },
  {
    title: "Edit",
    items: [
      "edit.undo",
      "edit.redo",
      "-",
      "edit.cut",
      "edit.copy",
      "edit.copyMerged",
      "edit.paste",
      "edit.pasteInPlace",
      "-",
      "edit.fillForeground",
      "edit.fillBackground",
      "edit.clear",
      "-",
      "edit.freeTransform",
      { submenu: "Transform", items: TRANSFORM_MENU },
      "-",
      { submenu: "Preferences", items: ["edit.preferences", "edit.preferences.fileHandling", "edit.preferences.performance"] },
    ],
  },
  { title: "Image", items: [{ submenu: "Adjustments", items: IMAGE_ADJUSTMENTS_MENU }, "-", "image.imageSize", "image.canvasSize", "-", "image.crop"] },
  {
    title: "Layer",
    items: [
      { submenu: "New", items: ["layer.new", "layer.newGroup", "-", "layer.viaCopy", "layer.viaCut"] },
      "layer.duplicate",
      "layer.delete",
      "-",
      { submenu: "New Adjustment Layer", items: ADJUSTMENT_LAYER_MENU },
      "-",
      { submenu: "Layer Mask", items: LAYER_MASK_MENU },
      "layer.clippingMask",
      "layer.releaseClippingMask",
      "-",
      { submenu: "Smart Objects", items: ["layer.convertToSmart", "layer.editContents"] },
      "layer.rasterize",
      "-",
      "layer.group",
      "layer.ungroup",
      "-",
      { submenu: "Arrange", items: ["layer.bringToFront", "layer.bringForward", "layer.sendBackward", "layer.sendToBack"] },
      "-",
      "layer.mergeDown",
    ],
  },
  { title: "Type", items: TYPE_MENU },
  { title: "Select", items: ["select.all", "select.deselect", "select.inverse"] },
  {
    title: "View",
    items: [
      "view.zoomIn",
      "view.zoomOut",
      "-",
      "view.fit",
      "view.actual",
      "-",
      "view.extras",
      { submenu: "Show", items: ["view.show.guides", "view.show.grid", "view.show.smartGuides"] },
      "-",
      "view.rulers",
      "-",
      "view.snap",
      { submenu: "Snap To", items: ["view.snapTo.guides", "view.snapTo.grid", "view.snapTo.layers", "view.snapTo.bounds", "-", "view.snapTo.all", "view.snapTo.none"] },
      "-",
      "view.lockGuides",
      "view.clearGuides",
      "view.newGuide",
    ],
  },
  { title: "Window", items: ["window.character", "window.glyphs", "window.history", "window.layers", "window.paragraph", "window.properties"] },
];

/** A dropdown list of commands; used by the menu bar and context menus. */
export function MenuList(props: { items: readonly MenuItem[]; onDone: () => void }) {
  const { editor, shell } = useContext(AppContext);
  const [openSub, setOpenSub] = createSignal<string | null>(null);
  // A column for check marks only in menus that have checkable items, so every row lines up either way.
  const checkable = () => props.items.some((i) => typeof i === "string" && i !== "-" && !!command(i).checked);
  return (
    <div class="min-w-56 rounded-sm border border-line bg-panel-2 py-1 shadow-xl" role="menu">
      <For each={props.items}>
        {(item) =>
          item === "-" ? (
            <div class="my-1 h-px bg-line" />
          ) : typeof item === "object" ? (
            <div class="relative" onPointerEnter={() => setOpenSub(item.submenu)} onPointerLeave={() => setOpenSub(null)}>
              <div role="menuitem" aria-haspopup="menu" class="flex justify-between px-4 py-1 hover:bg-accent hover:text-white">
                <span class="flex items-center gap-1.5">
                  <Show when={checkable()}>
                    <span class="w-3" />
                  </Show>
                  {item.submenu}
                </span>
                <span>▸</span>
              </div>
              <Popover open={openSub() === item.submenu} onClose={() => setOpenSub(null)} class="top-0 left-full -mt-1" flip>
                <MenuList items={item.items} onDone={props.onDone} />
              </Popover>
            </div>
          ) : (
            <button
              type="button"
              role={command(item).checked ? "menuitemcheckbox" : "menuitem"}
              aria-checked={command(item).checked ? (command(item).checked!(editor, shell) ? "true" : "false") : undefined}
              data-command={item}
              disabled={!isEnabled(item, editor)}
              class="flex w-full items-center justify-between gap-6 px-4 py-1 text-left hover:bg-accent hover:text-white disabled:text-dim disabled:hover:bg-transparent"
              onClick={() => {
                props.onDone();
                runCommand(item, editor, shell);
              }}
            >
              <span class="flex items-center gap-1.5">
                <Show when={checkable()}>
                  <span class="w-3 text-center">{command(item).checked?.(editor, shell) ? "✓" : ""}</span>
                </Show>
                {command(item).title?.(editor) ?? command(item).label}
              </span>
              <span class="text-dim">{command(item).shortcuts ? formatShortcut(command(item).shortcuts![0], isMac) : ""}</span>
            </button>
          )
        }
      </For>
    </div>
  );
}

export function MenuBar() {
  const [open, setOpen] = createSignal<string | null>(null);
  // The whole bar is each menu's trigger: its titles switch between menus.
  let bar!: HTMLDivElement;

  return (
    <div ref={bar} class="flex h-7 items-center border-b border-line bg-panel px-1" role="menubar">
      <div class="mr-2 px-2 font-semibold tracking-wide text-white/90">Picturestore</div>
      <For each={MENUS}>
        {(menu) => (
          <div class="relative">
            <button
              type="button"
              role="menuitem"
              class={["rounded-sm px-2.5 py-1 hover:bg-raised", { "bg-raised": open() === menu.title }]}
              onClick={() => setOpen((o) => (o === menu.title ? null : menu.title))}
              onPointerEnter={() => open() && setOpen(menu.title)}
            >
              {menu.title}
            </button>
            <Popover open={open() === menu.title} onClose={() => setOpen(null)} trigger={() => bar} class="top-full left-0">
              <MenuList items={menu.items} onDone={() => setOpen(null)} />
            </Popover>
          </div>
        )}
      </For>
    </div>
  );
}

export type { MenuItem };
