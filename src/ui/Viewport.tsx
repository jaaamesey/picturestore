import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onSettled, useContext } from "solid-js";
import type { Rect, Vec2 } from "../core/geometry";
import type { transformFloatingCpu } from "../core/raster";
import type { readRect } from "../core/tiles";
import { handles, initialTransform, warpPoints, type TransformMode, type TransformState } from "../core/transform";
import { IDENTITY_PATCH, PATCH_ANCHORS, evalPatch, project, squareToQuad } from "../core/warp";
import { moveBox } from "../editor/tools/transform";
import type { Overlay, ToolEvent } from "../editor/types";
import { docToScreen, screenToDoc, zoomAt } from "../editor/view";
import { createRenderer, type Renderer, type View } from "../gpu/renderer";
import { AppContext } from "./context";
import { MenuList, TRANSFORM_MENU } from "./MenuBar";

declare global {
  interface Window {
    /** Debug/test hook. */
    __ps?: {
      editor?: unknown;
      renderer?: Renderer;
      settled?: () => Promise<void>;
      /** Reference (CPU) composite of the displayed document at a pixel. */
      pixel?: (x: number, y: number) => number[];
      /** CPU reference implementations, for GPU parity tests. */
      reference?: { transformFloatingCpu: typeof transformFloatingCpu; readRect: typeof readRect };
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
  // Double-click detection (pointerdown's `detail` isn't reliable across browsers).
  let lastDown = { time: 0, x: 0, y: 0, clicks: 0 };
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);

  createEffect(
    () => {
      const s = editor.active();
      return s ? [s.displayed(), s.view(), s.floating()] : null;
    },
    () => {
      needsRender = true;
    },
  );

  const toEvent = (e: PointerEvent, clicks = 1): ToolEvent => {
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
      clicks,
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
    setMenu(null);
    const repeat = e.timeStamp - lastDown.time < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 5;
    lastDown = { time: e.timeStamp, x: e.clientX, y: e.clientY, clicks: repeat ? lastDown.clicks + 1 : 1 };
    toolPointer = e.pointerId;
    editor.pointerDown(toEvent(e, lastDown.clicks));
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
      editor.setResampler(renderer.resample);
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
        editor.setResampler(null);
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
    // With the context menu open, Escape only closes the menu (it would otherwise cancel the transform).
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !menu()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMenu(null);
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    host.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      resize.disconnect();
      window.removeEventListener("keydown", onEscape, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      host.removeEventListener("wheel", onWheel);
    };
  });

  const cursor = () => (editor.busy() ? "progress" : spaceHeld() || pan ? "grab" : editor.cursor(hover()));

  /** The Move tool's always-on transform controls, when no transform is in progress. */
  const moveControls = createMemo(() => {
    const s = editor.active();
    if (!s || editor.tool() !== "move" || !editor.settings.transform.showControls || s.overlay() || s.floating()) return null;
    return moveBox(s.doc());
  });
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
      onContextMenu={(e) => {
        e.preventDefault();
        // Right-clicking during a transform offers the transform modes, as in Photoshop.
        if (editor.tool() !== "transform") return;
        const r = host.getBoundingClientRect();
        setMenu({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
    >
      <Show when={editor.active()}>
        {(s) => (
          <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            <Show when={s().overlay()}>
              {(o) => <OverlayShape overlay={o()} view={s().view()} showReference={editor.settings.transform.showReference} />}
            </Show>
            <Show when={moveControls()}>{(b) => <MoveControls box={b()} view={s().view()} />}</Show>
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
      <Show when={menu()}>
        {(m) => (
          <div class="absolute z-40" style={{ left: `${m().x}px`, top: `${m().y}px` }} onPointerDown={(e) => e.stopPropagation()} data-testid="transform-menu">
            <MenuList items={["edit.freeTransform", "-", ...TRANSFORM_MENU]} onDone={() => setMenu(null)} />
          </div>
        )}
      </Show>
    </div>
  );
}

/** Marching-ants strokes: a white line under an animated black dash. */
const ANTS = ["ants-base", "ants-dash"] as const;

function OverlayShape(props: { overlay: Overlay; view: View; showReference: boolean }) {
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
        {(t) => <TransformBox state={t().state} mode={t().mode} view={props.view} showReference={props.showReference} />}
      </Match>
    </Switch>
  );
}

const ACCENT = "#2f7cf6";
const pointsAttr = (pts: readonly Vec2[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

function Handle(props: { at: Vec2 }) {
  return <rect x={props.at.x - 3.5} y={props.at.y - 3.5} width="7" height="7" fill="white" stroke={ACCENT} stroke-width="1" />;
}

function TransformBox(props: { state: TransformState; mode: TransformMode; view: View; showReference: boolean }) {
  const pt = (p: Vec2) => docToScreen(props.view, p);
  const h = () => handles(props.state);
  return (
    <g data-testid="transform-box" data-mode={props.mode}>
      <Show
        when={props.mode === "warp"}
        fallback={
          <>
            <polygon points={pointsAttr(h().corners.map(pt))} fill="none" stroke={ACCENT} stroke-width="1" />
            <For each={[...h().corners, ...h().edges]}>{(p) => <Handle at={pt(p)} />}</For>
          </>
        }
      >
        <WarpMesh state={props.state} view={props.view} />
      </Show>
      <Show when={props.showReference && props.mode !== "warp"}>
        <g data-testid="reference-point">
          <circle cx={pt(props.state.reference).x} cy={pt(props.state.reference).y} r="5" fill="none" stroke="black" stroke-width="2.5" />
          <circle cx={pt(props.state.reference).x} cy={pt(props.state.reference).y} r="5" fill="none" stroke="white" stroke-width="1" />
        </g>
      </Show>
    </g>
  );
}

/** Warp grid: iso-curves at thirds, Bézier handle lines, anchors and control points. */
function WarpMesh(props: { state: TransformState; view: View }) {
  const H = () => squareToQuad(props.state.quad)!;
  const toScreen = (q: Vec2) => docToScreen(props.view, project(H(), q.x, q.y));
  const curve = (along: "s" | "t", at: number) => {
    const patch = props.state.patch ?? IDENTITY_PATCH;
    return pointsAttr(Array.from({ length: 33 }, (_, i) => toScreen(along === "s" ? evalPatch(patch, i / 32, at) : evalPatch(patch, at, i / 32))));
  };
  const points = () => warpPoints(props.state).map((p) => docToScreen(props.view, p));
  return (
    <g>
      <For each={[0, 1 / 3, 2 / 3, 1]}>
        {(at) => (
          <>
            <polyline points={curve("s", at)} fill="none" stroke={ACCENT} stroke-width="1" opacity={at === 0 || at === 1 ? 1 : 0.6} />
            <polyline points={curve("t", at)} fill="none" stroke={ACCENT} stroke-width="1" opacity={at === 0 || at === 1 ? 1 : 0.6} />
          </>
        )}
      </For>
      <For each={PATCH_ANCHORS}>
        {([a, h1, h2]) => (
          <>
            <line x1={points()[a].x} y1={points()[a].y} x2={points()[h1].x} y2={points()[h1].y} stroke={ACCENT} stroke-width="1" />
            <line x1={points()[a].x} y1={points()[a].y} x2={points()[h2].x} y2={points()[h2].y} stroke={ACCENT} stroke-width="1" />
          </>
        )}
      </For>
      <For each={Array.from({ length: 16 }, (_, k) => k)}>
        {(k) =>
          PATCH_ANCHORS.some((g) => g[0] === k) ? (
            <Handle at={points()[k]} />
          ) : (
            <circle cx={points()[k].x} cy={points()[k].y} r="3" fill="white" stroke={ACCENT} stroke-width="1" />
          )
        }
      </For>
    </g>
  );
}

/** The Move tool's bounding box and handles. */
function MoveControls(props: { box: Rect; view: View }) {
  const h = () => handles(initialTransform(props.box));
  const pt = (p: Vec2) => docToScreen(props.view, p);
  return (
    <g data-testid="move-controls">
      <polygon points={pointsAttr(h().corners.map(pt))} fill="none" stroke={ACCENT} stroke-width="1" />
      <For each={[...h().corners, ...h().edges]}>{(p) => <Handle at={pt(p)} />}</For>
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
