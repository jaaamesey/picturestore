import { For, Show, createSignal, onSettled, useContext } from "solid-js";
import { toHex } from "../core/color";
import { TOOL_GROUPS, type ToolInfo } from "../editor/tools";
import { ColorPicker } from "./ColorPicker";
import { AppContext } from "./context";
import { IconButton } from "./controls";
import { Icon } from "./icons";

const HOLD_MS = 400;

/**
 * One toolbar slot: shows the group's current tool. Right-click, or press
 * and hold, opens a flyout of the other tools in the group (as in Photoshop).
 */
function ToolGroup(props: { tools: readonly ToolInfo[]; open: boolean; onOpen: (open: boolean) => void }) {
  const { editor } = useContext(AppContext);
  const [last, setLast] = createSignal(props.tools[0]);
  const shown = () => props.tools.find((t) => t.id === editor.tool()) ?? last();
  let hold = 0;
  const choose = (t: ToolInfo) => {
    setLast(t);
    editor.setTool(t.id);
    props.onOpen(false);
  };
  return (
    <div
      class="relative"
      onContextMenu={(e) => {
        e.preventDefault();
        if (props.tools.length > 1) props.onOpen(true);
      }}
      onPointerDown={() => {
        if (props.tools.length > 1) hold = window.setTimeout(() => props.onOpen(true), HOLD_MS);
      }}
      onPointerUp={() => clearTimeout(hold)}
      onPointerLeave={() => clearTimeout(hold)}
    >
      <IconButton
        icon={shown().id}
        title={`${shown().label} (${shown().key.toUpperCase()})`}
        testId={`tool-${shown().id}`}
        active={editor.tool() === shown().id}
        onClick={() => choose(shown())}
      />
      <Show when={props.tools.length > 1}>
        {/* Photoshop's flyout marker. */}
        <span class="pointer-events-none absolute right-0.5 bottom-0.5 size-0 border-t-[3px] border-l-[3px] border-t-transparent border-l-transparent border-r-[3px] border-b-[3px] border-r-fg/60 border-b-fg/60" />
      </Show>
      <Show when={props.open}>
        <div class="absolute top-0 left-full z-50 ml-1 min-w-48 rounded-sm border border-line bg-panel-2 py-1 shadow-xl" role="menu" data-testid="tool-flyout">
          <For each={props.tools}>
            {(t) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={shown().id === t.id ? "true" : "false"}
                data-testid={`flyout-${t.id}`}
                class="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent hover:text-white"
                onClick={() => choose(t)}
              >
                <Icon name={t.id} size={16} />
                <span class="flex-1">{t.label}</span>
                <span class="text-dim">{t.key.toUpperCase()}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function Toolbar() {
  const { editor } = useContext(AppContext);
  const [picking, setPicking] = createSignal<"foreground" | "background" | null>(null);
  const [flyout, setFlyout] = createSignal<string | null>(null);
  let bar!: HTMLDivElement;

  onSettled(() => {
    const close = (e: Event) => {
      if (!bar.querySelector("[data-testid=tool-flyout]")?.contains(e.target as Node)) setFlyout(null);
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
  });

  return (
    <div ref={bar} class="relative flex w-10 flex-col items-center gap-0.5 border-r border-line bg-panel py-1.5" data-testid="toolbar">
      <For each={TOOL_GROUPS}>
        {(group) => (
          <ToolGroup
            tools={group}
            open={flyout() === group[0].key}
            onOpen={(open) => setFlyout(open ? group[0].key : null)}
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
