import { For, Match, Show, Switch, createEffect, createSignal, onSettled, useContext } from "solid-js";
import type { Vec2 } from "../core/geometry";
import { HANDLES, handlePoint, type TransformState } from "../core/transform";
import type { Overlay, ToolEvent } from "../editor/types";
import { docToScreen, screenToDoc, zoomAt } from "../editor/view";
import { createRenderer, type Renderer, type View } from "../gpu/renderer";
import { AppContext } from "./context";

declare global {
  interface Window {
    /** Debug/test hook. */
    __ps?: {
      editor?: unknown;
      renderer?: Renderer;
      settled?: () => Promise<void>;
      /** Reference (CPU) composite of the displayed document at a pixel. */
      pixel?: (x: number, y: number) => number[];
    };
  }
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

export function Viewport(props: { device: GPUDevice; readback: boolean }) {
  const { editor } = useContext(AppContext);
  let host!: HTMLDivElement;
  const [hover, setHover] = createSignal<ToolEvent | null>(null);
  const [spaceHeld, setSpaceHeld] = createSignal(false);
  let pan: { x: number; y: number; view: View } | null = null;
  let toolPointer: number | null = null;
  let needsRender = true;

  createEffect(
    () => {
      const s = editor.active();
      return s ? [s.displayed(), s.view(), s.floating()] : null;
    },
    () => {
      needsRender = true;
    },
  );

  const toEvent = (e: PointerEvent): ToolEvent => {
    const r = host.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const d = screenToDoc(editor.active()!.view(), screen);
    return {
      x: d.x,
      y: d.y,
      screenX: screen.x,
      screenY: screen.y,
      // Mice report 0.5 while pressed; only trust pens.
      pressure: e.pointerType === "pen" ? e.pressure : 1,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: e.ctrlKey || e.metaKey,
    };
  };

  const onPointerDown = (e: PointerEvent) => {
    const s = editor.active();
    if (!s) return;
    host.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && spaceHeld())) {
      pan = { x: e.clientX, y: e.clientY, view: s.view() };
      return;
    }
    if (e.button !== 0 || toolPointer !== null) return;
    toolPointer = e.pointerId;
    editor.pointerDown(toEvent(e));
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!editor.active()) return;
    if (pan) {
      editor.setView({ ...pan.view, panX: pan.view.panX + e.clientX - pan.x, panY: pan.view.panY + e.clientY - pan.y });
      return;
    }
    if (toolPointer === e.pointerId) {
      // Coalesced events give painting full input resolution at any frame rate.
      for (const c of e.getCoalescedEvents?.() ?? [e]) editor.pointerMove(toEvent(c));
    }
    setHover(toEvent(e));
  };

  const onPointerUp = (e: PointerEvent) => {
    if (pan) {
      pan = null;
      return;
    }
    if (toolPointer !== e.pointerId) return;
    toolPointer = null;
    editor.pointerUp(toEvent(e));
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = editor.active();
    if (!s) return;
    const v = s.view();
    const r = host.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002));
      editor.setView(zoomAt(v, v.zoom * factor, { x: e.clientX - r.left, y: e.clientY - r.top }));
    } else {
      const [dx, dy] = e.shiftKey ? [e.deltaY, e.deltaX] : [e.deltaX, e.deltaY];
      editor.setView({ ...v, panX: v.panX - dx, panY: v.panY - dy });
    }
  };

  // The device arrives asynchronously; an effect (unlike onSettled) can wait for it.
  createEffect(
    () => ({ device: props.device, readback: props.readback }),
    ({ device, readback }) => {
      // A canvas can only ever have one context type, so each renderer gets a fresh one.
      const canvas = document.createElement("canvas");
      canvas.className = "absolute inset-0 h-full w-full";
      canvas.dataset.testid = "canvas";
      host.prepend(canvas);
      const renderer = createRenderer(device, canvas, { readback });
      // Test hook: resolves once everything requested so far is on screen.
      const settled = async () => {
        while (needsRender) await new Promise(requestAnimationFrame);
        await renderer.settled();
      };
      window.__ps = { ...window.__ps, editor, renderer, settled };
      editor.onRenderRequest(() => (needsRender = true));
      needsRender = true;

      let raf = 0;
      let antsStep = -1;
      const frame = (t: number) => {
        raf = requestAnimationFrame(frame);
        const s = editor.active();
        if (!s) return;
        const doc = s.displayed();
        // Marching ants advance in steps rather than every frame, to save power.
        const step = doc.selection ? Math.floor(t / 120) : -1;
        if (!needsRender && step === antsStep) return;
        needsRender = false;
        antsStep = step;
        renderer.render({ ...doc, floating: s.floating() }, s.view(), step < 0 ? 0 : (step % 8) / 8);
      };
      raf = requestAnimationFrame(frame);
      return () => {
        cancelAnimationFrame(raf);
        renderer.destroy();
        canvas.remove();
      };
    },
  );

  onSettled(() => {
    const resize = new ResizeObserver(() => {
      editor.setViewportSize({ width: host.clientWidth, height: host.clientHeight });
      needsRender = true;
    });
    resize.observe(host);

    const key = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      setSpaceHeld(down);
    };
    const onKeyDown = key(true);
    const onKeyUp = key(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    host.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      resize.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      host.removeEventListener("wheel", onWheel);
    };
  });

  const cursor = () => (spaceHeld() || pan ? "grab" : editor.cursor(hover()));
  const brushRadius = () => {
    const t = editor.tool();
    if ((t !== "brush" && t !== "eraser") || spaceHeld()) return 0;
    return (editor.settings[t].size / 2) * (editor.active()?.view().zoom ?? 1);
  };

  return (
    <div
      ref={host}
      class="relative h-full w-full touch-none overflow-hidden"
      data-testid="viewport"
      style={{ cursor: cursor() }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Show when={editor.active()}>
        {(s) => (
          <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            <Show when={s().overlay()}>{(o) => <OverlayShape overlay={o()} view={s().view()} />}</Show>
            <Show when={hover() && brushRadius() > 0}>
              <circle
                cx={hover()!.screenX}
                cy={hover()!.screenY}
                r={Math.max(1, brushRadius())}
                fill="none"
                stroke="white"
                stroke-width="1"
                style={{ "mix-blend-mode": "difference" }}
              />
            </Show>
          </svg>
        )}
      </Show>
      <StatusBar hover={hover()} />
    </div>
  );
}

