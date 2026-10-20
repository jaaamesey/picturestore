import { For, Show, createSignal, onSettled, useContext } from "solid-js";
import { COMMANDS, formatShortcut } from "../editor/commands";
import { AppContext, isMac } from "./context";

type MenuItem = string | "-";

const MENUS: readonly { readonly title: string; readonly items: readonly MenuItem[] }[] = [
  {
    title: "File",
    items: ["file.new", "file.open", "-", "file.save", "-", "file.export.psd", "file.export.png", "file.export.jpeg", "file.export.webp", "-", "file.close"],
  },
  {
    title: "Edit",
    items: ["edit.undo", "edit.redo", "-", "edit.fillForeground", "edit.fillBackground", "edit.clear", "-", "edit.freeTransform"],
  },
  { title: "Layer", items: ["layer.new", "layer.duplicate", "layer.delete", "-", "layer.mergeDown"] },
  { title: "Select", items: ["select.all", "select.deselect", "select.inverse"] },
  { title: "View", items: ["view.zoomIn", "view.zoomOut", "-", "view.fit", "view.actual"] },
];

const EXPORT_PREFIX = "Export as ";

export function MenuBar() {
  const { editor, shell } = useContext(AppContext);
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
              <div class="absolute top-full left-0 z-50 min-w-56 rounded-sm border border-line bg-panel-2 py-1 shadow-xl" role="menu">
                <For each={menu.items}>
                  {(item) =>
                    item === "-" ? (
                      <div class="my-1 h-px bg-line" />
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        data-command={item}
                        disabled={COMMANDS[item].enabled ? !COMMANDS[item].enabled!(editor) : false}
                        class="flex w-full items-center justify-between gap-6 px-4 py-1 text-left hover:bg-accent hover:text-white disabled:text-dim disabled:hover:bg-transparent"
                        onClick={() => {
                          setOpen(null);
                          COMMANDS[item].run(editor, shell);
                        }}
                      >
                        <span>{item.startsWith("file.export.") ? EXPORT_PREFIX + COMMANDS[item].label : COMMANDS[item].label}</span>
                        <span class="text-dim">
                          {COMMANDS[item].shortcuts ? formatShortcut(COMMANDS[item].shortcuts![0], isMac) : ""}
                        </span>
                      </button>
                    )
                  }
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
