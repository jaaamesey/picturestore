/**
 * List reordering, framework-agnostic: a FLIP animator for layout changes,
 * and pointer-driven sorting built on it.
 *
 * Both are progressive enhancement. Items are always laid out where the
 * framework renders them; motion is only a transform that decays to zero,
 * so an interrupted, failed or skipped animation can't leave anything
 * misplaced. With `prefers-reduced-motion`, things simply move.
 */

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The vertical translation an element is currently drawn with (inline style, transition or animation). */
function translateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0;
}

export interface FlipOptions {
  /** Selects the animated items among the container's children. */
  readonly items: string;
  /** Stable identity of an item across re-renders. */
  readonly key: (el: HTMLElement) => string | null;
  readonly duration?: number;
  readonly easing?: string;
}

export interface Flip {
  /**
   * Records where items are drawn right now, to animate from on the next
   * change (instead of from their last settled layout). For changes the
   * caller is about to cause, such as a drop.
   */
  capture(): void;
  /** Animates items from where they were drawn to where they're laid out now. */
  play(): void;
  dispose(): void;
}

/** Material-style standard easing: quick to start, gentle to settle. */
export const EASE_OUT = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * Animates items whenever the container's children change (reorders,
 * insertions, removals), whatever caused it — a drop, undo, a menu command.
 * Changes that interrupt a running animation continue from where items are
 * drawn, so motion never jumps.
 */
