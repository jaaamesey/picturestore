import { For, Show, createSignal, onSettled, untrack } from "solid-js";
import type { RGB } from "../core/color";
import type { SelectionMode } from "../core/selection";
import type { Editor } from "../editor/editor";
import { Button, NumberField } from "./controls";
import { dismissable } from "./Popover";

/**
 * The Paths panel's dialogs — Make Selection, Make Work Path, Fill Path,
 * Stroke Path — and Panel Options. Each remembers what it was last given:
 * the panel's buttons act with those settings, and Alt-click opens the dialog.
 */

export type PathDialogKind = "makeSelection" | "makeWorkPath" | "fillPath" | "strokePath" | "panelOptions";

export const pathOptions = {
  makeSelection: { feather: 0, antiAlias: true, operation: "replace" as SelectionMode },
  makeWorkPath: { tolerance: 2 },
  fillPath: { contents: "foreground" as FillContents, opacity: 100, feather: 0, antiAlias: true },
  strokePath: { tool: "brush" as "brush" | "eraser" },
};

export type FillContents = "foreground" | "background" | "black" | "white" | "gray";

export const FILL_CONTENTS: readonly { value: FillContents; label: string }[] = [
  { value: "foreground", label: "Foreground Color" },
  { value: "background", label: "Background Color" },
  { value: "black", label: "Black" },
  { value: "white", label: "White" },
  { value: "gray", label: "50% Gray" },
];

export const fillColor = (c: FillContents, fg: RGB, bg: RGB): RGB =>
  c === "foreground" ? fg : c === "background" ? bg : c === "black" ? { r: 0, g: 0, b: 0 } : c === "white" ? { r: 255, g: 255, b: 255 } : { r: 128, g: 128, b: 128 };

/** Thumbnail sizes (Panel Options), in pixels; none hides them. */
export const THUMBNAILS = { none: 0, small: 24, medium: 40, large: 64 } as const;
export type ThumbnailSize = keyof typeof THUMBNAILS;
const loadThumb = (): ThumbnailSize => {
  try {
    const v = localStorage.getItem("paths.thumbnail");
    if (v && v in THUMBNAILS) return v as ThumbnailSize;
  } catch {
    // Storage may be unavailable.
  }
  return "medium";
};
export const [thumbnailSize, setThumbnailSize] = createSignal<ThumbnailSize>(loadThumb());

/** Runs a path operation with the settings last used. */
export const runPathOperation = {
  makeSelection: (ed: Editor) => ed.paths.makeSelection({ ...pathOptions.makeSelection }),
  makeWorkPath: (ed: Editor) => ed.paths.makeWorkPath(pathOptions.makeWorkPath.tolerance),
  fillPath: (ed: Editor) => {
    const o = pathOptions.fillPath;
    ed.paths.fill({ color: fillColor(o.contents, ed.foreground(), ed.background()), opacity: o.opacity / 100, feather: o.feather, antiAlias: o.antiAlias });
  },
  strokePath: (ed: Editor) => ed.paths.stroke(pathOptions.strokePath.tool),
};

const TITLES: Record<PathDialogKind, string> = {
  makeSelection: "Make Selection",
  makeWorkPath: "Make Work Path",
  fillPath: "Fill Path",
  strokePath: "Stroke Path",
  panelOptions: "Paths Panel Options",
};

const OPERATIONS: readonly { mode: SelectionMode; label: string }[] = [
  { mode: "replace", label: "New Selection" },
  { mode: "add", label: "Add to Selection" },
  { mode: "subtract", label: "Subtract from Selection" },
  { mode: "intersect", label: "Intersect with Selection" },
];