/** Marching-ants strokes: a white line under an animated black dash. */
const ANTS = ["ants-base", "ants-dash"] as const;

function OverlayShape(props: { overlay: Overlay; view: View }) {
  const pt = (p: Vec2) => docToScreen(props.view, p);
  return (
    <Switch>
      <Match when={props.overlay.kind === "marquee" && props.overlay}>
        {(m) => {
          const r = () => {
            const a = pt({ x: m().rect.x, y: m().rect.y });
            return { x: a.x, y: a.y, w: m().rect.w * props.view.zoom, h: m().rect.h * props.view.zoom };
          };
          return (
            <Show
              when={m().shape === "rect"}
              fallback={
                <For each={ANTS}>
                  {(cls) => <ellipse class={cls} cx={r().x + r().w / 2} cy={r().y + r().h / 2} rx={r().w / 2} ry={r().h / 2} />}
                </For>
              }
            >
              <For each={ANTS}>
                {(cls) => <rect class={cls} x={r().x + 0.5} y={r().y + 0.5} width={r().w} height={r().h} />}
              </For>
            </Show>
          );
        }}
      </Match>
      <Match when={props.overlay.kind === "lasso" && props.overlay}>
        {(l) => (
          <For each={ANTS}>
            {(cls) => <polyline class={cls} points={l().points.map((p) => `${pt(p).x},${pt(p).y}`).join(" ")} />}
          </For>
        )}
      </Match>
      <Match when={props.overlay.kind === "transform" && props.overlay}>
        {(t) => <TransformBox state={t().state} view={props.view} />}
      </Match>
    </Switch>
  );
}

function TransformBox(props: { state: TransformState; view: View }) {
  const pt = (hx: number, hy: number) => docToScreen(props.view, handlePoint(props.state, hx, hy));
  const outline = () =>
    [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)].map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <g data-testid="transform-box">
      <polygon points={outline()} fill="none" stroke="#2f7cf6" stroke-width="1" />
      <For each={HANDLES}>
        {([hx, hy]) => (
          <rect x={pt(hx, hy).x - 4} y={pt(hx, hy).y - 4} width="8" height="8" fill="white" stroke="#2f7cf6" stroke-width="1" />
        )}
      </For>
      <circle cx={pt(0, 0).x} cy={pt(0, 0).y} r="3" fill="none" stroke="#2f7cf6" />
    </g>
  );
}

function StatusBar(props: { hover: ToolEvent | null }) {
  const { editor } = useContext(AppContext);
  return (
    <Show when={editor.active()}>
      {(s) => (
        <div class="pointer-events-none absolute bottom-0 left-0 flex gap-4 bg-app/80 px-2 py-0.5 text-dim" data-testid="status">
          <span data-testid="zoom-level">{Math.round(s().view().zoom * 1000) / 10}%</span>
          <span>
            {s().doc().width} × {s().doc().height} px
          </span>
          <Show when={props.hover}>
            {(h) => (
              <span>
                {Math.floor(h().x)}, {Math.floor(h().y)}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
