import { For, Show, createSignal, useContext } from "solid-js";
import { toHex, type RGB } from "../core/color";
import { editTarget, maskTone } from "../core/document";
import { TOOL_GROUPS, type ToolInfo } from "../editor/tools";
import { ColorPicker } from "./ColorPicker";
import { Popover } from "./Popover";
import { AppContext } from "./context";
import { IconButton } from "./controls";
import { Icon } from "./icons";

/**
 * One toolbar slot: shows the group's current tool. A click (or a trackpad
 * tap) just selects it. Pressing and dragging off it opens a flyout of the
 * group's other tools — one gesture: slide onto a tool and release to pick
 * it. Right-click opens the flyout too.
 */
/** How long a press on a tool group's button opens its flyout, as in Photoshop. */
const HOLD_MS = 300;

function ToolGroup(props: { tools: readonly ToolInfo[]; open: boolean; onOpen: (open: boolean) => void }) {
  const { editor } = useContext(AppContext);
  const [last, setLast] = createSignal(props.tools[0]);
  const shown = () => props.tools.find((t) => t.id === editor.tool()) ?? last();
  /** Opened by a press (held, or dragged off): its release picks, and isn't also a click on the button. */
  let dragged = false;
  const choose = (t: ToolInfo) => {
    setLast(t);
    editor.setTool(t.id);
    props.onOpen(false);
  };
  let group!: HTMLDivElement;
  return (
    <div
      ref={group}
      class="relative"
      onContextMenu={(e) => {
        e.preventDefault();
        if (props.tools.length > 1) props.onOpen(true);
      }}
      onPointerDown={(e) => {
        if (props.tools.length < 2 || e.button !== 0) return;
        const button = group.getBoundingClientRect();
        let opened = false;
        const open = () => {
          if (opened) return;
          opened = dragged = true;
          props.onOpen(true);
        };
        // Held down (wherever the pointer has gone since), or dragged off the button. A click or
        // trackpad tap is released long before the hold, so it only selects the tool.
        const hold = setTimeout(open, HOLD_MS);
        const move = (m: PointerEvent) => {
          if (m.pointerId !== e.pointerId) return;
          if (m.clientX < button.left || m.clientX > button.right || m.clientY < button.top || m.clientY > button.bottom) open();
        };
        const end = (u: PointerEvent) => {
          if (u.pointerId !== e.pointerId) return;
          clearTimeout(hold);
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", end, true);
          window.removeEventListener("pointercancel", end, true);
          if (!opened) return; // a click: the button's onClick selects its tool
          const item = document.elementFromPoint(u.clientX, u.clientY)?.closest<HTMLElement>("[data-flyout-tool]");
          const tool = item && props.tools.find((t) => t.id === item.dataset.flyoutTool);
          if (tool && u.type === "pointerup") {
            u.stopPropagation();
            choose(tool);
          }
          // Released elsewhere: the flyout stays open for a click.
          setTimeout(() => (dragged = false), 0);
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", end, true);
        window.addEventListener("pointercancel", end, true);
      }}
    >
      <IconButton
        icon={shown().id}
        title={`${shown().label} (${shown().key.toUpperCase()})`}
        testId={`tool-${shown().id}`}
        active={editor.tool() === shown().id}
        onClick={() => !dragged && choose(shown())}
      />
      <Show when={props.tools.length > 1}>
        {/* Photoshop's flyout marker. */}
        <span class="pointer-events-none absolute right-0.5 bottom-0.5 size-0 border-t-[3px] border-l-[3px] border-t-transparent border-l-transparent border-r-[3px] border-b-[3px] border-r-fg/60 border-b-fg/60" />
      </Show>
      <Popover open={props.open} onClose={() => props.onOpen(false)} trigger={() => group} class="top-0 left-full ml-1">
        <div class="min-w-48 rounded-sm border border-line bg-panel-2 py-1 shadow-xl animate-fade-in" role="menu" data-testid="tool-flyout">
          <For each={props.tools}>
            {(t) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={shown().id === t.id ? "true" : "false"}
                data-testid={`flyout-${t.id}`}
                data-flyout-tool={t.id}
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
      </Popover>
    </div>
  );
}

export function Toolbar() {
  const { editor } = useContext(AppContext);
  const [picking, setPicking] = createSignal<"foreground" | "background" | null>(null);
  const [flyout, setFlyout] = createSignal<string | null>(null);
  let swatches!: HTMLDivElement;
  // While a mask is the target, the swatches show the greys that will be painted (as in Photoshop).
  const maskTargeted = () => {
    const d = editor.active()?.doc();
    return !!d && !!editTarget(d)?.mask;
  };
  const shown = (c: RGB) => (maskTargeted() ? maskTone(c) : c);

  return (
    <div class="relative flex w-10 flex-col items-center gap-0.5 border-r border-line bg-panel py-1.5" data-testid="toolbar">
      <For each={TOOL_GROUPS}>
        {(group) => (
          <ToolGroup
            tools={group}
            open={flyout() === group[0].key}
            onOpen={(open) => setFlyout(open ? group[0].key : null)}
          />
        )}
      </For>

      <div ref={swatches} class="relative mt-3 size-9" data-mask-target={maskTargeted() ? "" : undefined}>
        <button
          type="button"
          title="Background colour"
          data-testid="bg-swatch"
          class="absolute right-0 bottom-0 size-6 rounded-xs border border-white/60 shadow"
          style={{ "background-color": toHex(shown(editor.background())) }}
          onClick={() => setPicking("background")}
        />
        <button
          type="button"
          title="Foreground colour"
          data-testid="fg-swatch"
          class="absolute top-0 left-0 size-6 rounded-xs border border-white/60 shadow"
          style={{ "background-color": toHex(shown(editor.foreground())) }}
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

      {/* The swatches are its trigger: clicking the other one switches what's being picked. */}
      <Popover open={picking() !== null} onClose={() => setPicking(null)} trigger={() => swatches} class="top-40 left-full ml-1" testId="color-popover">
        <Show when={picking()} keyed>
          {(which) => (
            <ColorPicker
              title={which === "foreground" ? "Foreground colour" : "Background colour"}
              initial={which === "foreground" ? editor.foreground() : editor.background()}
              onChange={(c) => (which === "foreground" ? editor.setForeground(c) : editor.setBackground(c))}
              onClose={() => setPicking(null)}
            />
          )}
        </Show>
      </Popover>
    </div>
  );
}
