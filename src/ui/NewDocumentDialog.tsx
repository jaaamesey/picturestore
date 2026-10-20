import { For, createSignal } from "solid-js";
import type { NewDocumentOptions } from "../core/document";
import { Button, NumberField } from "./controls";

const PRESETS = [
  { name: "Full HD", w: 1920, h: 1080 },
  { name: "HD", w: 1280, h: 720 },
  { name: "Square", w: 1080, h: 1080 },
  { name: "4K UHD", w: 3840, h: 2160 },
  { name: "A4 @ 300 dpi", w: 2480, h: 3508 },
  { name: "800 × 600", w: 800, h: 600 },
] as const;

type Background = "white" | "black" | "transparent";

export function NewDocumentDialog(props: { onCreate: (opts: NewDocumentOptions, name: string) => void; onClose: () => void }) {
  const [width, setWidth] = createSignal(1280);
  const [height, setHeight] = createSignal(720);
  const [background, setBackground] = createSignal<Background>("white");
  const [name, setName] = createSignal("Untitled");

  const create = () =>
    props.onCreate(
      {
        width: width(),
        height: height(),
        background: { white: { r: 255, g: 255, b: 255 }, black: { r: 0, g: 0, b: 0 }, transparent: null }[background()],
      },
      name().trim() || "Untitled",
    );

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") props.onClose();
        if (e.key === "Enter") create();
      }}
    >
      <div class="w-[30rem] rounded-sm border border-line bg-panel shadow-2xl" role="dialog" aria-label="New project" data-testid="new-dialog">
        <header class="border-b border-line px-4 py-2 text-sm font-semibold">New Project</header>
        <div class="grid grid-cols-[1fr_12rem] gap-4 p-4">
          <div class="grid grid-cols-2 gap-1.5 self-start">
            <For each={PRESETS}>
              {(p) => (
                <button
                  type="button"
                  class={[
                    "rounded-sm border border-line px-2 py-2 text-left hover:bg-raised",
                    { "border-accent": width() === p.w && height() === p.h },
                  ]}
                  onClick={() => {
                    setWidth(p.w);
                    setHeight(p.h);
                  }}
                >
                  <div>{p.name}</div>
                  <div class="text-dim">
                    {p.w} × {p.h}
                  </div>
                </button>
              )}
            </For>
          </div>
          <div class="flex flex-col gap-2.5">
            <label class="flex flex-col gap-1">
              <span class="text-dim">Name</span>
              <input value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            </label>
            <NumberField label="Width" testId="new-width" value={width()} min={1} max={16384} suffix="px" width="5rem" onChange={setWidth} />
            <NumberField label="Height" testId="new-height" value={height()} min={1} max={16384} suffix="px" width="5rem" onChange={setHeight} />
            <label class="flex items-center justify-between gap-2">
              <span class="text-dim">Background</span>
              <select value={background()} onChange={(e) => setBackground(e.currentTarget.value as Background)} data-testid="new-background">
                <option value="white">White</option>
                <option value="black">Black</option>
                <option value="transparent">Transparent</option>
              </select>
            </label>
          </div>
        </div>
        <footer class="flex justify-end gap-2 border-t border-line px-4 py-2">
          <Button onClick={props.onClose}>Cancel</Button>
          <Button primary onClick={create} testId="new-create">
            Create
          </Button>
        </footer>
      </div>
    </div>
  );
}