export function PathDialog(props: { kind: PathDialogKind; editor: Editor; hasSelection: boolean; onClose: () => void }) {
  const o = untrack(() => pathOptions);
  const [feather, setFeather] = createSignal(props.kind === "fillPath" ? o.fillPath.feather : o.makeSelection.feather);
  const [antiAlias, setAntiAlias] = createSignal(props.kind === "fillPath" ? o.fillPath.antiAlias : o.makeSelection.antiAlias);
  const [operation, setOperation] = createSignal<SelectionMode>(props.hasSelection ? o.makeSelection.operation : "replace");
  const [tolerance, setTolerance] = createSignal(o.makeWorkPath.tolerance);
  const [contents, setContents] = createSignal<FillContents>(o.fillPath.contents);
  const [opacity, setOpacity] = createSignal(o.fillPath.opacity);
  const [tool, setTool] = createSignal(o.strokePath.tool);
  const [thumb, setThumb] = createSignal(thumbnailSize());

  const ok = () => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    switch (props.kind) {
      case "makeSelection":
        Object.assign(pathOptions.makeSelection, { feather: feather(), antiAlias: antiAlias(), operation: operation() });
        runPathOperation.makeSelection(props.editor);
        break;
      case "makeWorkPath":
        pathOptions.makeWorkPath.tolerance = tolerance();
        runPathOperation.makeWorkPath(props.editor);
        break;
      case "fillPath":
        Object.assign(pathOptions.fillPath, { contents: contents(), opacity: opacity(), feather: feather(), antiAlias: antiAlias() });
        runPathOperation.fillPath(props.editor);
        break;
      case "strokePath":
        pathOptions.strokePath.tool = tool();
        runPathOperation.strokePath(props.editor);
        break;
      case "panelOptions":
        setThumbnailSize(thumb());
        try {
          localStorage.setItem("paths.thumbnail", thumb());
        } catch {
          // Not remembered.
        }
    }
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

  const softEdges = () => (
    <>
      <NumberField label="Feather Radius" testId="path-feather" value={feather()} min={0} max={1000} step={0.5} suffix="px" width="5rem" onChange={setFeather} />
      <label class="flex items-center gap-2">
        <input type="checkbox" data-testid="path-antialias" checked={antiAlias()} onChange={(e) => setAntiAlias(e.currentTarget.checked)} />
        <span>Anti-aliased</span>
      </label>
    </>
  );

  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex w-[26rem] rounded-sm border border-line bg-panel shadow-2xl" role="dialog" aria-label={TITLES[props.kind]} data-testid="path-dialog">
        <div class="flex-1 space-y-3 p-4">
          <Show when={props.kind === "makeSelection"}>
            <fieldset class="space-y-2 rounded-sm border border-line px-3 pt-1 pb-3">
              <legend class="px-1 text-dim">Rendering</legend>
              {softEdges()}
            </fieldset>
            <fieldset class="space-y-1 rounded-sm border border-line px-3 pt-1 pb-3">
              <legend class="px-1 text-dim">Operation</legend>
              <For each={OPERATIONS}>
                {(m) => (
                  <label class={["flex items-center gap-2", { "opacity-40": m.mode !== "replace" && !props.hasSelection }]}>
                    <input
                      type="radio"
                      name="path-operation"
                      data-testid={`path-operation-${m.mode}`}
                      disabled={m.mode !== "replace" && !props.hasSelection}
                      checked={operation() === m.mode}
                      onChange={() => setOperation(m.mode)}
                    />
                    <span>{m.label}</span>
                  </label>
                )}
              </For>
            </fieldset>
          </Show>
          <Show when={props.kind === "makeWorkPath"}>
            <p class="text-dim">Tolerance: how closely the path follows the selection's edge; higher gives fewer anchor points.</p>
            <NumberField label="Tolerance" testId="path-tolerance" value={tolerance()} min={0.5} max={10} step={0.5} suffix="px" width="5rem" onChange={setTolerance} />
          </Show>
          <Show when={props.kind === "fillPath"}>
            <fieldset class="space-y-2 rounded-sm border border-line px-3 pt-1 pb-3">
              <legend class="px-1 text-dim">Contents</legend>
              <label class="flex items-center gap-2">
                <span class="text-dim">Use:</span>
                <select data-testid="path-fill-contents" value={contents()} onChange={(e) => setContents(e.currentTarget.value as FillContents)}>
                  <For each={FILL_CONTENTS}>{(c) => <option value={c.value}>{c.label}</option>}</For>
                </select>
              </label>
            </fieldset>
            <fieldset class="space-y-2 rounded-sm border border-line px-3 pt-1 pb-3">
              <legend class="px-1 text-dim">Blending</legend>
              <NumberField label="Opacity" testId="path-fill-opacity" value={opacity()} min={1} max={100} suffix="%" width="5rem" onChange={setOpacity} />
            </fieldset>
            <fieldset class="space-y-2 rounded-sm border border-line px-3 pt-1 pb-3">
              <legend class="px-1 text-dim">Rendering</legend>
              {softEdges()}
            </fieldset>
          </Show>
          <Show when={props.kind === "strokePath"}>
            <label class="flex items-center gap-2">
              <span class="text-dim">Tool:</span>
              <select data-testid="path-stroke-tool" value={tool()} onChange={(e) => setTool(e.currentTarget.value as "brush" | "eraser")}>
                <option value="brush">Brush</option>
                <option value="eraser">Eraser</option>
              </select>
            </label>
          </Show>
          <Show when={props.kind === "panelOptions"}>
            <fieldset class="space-y-1 rounded-sm border border-line px-3 pt-1 pb-3">
              <legend class="px-1 text-dim">Thumbnail Size</legend>
              <For each={Object.keys(THUMBNAILS) as ThumbnailSize[]}>
                {(t) => (
                  <label class="flex items-center gap-2 capitalize">
                    <input type="radio" name="path-thumbnail" data-testid={`path-thumbnail-${t}`} checked={thumb() === t} onChange={() => setThumb(t)} />
                    <span>{t}</span>
                  </label>
                )}
              </For>
            </fieldset>
          </Show>
        </div>
        <div class="flex w-24 flex-col gap-2 border-l border-line p-3">
          <Button primary testId="path-dialog-ok" onClick={ok}>
            OK
          </Button>
          <Button onClick={() => props.onClose()}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
