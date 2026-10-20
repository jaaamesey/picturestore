import { For, Show, createSignal, useContext } from "solid-js";
import { toHex } from "../core/color";
import { TOOLBAR } from "../editor/tools";
import { ColorPicker } from "./ColorPicker";
import { AppContext } from "./context";
import { IconButton } from "./controls";
import { Icon } from "./icons";

export function Toolbar() {
  const { editor } = useContext(AppContext);
  const [picking, setPicking] = createSignal<"foreground" | "background" | null>(null);

  return (
    <div class="relative flex w-10 flex-col items-center gap-0.5 border-r border-line bg-panel py-1.5" data-testid="toolbar">
      <For each={TOOLBAR}>
        {(t) => (
          <IconButton
            icon={t.id}
            title={`${t.label} (${t.key.toUpperCase()})`}
            testId={`tool-${t.id}`}
            active={editor.tool() === t.id}
            onClick={() => editor.setTool(t.id)}
          />
        )}
      </For>

      <div class="relative mt-3 size-9">
        <button
          type="button"
          title="Background colour"
          data-testid="bg-swatch"
          class="absolute right-0 bottom-0 size-6 rounded-xs border border-white/60 shadow"
          style={{ "background-color": toHex(editor.background()) }}
          onClick={() => setPicking("background")}
        />
        <button
          type="button"
          title="Foreground colour"
          data-testid="fg-swatch"
          class="absolute top-0 left-0 size-6 rounded-xs border border-white/60 shadow"
          style={{ "background-color": toHex(editor.foreground()) }}
          onClick={() => setPicking("foreground")}
        />
      </div>
      <div class="flex gap-1 text-dim">
        <button type="button" title="Switch colours (X)" class="hover:text-fg" onClick={() => editor.swapColors()}>
          <Icon name="swap" size={14} />
        </button>
        <button
          type="button"
          title="Default colours (D)"
          class="relative size-3.5 hover:opacity-80"
          onClick={() => editor.resetColors()}
        >
          <span class="absolute top-0 left-0 size-2 border border-white/60 bg-black" />
          <span class="absolute right-0 bottom-0 size-2 border border-white/60 bg-white" />
        </button>
      </div>

      <Show when={picking()} keyed>
        {(which) => (
          <div class="absolute top-40 left-full ml-1">
            <ColorPicker
              title={which === "foreground" ? "Foreground colour" : "Background colour"}
              initial={which === "foreground" ? editor.foreground() : editor.background()}
              onChange={(c) => (which === "foreground" ? editor.setForeground(c) : editor.setBackground(c))}
              onClose={() => setPicking(null)}
            />
          </div>
        )}
      </Show>
    </div>
  );
}
