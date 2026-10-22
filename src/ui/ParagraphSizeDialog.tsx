import { onSettled } from "solid-js";
import type { TypeUnit } from "../editor/preferences";
import { formatTypeLength, parseTypeLength } from "../text/units";
import { Button } from "./controls";
import { dismissable } from "./Popover";

/**
 * Paragraph Text Size (Alt-click or Alt-drag with a Type tool, as in
 * Photoshop): the paragraph box's width and height, in the type unit or any
 * length typed with its unit.
 */
export function ParagraphSizeDialog(props: { unit: TypeUnit; resolution: number; onAnswer: (size: { width: number; height: number } | null) => void }) {
  let width!: HTMLInputElement, height!: HTMLInputElement;
  const ok = () => {
    const w = parseTypeLength(width.value, props.unit, props.resolution), h = parseTypeLength(height.value, props.unit, props.resolution);
    if (!w || w <= 0) return width.select();
    if (!h || h <= 0) return height.select();
    props.onAnswer({ width: w, height: h });
  };
  onSettled(() => {
    width.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ok();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const remove = dismissable(() => props.onAnswer(null));
    return () => {
      remove();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });
  const initial = (px: number) => formatTypeLength(px, props.unit, props.resolution);
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex w-[22rem] gap-4 rounded-sm border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-label="Paragraph Text Size" data-testid="paragraph-size">
        <div class="flex-1 space-y-2">
          <label class="flex items-center gap-2">
            <span class="w-14 text-dim">Width:</span>
            <input ref={width} type="text" class="w-28 text-right" data-testid="paragraph-width" value={initial(200)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <label class="flex items-center gap-2">
            <span class="w-14 text-dim">Height:</span>
            <input ref={height} type="text" class="w-28 text-right" data-testid="paragraph-height" value={initial(100)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
        </div>
        <div class="flex flex-col gap-2">
          <Button primary testId="paragraph-size-ok" onClick={ok}>
            OK
          </Button>
          <Button onClick={() => props.onAnswer(null)}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
