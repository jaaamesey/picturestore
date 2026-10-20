import { For, Show, createEffect, createSignal, useContext } from "solid-js";
import { BLEND_MODES, type BlendMode } from "../../core/blend";
import { activeLayer, type Layer } from "../../core/document";
import { getPixel, type TileMap } from "../../core/tiles";
import { AppContext } from "../context";
import { IconButton, NumberField } from "../controls";
import { Icon } from "../icons";

const THUMB = 36;

/** Nearest-neighbour thumbnail, recomputed only when the layer's tiles change. */
function Thumbnail(props: { tiles: TileMap; width: number; height: number }) {
  let canvas!: HTMLCanvasElement;
  const size = () => {
    const s = THUMB / Math.max(props.width, props.height);
    return { w: Math.max(1, Math.round(props.width * s)), h: Math.max(1, Math.round(props.height * s)) };
  };
  createEffect(
    () => ({ tiles: props.tiles, ...size(), dw: props.width, dh: props.height }),
    ({ tiles, w, h, dw, dh }) => {
      canvas.width = w;
      canvas.height = h;
      const img = new ImageData(w, h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          img.data.set(getPixel(tiles, Math.floor(((x + 0.5) * dw) / w), Math.floor(((y + 0.5) * dh) / h)), (y * w + x) * 4);
      canvas.getContext("2d")!.putImageData(img, 0, 0);
    },
  );
  return (
    <div class="grid shrink-0 place-items-center" style={{ width: `${THUMB}px`, height: `${THUMB}px` }}>
      <canvas ref={canvas} class="checkerboard max-h-full max-w-full border border-line" />
    </div>
  );
}

function LayerRow(props: { layer: Layer; index: number; active: boolean; width: number; height: number }) {
  const { editor } = useContext(AppContext);
  const [editing, setEditing] = createSignal(false);
  return (
    <div
      role="option"
      aria-selected={props.active ? "true" : "false"}
      data-testid="layer-row"
      data-layer-name={props.layer.name}
      draggable={editing() ? "false" : "true"}
      class={[
        "flex h-11 items-center gap-1.5 border-b border-line px-1.5",
        props.active ? "bg-accent-soft" : "hover:bg-raised",
      ]}
      onClick={() => editor.selectLayer(props.layer.id)}
      onDragStart={(e) => e.dataTransfer!.setData("application/x-layer", props.layer.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const id = e.dataTransfer!.getData("application/x-layer");
        if (id) editor.moveLayer(id, props.index);
      }}
    >
      <button
        type="button"
        title={props.layer.visible ? "Hide layer" : "Show layer"}
        data-testid="layer-visibility"
        class={["grid size-6 place-items-center", props.layer.visible ? "text-fg" : "text-dim/40"]}
        onClick={(e) => {
          e.stopPropagation();
          editor.setLayerProps(props.layer.id, { visible: !props.layer.visible });
        }}
      >
        <Icon name="eye" size={15} />
      </button>
      <Thumbnail tiles={props.layer.tiles} width={props.width} height={props.height} />
      <Show
        when={editing()}
        fallback={
          <span class="flex-1 truncate" onDblClick={() => setEditing(true)}>
            {props.layer.name}
          </span>
        }
      >
        <input
          class="min-w-0 flex-1"
          value={props.layer.name}
          ref={(el) => queueMicrotask(() => el.select())}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            setEditing(false);
            if (name && name !== props.layer.name) editor.setLayerProps(props.layer.id, { name });
          }}
        />
      </Show>
    </div>
  );
}

export function LayersPanel() {
  const { editor } = useContext(AppContext);
  const doc = () => editor.active()?.doc();
  const current = () => (doc() ? activeLayer(doc()!) : undefined);
  // Panels list layers top-first; documents store them bottom-first.
  const rows = () => (doc() ? doc()!.layers.map((layer, index) => ({ layer, index })).reverse() : []);

  return (
    <section class="flex min-h-0 flex-1 flex-col" data-testid="layers-panel">
      <header class="border-b border-line bg-panel-2 px-2 py-1 font-semibold">Layers</header>
      <Show when={current()}>
        {(l) => (
          <div class="flex items-center gap-2 border-b border-line p-1.5">
            <select
              class="min-w-0 flex-1 capitalize"
              data-testid="blend-mode"
              value={l().blendMode}
              onChange={(e) => editor.setLayerProps(l().id, { blendMode: e.currentTarget.value as BlendMode })}
            >
              <For each={BLEND_MODES}>{(m) => <option value={m}>{m}</option>}</For>
            </select>
            <NumberField
              label="Opacity"
              testId="layer-opacity"
              value={Math.round(l().opacity * 100)}
              min={0}
              max={100}
              suffix="%"
              width="3rem"
              onChange={(v) => editor.setLayerProps(l().id, { opacity: v / 100 })}
            />
          </div>
        )}
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Layers">
        <For each={rows()} keyed={(r) => r.layer.id}>
          {(r) => (
            <LayerRow
              layer={r().layer}
              index={r().index}
              active={r().layer.id === doc()?.activeLayerId}
              width={doc()!.width}
              height={doc()!.height}
            />
          )}
        </For>
      </div>
      <footer class="flex justify-end gap-0.5 border-t border-line p-1">
        <IconButton icon="plus" title="New layer" testId="new-layer" disabled={!doc()} onClick={() => editor.newLayer()} />
        <IconButton icon="copy" title="Duplicate layer" disabled={!doc()} onClick={() => editor.duplicateLayer()} />
        <IconButton icon="merge" title="Merge down" disabled={!doc()} onClick={() => editor.mergeDown()} />
        <IconButton
          icon="trash"
          title="Delete layer"
          testId="delete-layer"
          disabled={(doc()?.layers.length ?? 0) < 2}
          onClick={() => editor.deleteLayer()}
        />
      </footer>
    </section>
  );
}
