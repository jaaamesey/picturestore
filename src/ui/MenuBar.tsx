import { For, Show, createSignal, onSettled, useContext } from "solid-js";
import { command, formatShortcut, isEnabled, runCommand, type CommandId } from "../editor/commands";
import { AppContext, isMac } from "./context";

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

/** Right-click on a layer (and on the canvas, outside selection tools). */
export const LAYER_MENU: readonly MenuItem[] = [
  "layer.duplicate",
  "layer.delete",
  "-",
  "layer.convertToSmart",
  "layer.editContents",
  "layer.rasterize",
  "-",
  "layer.mergeDown",
];

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
    ],
  },
  {
    title: "Layer",
    items: [
      "layer.new",
      "layer.duplicate",
      "layer.delete",
      "-",
      "layer.viaCopy",
      "layer.viaCut",
      "-",
      { submenu: "Smart Objects", items: ["layer.convertToSmart", "layer.editContents"] },
      "layer.rasterize",
      "-",
      "layer.mergeDown",
    ],
  },
  { title: "Select", items: ["select.all", "select.deselect", "select.inverse"] },
  { title: "View", items: ["view.zoomIn", "view.zoomOut", "-", "view.fit", "view.actual"] },
];

/** A dropdown list of commands; used by the menu bar and context menus. */
export function MenuList(props: { items: readonly MenuItem[]; onDone: () => void }) {
  const { editor, shell } = useContext(AppContext);
  const [openSub, setOpenSub] = createSignal<string | null>(null);
  return (
    <div class="min-w-56 rounded-sm border border-line bg-panel-2 py-1 shadow-xl" role="menu">
      <For each={props.items}>
        {(item) =>
          item === "-" ? (
            <div class="my-1 h-px bg-line" />
          ) : typeof item === "object" ? (
            <div class="relative" onPointerEnter={() => setOpenSub(item.submenu)} onPointerLeave={() => setOpenSub(null)}>
              <div role="menuitem" aria-haspopup="menu" class="flex justify-between px-4 py-1 hover:bg-accent hover:text-white">
                <span>{item.submenu}</span>
                <span>▸</span>
              </div>
              <Show when={openSub() === item.submenu}>
                <div class="absolute top-0 left-full z-50 -mt-1">
                  <MenuList items={item.items} onDone={props.onDone} />
                </div>
              </Show>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              data-command={item}
              disabled={!isEnabled(item, editor)}
              class="flex w-full items-center justify-between gap-6 px-4 py-1 text-left hover:bg-accent hover:text-white disabled:text-dim disabled:hover:bg-transparent"
              onClick={() => {
                props.onDone();
                runCommand(item, editor, shell);
              }}
            >
              <span>{command(item).label}</span>
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
  let bar!: HTMLDivElement;

  onSettled(() => {
    const close = (e: Event) => {
      if (!bar.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  });

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
            <Show when={open() === menu.title}>
              <div class="absolute top-full left-0 z-50">
                <MenuList items={menu.items} onDone={() => setOpen(null)} />
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

export type { MenuItem };
