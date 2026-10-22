import { For, Show, createMemo, createSignal, useContext } from "solid-js";
import { activeLayer } from "../../core/document";
import { vec } from "../../core/geometry";
import type { VectorPath } from "../../core/path";
import { pathData } from "../../core/pathSvg";
import { effectiveTarget, pathOf } from "../../editor/tools/pathEdit";
import type { PathTarget } from "../../editor/types";
import { AppContext } from "../context";
import { IconButton } from "../controls";
import { THUMBNAILS, runPathOperation, thumbnailSize } from "../PathDialogs";

interface Row {
  readonly target: PathTarget;
  readonly name: string;
  readonly path: VectorPath;
  /** The work path and a shape's path are shown in italics: they can't be renamed. */
  readonly temporary: boolean;
}

const same = (a: PathTarget | null, b: PathTarget | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === "work" || (a as { id?: string; layerId?: string }).id === (b as { id?: string }).id) && (a.kind !== "layer" || a.layerId === (b as { layerId?: string }).layerId);

/** A path drawn to fit a thumbnail of the document's proportions. */
function Thumbnail(props: { path: VectorPath; width: number; height: number; size: number }) {
  const scale = () => props.size / Math.max(props.width, props.height);
  const w = () => props.width * scale(), h = () => props.height * scale();
  return (
    <svg width={w()} height={h()} class="shrink-0 border border-line bg-white" aria-hidden="true">
      <path d={pathData(props.path, (p) => vec(p.x * scale(), p.y * scale()))} fill="rgba(0,0,0,.35)" stroke="black" stroke-width="1" />
    </svg>
  );
}

/**
 * The Paths panel, as in Photoshop: the saved paths, the work path
 * (italic; it is replaced when another is drawn unless saved) and the active
 * shape layer's path. Click a path to select it; double-click a saved path
 * to rename it, the work path to save it. The buttons fill, stroke, load as
 * a selection, make a work path from the selection, add a path and delete;
 * Alt-click one that has a dialog to open it.
 */
export function PathsPanel(props: { onDialog: (kind: "makeSelection" | "makeWorkPath" | "fillPath" | "strokePath") => void }) {
  const { editor } = useContext(AppContext);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const doc = () => editor.active()?.doc();
  const rows = createMemo((): Row[] => {
    const d = doc();
    if (!d) return [];
    const out: Row[] = (d.paths ?? []).map((p) => ({ target: { kind: "saved", id: p.id }, name: p.name, path: p.path, temporary: false }));
    if (d.workPath) out.push({ target: { kind: "work" }, name: "Work Path", path: d.workPath, temporary: true });
    const l = activeLayer(d);
    if (l && (l.content.kind === "shape" || l.vectorMask)) {
      const target: PathTarget = { kind: "layer", layerId: l.id };
      const path = pathOf(d, target);
      if (path) out.push({ target, name: l.content.kind === "shape" ? `${l.name} Shape Path` : `${l.name} Vector Mask`, path, temporary: true });
    }
    return out;
  });
  const selected = () => {
    const s = editor.active();
    const d = s?.doc();
    return d && s ? effectiveTarget(d, s.paths()) : null;
  };
  const size = () => THUMBNAILS[thumbnailSize()];
  const act = (kind: "makeSelection" | "makeWorkPath" | "fillPath" | "strokePath") => (e: MouseEvent) => (e.altKey ? props.onDialog(kind) : runPathOperation[kind](editor));
  const hasPath = () => !!selected();
  const savePath = () => {
    editor.paths.savePath();
    const t = editor.active()?.paths().target;
    if (t?.kind === "saved") setRenaming(t.id);
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="paths-panel">
      <div class="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Paths" onClick={(e) => e.target === e.currentTarget && editor.paths.select(null)}>
        <For each={rows()}>
          {(row) => (
            <div
              role="option"
              data-testid="path-row"
              data-kind={row.target.kind}
              aria-selected={same(selected(), row.target) ? "true" : "false"}
              class={["flex items-center gap-2 px-2 py-1", same(selected(), row.target) ? "bg-accent-soft" : "hover:bg-raised"]}
              onClick={() => editor.paths.select(row.target)}
              onDblClick={() => (row.target.kind === "work" ? savePath() : row.target.kind === "saved" && setRenaming(row.target.id))}
            >
              <Show when={size() > 0}>
                <Thumbnail path={row.path} width={doc()!.width} height={doc()!.height} size={size()} />
              </Show>
              <Show
                when={row.target.kind === "saved" && renaming() === (row.target as { id: string }).id}
                fallback={<span class={["truncate", { italic: row.temporary }]}>{row.name}</span>}
              >
                <input
                  data-testid="path-rename"
                  class="min-w-0 flex-1 bg-panel-2 px-1"
                  value={row.name}
                  ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (editor.paths.rename((row.target as { id: string }).id, e.currentTarget.value), setRenaming(null));
                    else if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="flex items-center justify-end gap-0.5 border-t border-line px-1 py-0.5">
        <IconButton icon="bucket" title="Fill path with foreground color (Alt-click for options)" testId="paths-fill" disabled={!hasPath()} onClick={act("fillPath")} />
        <IconButton icon="brush" title="Stroke path with brush (Alt-click for options)" testId="paths-stroke" disabled={!hasPath()} onClick={act("strokePath")} />
        <IconButton icon="marquee-ellipse" title="Load path as a selection (Alt-click for options)" testId="paths-selection" disabled={!hasPath()} onClick={act("makeSelection")} />
        <IconButton icon="lasso" title="Make work path from selection (Alt-click for options)" testId="paths-work" disabled={!doc()?.selection} onClick={act("makeWorkPath")} />
        <IconButton icon="plus" title="Create new path" testId="paths-new" disabled={!doc()} onClick={() => editor.paths.newPath()} />
        <IconButton
          icon="trash"
          title="Delete current path"
          testId="paths-delete"
          disabled={!selected() || selected()!.kind === "layer"}
          onClick={() => selected() && editor.paths.remove(selected()!)}
        />
      </div>
    </div>
  );
}

