import { For, createSignal, onSettled, untrack } from "solid-js";
import type { Anchor } from "../core/documentTransform";
import { Button, NumberField } from "./controls";
import { dismissable } from "./Popover";

const ANCHORS: readonly Anchor[] = [0, 0.5, 1].flatMap((y) => [0, 0.5, 1].map((x) => ({ x, y }) as Anchor));
const MAX = 300_000; // Photoshop's limit for PSB; the GPU shows larger documents at reduced quality

/**
 * Image ▸ Canvas Size, as in Photoshop: current size, new size (absolute or
 * Relative), and an anchor grid for where the existing content sits.
 */
export function CanvasSizeDialog(props: {
  width: number;
  height: number;
  onApply: (width: number, height: number, anchor: Anchor) => void;
  onClose: () => void;
}) {
  const [relative, setRelative] = createSignal(false);
  const [w, setW] = createSignal(untrack(() => props.width));
  const [h, setH] = createSignal(untrack(() => props.height));
  const [anchor, setAnchor] = createSignal<Anchor>({ x: 0.5, y: 0.5 });
  // Absolute target sizes, read synchronously on OK.
  let target = { w: untrack(() => props.width), h: untrack(() => props.height) };
  const base = () => (relative() ? { w: props.width, h: props.height } : { w: 0, h: 0 });
  const setSize = (axis: "w" | "h", v: number) => {
    target = { ...target, [axis]: base()[axis] + v };
    (axis === "w" ? setW : setH)(v);
  };
  const toggleRelative = (on: boolean) => {
    setRelative(on);
    setW(on ? target.w - props.width : target.w);
    setH(on ? target.h - props.height : target.h);
  };
  const ok = () => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    if (target.w >= 1 && target.h >= 1) props.onApply(target.w, target.h, anchor());
    props.onClose();
  };

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ok();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const remove = dismissable(() => props.onClose());
    return () => {
      remove();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });

  const arrow = (a: Anchor) => {
    const dx = Math.sign(a.x - anchor().x), dy = Math.sign(a.y - anchor().y);
    if (dx === 0 && dy === 0) return "●";
    return ["↖", "↑", "↗", "←", "", "→", "↙", "↓", "↘"][(dy + 1) * 3 + (dx + 1)];
  };

  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex w-[28rem] rounded-sm border border-line bg-panel shadow-2xl" role="dialog" aria-label="Canvas Size" data-testid="canvas-size">
        <div class="flex-1 space-y-3 p-4">
          <fieldset class="rounded-sm border border-line px-3 pt-1 pb-2">
            <legend class="px-1 text-dim">Current Size</legend>
            <div>
              Width: {props.width} px &nbsp; Height: {props.height} px
            </div>
          </fieldset>
          <fieldset class="space-y-2 rounded-sm border border-line px-3 pt-1 pb-3">
            <legend class="px-1 text-dim">New Size</legend>
            <NumberField label="Width" testId="canvas-width" value={w()} min={relative() ? 1 - props.width : 1} max={MAX} suffix="px" width="5rem" onChange={(v) => setSize("w", v)} />
            <NumberField label="Height" testId="canvas-height" value={h()} min={relative() ? 1 - props.height : 1} max={MAX} suffix="px" width="5rem" onChange={(v) => setSize("h", v)} />
            <label class="flex items-center gap-2">
              <input type="checkbox" data-testid="canvas-relative" checked={relative()} onChange={(e) => toggleRelative(e.currentTarget.checked)} />
              <span>Relative</span>
            </label>
            <div class="flex items-start gap-3">
              <span class="text-dim">Anchor:</span>
              <div class="grid grid-cols-3 gap-px" role="radiogroup" aria-label="Anchor">
                <For each={ANCHORS}>
                  {(a) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={a.x === anchor().x && a.y === anchor().y ? "true" : "false"}
                      data-testid={`canvas-anchor-${a.x}-${a.y}`}
                      class="grid size-6 place-items-center border border-line bg-panel-2 text-xs hover:bg-raised"
                      onClick={() => setAnchor(a)}
                    >
                      {arrow(a)}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </fieldset>
        </div>
        <div class="flex w-24 flex-col gap-2 border-l border-line p-3">
          <Button primary testId="canvas-ok" onClick={ok}>
            OK
          </Button>
          <Button onClick={() => props.onClose()}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
