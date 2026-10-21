import { createSignal, onSettled } from "solid-js";
import { lengthToPixels, parseLength } from "../core/crop";
import type { Guide } from "../core/document";
import { Button } from "./controls";
import { dismissable } from "./Popover";

/**
 * View ▸ Guides ▸ New Guide, as in Photoshop: an orientation and a
 * position — pixels, or a length with a unit ("2 in", "5 cm") at the
 * document's resolution.
 */
export function NewGuideDialog(props: { resolution: number; onAdd: (orientation: Guide["orientation"], position: number) => void; onClose: () => void }) {
  const [orientation, setOrientation] = createSignal<Guide["orientation"]>("horizontal");
  let input!: HTMLInputElement;
  const ok = () => {
    const v = parseLength(input.value.trim().replace(/^-/, ""), "pixels");
    if (!v) return input.select();
    const px = lengthToPixels(v.value, v.unit, props.resolution);
    props.onAdd(orientation(), input.value.trim().startsWith("-") ? -px : px);
    props.onClose();
  };
  onSettled(() => {
    input.select();
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
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex w-[22rem] gap-4 rounded-sm border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-label="New Guide" data-testid="new-guide">
        <div class="flex-1 space-y-3">
          <fieldset class="rounded-sm border border-line px-3 pt-1 pb-2">
            <legend class="px-1 text-dim">Orientation</legend>
            {(["horizontal", "vertical"] as const).map((o) => (
              <label class="flex items-center gap-2">
                <input type="radio" name="guide-orientation" data-testid={`guide-${o}`} checked={orientation() === o} onChange={() => setOrientation(o)} />
                <span>{o === "horizontal" ? "Horizontal" : "Vertical"}</span>
              </label>
            ))}
          </fieldset>
          <label class="flex items-center gap-2">
            <span class="text-dim">Position:</span>
            <input ref={input} type="text" class="w-24 text-right" data-testid="guide-position" value="0 px" onKeyDown={(e) => e.stopPropagation()} />
          </label>
        </div>
        <div class="flex flex-col gap-2">
          <Button primary testId="guide-ok" onClick={ok}>
            OK
          </Button>
          <Button onClick={() => props.onClose()}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