export function createFlip(container: HTMLElement, opts: FlipOptions): Flip {
  const duration = opts.duration ?? 220;
  const easing = opts.easing ?? EASE_OUT;
  /** Each item's layout position (offsetTop: transforms and scrolling don't affect it) when last settled. */
  let layout = new Map<string, number>();
  let captured: Map<string, number> | null = null;
  let frame = 0;

  const items = () => [...container.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.matches(opts.items));

  const measure = () => {
    layout = new Map();
    for (const el of items()) {
      const k = opts.key(el);
      if (k !== null) layout.set(k, el.offsetTop);
    }
  };

  function play() {
    cancelAnimationFrame(frame);
    const els = items();
    const from = new Map<HTMLElement, number>();
    let shared = 0;
    for (const el of els) {
      const k = opts.key(el);
      if (k === null) continue;
      // Where it's drawn: as captured, else its old layout plus whatever offset it's still animating by.
      const before = captured?.get(k) ?? (layout.has(k) ? layout.get(k)! + translateY(el) : undefined);
      if (before === undefined) continue;
      from.set(el, before);
      shared++;
    }
    captured = null;
    const animate = shared > 0 && !reducedMotion();
    const next = new Map<string, number>();
    for (const el of els) {
      const k = opts.key(el);
      if (k === null) continue;
      const now = el.offsetTop;
      next.set(k, now);
      if (!animate) continue;
      const before = from.get(el);
      if (before === undefined) {
        // New item amid existing ones: fade in. (A whole new list, e.g. another document, just appears.)
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.75, easing });
        continue;
      }
      const delta = before - now;
      for (const a of el.getAnimations()) if (a.id === "flip") a.cancel();
      if (Math.abs(delta) < 0.5) continue;
      const a = el.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration, easing });
      a.id = "flip";
    }
    layout = next;
  }

  const observer = new MutationObserver(() => play());
  observer.observe(container, { childList: true });
  measure();

  return {
    capture() {
      captured = new Map();
      for (const el of items()) {
        const k = opts.key(el);
        if (k !== null) captured.set(k, el.offsetTop + translateY(el));
      }
      // If nothing changes (dropped where it started), still settle from the captured positions.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => captured && play());
    },
    play,
    dispose() {
      observer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

export interface SortableOptions extends FlipOptions {
  /** Called on drop when the item moved: its key, and its old and new index in display order. */
  readonly onSort: (key: string, from: number, to: number) => void;
  /** Whether a press may start a drag (e.g. not on buttons or inputs). */
  readonly canStart?: (e: PointerEvent) => boolean;
  /** Pointer travel before a press becomes a drag, in CSS pixels. */
  readonly threshold?: number;
  /** How quickly other items make room. */
  readonly shiftDuration?: number;
}

interface Slot {
  readonly el: HTMLElement;
  readonly key: string;
  readonly top: number;
  readonly height: number;
}

const AUTOSCROLL_EDGE = 28;
const AUTOSCROLL_MAX = 14;

/**
 * Drag-to-reorder for a vertical list, in the modern style: the item lifts
 * and follows the pointer, the others slide aside to open the gap where it
 * would land, the list scrolls near its edges, and on drop the item settles
 * into its slot. Escape cancels. The container should be the scrolling
 * element; the dragged item gets a `data-dragging` attribute for styling.
 */
export function createSortable(container: HTMLElement, opts: SortableOptions) {
  const flip = createFlip(container, opts);
  const threshold = opts.threshold ?? 4;
  const shiftDuration = opts.shiftDuration ?? 180;

  let press: { el: HTMLElement; pointerId: number; x: number; y: number } | null = null;
  let drag: {
    el: HTMLElement;
    slots: Slot[];
    from: number;
    to: number;
    startY: number;
    startScroll: number;
    clientY: number;
  } | null = null;
  let scrollFrame = 0;

  const listItems = () => [...container.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.matches(opts.items));

  function begin(e: PointerEvent) {
    const el = press!.el;
    const key = opts.key(el);
    if (key === null) return void (press = null);
    // Start from settled layout: finish any in-flight motion.
    const els = listItems();
    for (const x of els) for (const a of x.getAnimations()) a.finish();
    const slots: Slot[] = [];
    for (const x of els) {
      const k = opts.key(x);
      if (k !== null) slots.push({ el: x, key: k, top: x.offsetTop, height: x.offsetHeight });
    }
    const from = slots.findIndex((s) => s.el === el);
    if (from < 0) return void (press = null);
    drag = { el, slots, from, to: from, startY: press!.y, startScroll: container.scrollTop, clientY: e.clientY };
    el.setAttribute("data-dragging", "");
    el.style.transition = "none";
    const ease = reducedMotion() ? "none" : `transform ${shiftDuration}ms ${EASE_OUT}`;
    for (const s of slots) if (s.el !== el) s.el.style.transition = ease;
    document.documentElement.style.cursor = "grabbing";
    document.documentElement.style.userSelect = "none";
    scrollFrame = requestAnimationFrame(autoscroll);
  }

  function update() {
    if (!drag) return;
    const { el, slots, from } = drag;
    const dy = drag.clientY - drag.startY + (container.scrollTop - drag.startScroll);
    el.style.transform = `translateY(${dy}px)`;
    // Its slot is decided by its centre crossing other items' midpoints (in their original layout).
    const centre = slots[from].top + slots[from].height / 2 + dy;
    let to = from;
    for (let i = from + 1; i < slots.length && centre > slots[i].top + slots[i].height / 2; i++) to = i;
    for (let i = from - 1; i >= 0 && centre < slots[i].top + slots[i].height / 2; i--) to = i;
    drag.to = to;
    const h = slots[from].height;
    slots.forEach((s, i) => {
      if (i === from) return;
      const shift = from < i && i <= to ? -h : to <= i && i < from ? h : 0;
      const t = shift ? `translateY(${shift}px)` : "";
      if (s.el.style.transform !== t) s.el.style.transform = t;
    });
  }

  function autoscroll() {
    if (!drag) return;
    const r = container.getBoundingClientRect();
    const y = drag.clientY;
    const speed =
      y < r.top + AUTOSCROLL_EDGE ? -AUTOSCROLL_MAX * Math.min(1, (r.top + AUTOSCROLL_EDGE - y) / AUTOSCROLL_EDGE)
      : y > r.bottom - AUTOSCROLL_EDGE ? AUTOSCROLL_MAX * Math.min(1, (y - (r.bottom - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE)
      : 0;
    if (speed) {
      const before = container.scrollTop;
      container.scrollTop += speed;
      if (container.scrollTop !== before) update();
    }
    scrollFrame = requestAnimationFrame(autoscroll);
  }

  /** Ends a drag: everything settles from where it's drawn into the (possibly new) order. */
  function end(commit: boolean) {
    const d = drag;
    drag = null;
    press = null;
    cancelAnimationFrame(scrollFrame);
    removeListeners();
    if (!d) return;
    flip.capture();
    for (const s of d.slots) {
      s.el.style.transition = "";
      s.el.style.transform = "";
    }
    d.el.removeAttribute("data-dragging");
    document.documentElement.style.cursor = "";
    document.documentElement.style.userSelect = "";
    // The press ends in a click on the item; it was a drag, not a click.
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (commit && d.to !== d.from) opts.onSort(d.slots[d.from].key, d.from, d.to);
  }

  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < threshold) return;
      begin(e);
      if (!drag) return;
    }
    e.preventDefault(); // no text selection while dragging
    drag.clientY = e.clientY;
    update();
  };
  const onUp = (e: PointerEvent) => {
    if (press && e.pointerId === press.pointerId) end(e.type === "pointerup");
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    end(false);
  };

  function removeListeners() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("keydown", onKey, { capture: true });
  }

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || press || drag) return;
    const el = (e.target as Element | null)?.closest<HTMLElement>(opts.items);
    if (!el || el.parentElement !== container || (opts.canStart && !opts.canStart(e))) return;
    press = { el, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, { capture: true });
  };
  container.addEventListener("pointerdown", onDown);

  // Re-rendered mid-drag (e.g. undo from the keyboard): the measured layout is stale, so let go.
  const guard = new MutationObserver(() => drag && end(false));
  guard.observe(container, { childList: true });

  return {
    dispose() {
      end(false);
      guard.disconnect();
      container.removeEventListener("pointerdown", onDown);
      flip.dispose();
    },
  };
}
