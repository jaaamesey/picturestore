import type { JSX } from "@solidjs/web";
import { Show, onSettled } from "solid-js";

/**
 * Every floating panel — menus, context menus, flyouts, colour pickers,
 * settings popovers — is a Popover, and Popover alone decides when one
 * closes, so none can forget to:
 *
 *  - a press anywhere outside it closes it, except on its `trigger` (so the
 *    trigger can toggle it without closing and instantly reopening it);
 *  - Escape closes the topmost one only (dialogs share the same stack, see
 *    {@link dismissable}), and goes no further (it would otherwise cancel
 *    the active tool);
 *  - a popover opened from inside another (a submenu, a picker in a panel)
 *    is inside it, so using it doesn't close its parent.
 *
 * It only positions and dismisses: content draws its own panel.
 */
export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Presses on these don't count as outside: the control that opens it. */
  readonly trigger?: () => Element | null | undefined;
  /** Positioning (relative to the nearest positioned ancestor), e.g. "top-full left-0 mt-1". */
  readonly class?: string;
  readonly style?: JSX.CSSProperties;
  /** "fixed" for panels placed at viewport coordinates (context menus). */
  readonly fixed?: boolean;
  readonly testId?: string;
  readonly children: JSX.Element;
}

/**
 * Open layers (dialogs and popovers), innermost last. Escape closes the
 * last one only — a popover inside a dialog before the dialog.
 */
interface Layer {
  readonly panel: HTMLElement | null;
  readonly close: () => void;
}
const stack: Layer[] = [];

function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  stack[stack.length - 1].close();
}

/**
 * Registers something Escape should close (a dialog, a popover) as the
 * topmost layer; returns its removal. Call while it's open (e.g. from
 * `onSettled`, returning the result as cleanup).
 */
export function dismissable(close: () => void, panel: HTMLElement | null = null): () => void {
  const entry: Layer = { panel, close };
  stack.push(entry);
  if (stack.length === 1) window.addEventListener("keydown", onEscape, { capture: true });
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    if (stack.length === 0) window.removeEventListener("keydown", onEscape, { capture: true });
  };
}

function Panel(props: PopoverProps) {
  let panel!: HTMLDivElement;
  onSettled(() => {
    const remove = dismissable(() => props.onClose(), panel);
    const outside = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || panel.contains(t) || props.trigger?.()?.contains(t)) return;
      // Layers opened above this one (a nested popover placed outside it, a dialog it opened) count as inside.
      const above = stack.slice(stack.findIndex((l) => l.panel === panel) + 1);
      if (above.some((l) => !l.panel || l.panel.contains(t))) return;
      props.onClose();
    };
    window.addEventListener("pointerdown", outside, { capture: true });
    return () => {
      remove();
      window.removeEventListener("pointerdown", outside, { capture: true });
    };
  });
  return (
    <div ref={panel} class={[props.fixed ? "fixed" : "absolute", "z-50", props.class]} style={props.style} data-testid={props.testId} data-popover="">
      {props.children}
    </div>
  );
}

export function Popover(props: PopoverProps) {
  return (
    <Show when={props.open}>
      <Panel {...props} />
    </Show>
  );
}
