import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onSettled, untrack, useContext } from "solid-js";
import type { Vec2 } from "../core/geometry";
import type { transformFloatingCpu } from "../core/raster";
import type { readRect } from "../core/tiles";
import type { renderShape } from "../core/shape";
import type { flatten } from "../core/document";
import type { placementMapping } from "../core/content";
import { handles, warpPoints, type TransformMode, type TransformState } from "../core/transform";
import { IDENTITY_PATCH, PATCH_ANCHORS, evalPatch, isConvex, project, squareToQuad, type Quad } from "../core/warp";
import { moveFrame } from "../editor/tools/transform";
import { boxCorners, boxToDoc, overlayLines } from "../core/crop";
import { toHex } from "../core/color";
import type { Overlay, ToolEvent } from "../editor/types";
import { RULER_PX, docToScreen, rulerStep, screenToDoc, zoomAt } from "../editor/view";
import { shown } from "../editor/viewOptions";
import { gridSpacing } from "../editor/preferences";
import type { SmartGuide } from "../core/snap";
import { resolutionOf, type Doc, type Guide } from "../core/document";
import { WORKSPACE_CSS, createRenderer, type Renderer, type View } from "../gpu/renderer";
import { AppContext } from "./context";
import { MemoryIndicator } from "./MemoryIndicator";
import { CROP_MENU, LAYER_MENU, SELECTION_MENU, TRANSFORM_MENU, type MenuItem } from "./MenuBar";

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
      reference?: {
        transformFloatingCpu: typeof transformFloatingCpu;
        readRect: typeof readRect;
        renderShape: typeof renderShape;
        flatten: typeof flatten;
        placementMapping: typeof placementMapping;
      };
      /** Writes recovery information now, regardless of the interval. */
      saveRecovery?: () => Promise<void>;
    };
  }
}

const SELECTION_TOOLS: readonly string[] = ["marquee-rect", "marquee-ellipse", "lasso", "wand"];

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

export function Viewport(props: { device: GPUDevice; readback: boolean }) {
  const { editor, openMenu } = useContext(AppContext);
  let host!: HTMLDivElement;
  const [hover, setHover] = createSignal<ToolEvent | null>(null);
  const [spaceHeld, setSpaceHeld] = createSignal(false);
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  let pan: { x: number; y: number; view: View } | null = null;
  let toolPointer: number | null = null;
  let needsRender = true;
  // Double-click detection (pointerdown's `detail` isn't reliable across browsers).
  let lastDown = { time: 0, x: 0, y: 0, clicks: 0 };

  createEffect(
    () => {
      const s = editor.active();
      return s ? [s.displayed(), s.view(), s.floating(), editor.viewOptions().extras] : null;
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
      // Coalesced events give painting full input resolution at any frame rate;
      // tools that only show a state skip to the latest.
      const events = editor.latestMoveOnly() ? [e] : (e.getCoalescedEvents?.() ?? [e]);
      for (const c of events) editor.pointerMove(toEvent(c));
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
    // A drag isn't a click: the next press starts a new count rather than making a double-click.
    if (Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) >= 5) lastDown = { ...lastDown, time: 0 };
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
      // `?gpuAtlasPages=n` caps the tile atlas, to exercise GPU memory pressure.
      const pages = Number(new URLSearchParams(location.search).get("gpuAtlasPages")) || undefined;
      const renderer = createRenderer(device, canvas, {
        readback,
        maxAtlasPages: pages,
        level: untrack(() => editor.memory().gpuLevel),
        onLevelChange: (level) => {
          editor.setGpuLevel(level);
          needsRender = true;
        },
      });
      // Test hook: resolves once everything requested so far is on screen.
      const settled = async () => {
        while (needsRender) await new Promise(requestAnimationFrame);
        await renderer.settled();
      };
      window.__ps = { ...window.__ps, editor, renderer, settled };
      editor.onRenderRequest(() => (needsRender = true));
      editor.setGpu(renderer);
      editor.onGpuReset(() => {
        renderer.resetLevel();
        editor.setGpuLevel(0);
        needsRender = true;
      });
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
        // View ▸ Extras hides selection edges too.
        const selection = editor.viewOptions().extras ? doc.selection : null;
        renderer.render({ ...doc, selection, floating: s.floating() }, s.view(), step < 0 ? 0 : (step % 8) / 8);
      };
      raf = requestAnimationFrame(frame);
      return () => {
        cancelAnimationFrame(raf);
        editor.setGpu(null);
        renderer.destroy();
        canvas.remove();
      };
    },
  );

  onSettled(() => {
    const resize = new ResizeObserver(() => {
      editor.setViewportSize({ width: host.clientWidth, height: host.clientHeight });
      setSize({ width: host.clientWidth, height: host.clientHeight });
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

  const cursor = () => (editor.busy() ? "progress" : spaceHeld() || pan ? "grab" : editor.cursor(hover()));

  /**
   * The Move tool's transform controls: the frame it publishes while
   * dragging, else the frame of what's displayed (so a commit still in
   * flight shows where things went). Hidden while pixels float, whose frame
   * the layer alone doesn't describe.
   */
  const moveControls = createMemo(() => {
    const s = editor.active();
    if (!s || editor.tool() !== "move" || !editor.settings.transform.showControls) return null;
    const o = s.overlay();
    if (o?.kind === "frame") return o.state;
    if (o || s.floating()) return null;
    return moveFrame(s.displayed());
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
        if (!editor.active()) return;
        // As in Photoshop: transform modes during a transform, selection commands with selection tools.
        const t = editor.tool();
        const items: readonly MenuItem[] =
          t === "transform" ? ["edit.freeTransform", "-", ...TRANSFORM_MENU]
          : t === "crop" || t === "perspective-crop" ? CROP_MENU
          : SELECTION_TOOLS.includes(t) ? SELECTION_MENU
          : ["edit.freeTransform", "-", ...LAYER_MENU];
        openMenu(e.clientX, e.clientY, items);
      }}
    >
      <Show when={editor.active()}>
        {(s) => (
          <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
            <ViewExtras doc={s().displayed()} view={s().view()} guides={s().smartGuides()} size={size()} />
            <Show when={s().overlay()}>
              {(o) => <OverlayShape overlay={o()} view={s().view()} showReference={editor.settings.transform.showReference} hover={hover()} />}
            </Show>
            <Show when={moveControls()}>{(f) => <MoveControls frame={f()} view={s().view()} />}</Show>
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
      <Show when={editor.viewOptions().rulers && editor.active()}>{(s) => <Rulers view={s().view()} size={size()} />}</Show>
      <StatusBar hover={hover()} />
    </div>
  );
}

/** Marching-ants strokes: a white line under an animated black dash. */
const ANTS = ["ants-base", "ants-dash"] as const;

function OverlayShape(props: { overlay: Overlay; view: View; showReference: boolean; hover: ToolEvent | null }) {
  const pt = (p: Vec2) => docToScreen(props.view, p);
  return (
    <Switch>
      <Match when={props.overlay.kind === "marquee" && props.overlay}>
        {(m) => {
          // As polygons, so they follow a rotated view.
          const outline = () => {
            const { x, y, w, h } = m().rect;
            const n = m().shape === "rect" ? 4 : 64;
            const at = (i: number) =>
              m().shape === "rect"
                ? { x: x + (i === 1 || i === 2 ? w : 0), y: y + (i >= 2 ? h : 0) }
                : { x: x + (w / 2) * (1 + Math.cos((i / n) * 2 * Math.PI)), y: y + (h / 2) * (1 + Math.sin((i / n) * 2 * Math.PI)) };
            return pointsAttr(Array.from({ length: n }, (_, i) => pt(at(i))).map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })));
          };
          return <For each={ANTS}>{(cls) => <polygon class={cls} points={outline()} />}</For>;
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
      <Match when={props.overlay.kind === "crop" && props.overlay}>{(c) => <CropOverlayView overlay={c()} view={props.view} hover={props.hover} />}</Match>
      <Match when={props.overlay.kind === "perspective-crop" && props.overlay}>{(c) => <PerspectiveCropView overlay={c()} view={props.view} />}</Match>
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

type CropOverlayData = Extract<Overlay, { kind: "crop" }>;

const SHIELD_PATH = "M-100000 -100000H100000V100000H-100000Z";
const polygonPath = (pts: readonly Vec2[]) => `M${pts.map((p) => `${p.x} ${p.y}`).join("L")}Z`;

/** Darkens (or, with Show Cropped Area off, hides) everything outside `outline`. */
function CropShield(props: { outline: readonly Vec2[]; editing: boolean }) {
  const { editor } = useContext(AppContext);
  const c = () => editor.settings.crop;
  const opacity = () => (!c().showCropped ? 1 : c().shield ? c().shieldOpacity * (c().autoAdjustOpacity && props.editing ? 0.5 : 1) : 0);
  const color = () => (!c().showCropped || !c().shieldColor ? WORKSPACE_CSS : toHex(c().shieldColor!));
  return (
    <Show when={opacity() > 0}>
      <path data-testid="crop-shield" d={`${SHIELD_PATH}${polygonPath(props.outline)}`} fill-rule="evenodd" fill={color()} opacity={opacity()} />
    </Show>
  );
}

/** A line drawn white over a faint dark one, visible on any image. */
function GuideLine(props: { points: readonly Vec2[]; width?: number; opacity?: number }) {
  return (
    <g opacity={props.opacity ?? 1}>
      <polyline points={pointsAttr(props.points)} fill="none" stroke="black" stroke-opacity="0.35" stroke-width={(props.width ?? 1) + 2} />
      <polyline points={pointsAttr(props.points)} fill="none" stroke="white" stroke-width={props.width ?? 1} />
    </g>
  );
}

/** Photoshop's crop box: the shield, the overlay, an outline with corner brackets and edge bars, and a size or angle readout. */
function CropOverlayView(props: { overlay: CropOverlayData; view: View; hover: ToolEvent | null }) {
  const { editor } = useContext(AppContext);
  const c = () => editor.settings.crop;
  const pt = (p: Vec2) => docToScreen(props.view, p);
  const corners = () => boxCorners(props.overlay.box).map(pt);
  const editing = () => props.overlay.drag !== null && props.overlay.drag !== "straighten";
  const box = () => props.overlay.box;
  /** Overlay lines, in screen space. Rotating always shows a fine grid, as in Photoshop. */
  const lines = () => {
    const b = box(), drag = props.overlay.drag;
    const mode = c().showOverlay;
    if (mode === "never" || (mode === "auto" && !editing())) return [];
    const sw = b.w * props.view.zoom;
    const rotating = drag === "rotate";
    const kind = rotating ? "grid" : c().overlay;
    const cell = b.w / Math.max(2, Math.round(sw / (rotating ? 24 : 48)));
    return overlayLines(kind, c().orientation, b.w, b.h, cell).map((l) => l.map((p) => pt(boxToDoc(b, p))));
  };
  const bracket = (i: number) => {
    const p = corners()[i], next = corners()[(i + 1) % 4], prev = corners()[(i + 3) % 4];
    const along = (q: Vec2) => {
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const l = Math.min(18, len / 3);
      return { x: p.x + ((q.x - p.x) / len) * l, y: p.y + ((q.y - p.y) / len) * l };
    };
    return [along(prev), p, along(next)];
  };
  const bar = (i: number) => {
    const a = corners()[i], b = corners()[(i + 1) % 4];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const l = Math.min(9, len / 6);
    return [
      { x: m.x - ((b.x - a.x) / len) * l, y: m.y - ((b.y - a.y) / len) * l },
      { x: m.x + ((b.x - a.x) / len) * l, y: m.y + ((b.y - a.y) / len) * l },
    ];
  };
  const readout = () => {
    const d = props.overlay.drag, h = props.hover;
    if (!h || !d || d === "move") return null;
    const deg = (a: number) => `${Math.round(((a * 180) / Math.PI) * 10) / 10}°`;
    // The image's turn (the box's, in Classic Mode).
    if (d === "rotate") return [deg(c().classic ? box().angle : -box().angle)];
    if (d === "straighten") {
      const [a, b] = props.overlay.line!;
      return [deg(Math.atan2(b.y - a.y, b.x - a.x))];
    }
    return [`W: ${Math.round(box().w)} px`, `H: ${Math.round(box().h)} px`];
  };
  return (
    <g data-testid="crop-box" data-angle={box().angle} data-w={box().w} data-h={box().h}>
      <CropShield outline={corners()} editing={editing()} />
      <For each={lines()}>{(l) => <GuideLine points={l} opacity={0.7} />}</For>
      <GuideLine points={[...corners(), corners()[0]]} />
      <For each={[0, 1, 2, 3]}>{(i) => <GuideLine points={bracket(i)} width={3} />}</For>
      <For each={[0, 1, 2, 3]}>{(i) => <GuideLine points={bar(i)} width={3} />}</For>
      <Show when={props.overlay.line}>{(l) => <GuideLine points={l().map(pt)} />}</Show>
      <Show when={readout()}>
        {(lines) => (
          <g transform={`translate(${props.hover!.screenX + 18} ${props.hover!.screenY + 18})`} data-testid="crop-readout">
            <rect width="78" height={lines().length * 15 + 6} rx="3" fill="black" opacity="0.75" />
            <For each={lines()}>
              {(t, i) => (
                <text x="6" y={15 * (i() + 1)} fill="white" font-size="11">
                  {t}
                </text>
              )}
            </For>
          </g>
        )}
      </Show>
    </g>
  );
}

/** The Perspective Crop tool's quad: corners clicked so far, or the quad with its perspective grid. */
function PerspectiveCropView(props: { overlay: Extract<Overlay, { kind: "perspective-crop" }>; view: View }) {
  const { editor } = useContext(AppContext);
  const pts = () => props.overlay.points.map((p) => docToScreen(props.view, p));
  const quad = () => (pts().length === 4 ? (pts() as unknown as Quad) : null);
  const color = () => (props.overlay.valid ? ACCENT : "#e5484d");
  /** Corners, then the edges' midpoints. */
  const handlePoints = () => (quad() ? [...pts(), ...pts().map((p, i) => ({ x: (p.x + pts()[(i + 1) % 4].x) / 2, y: (p.y + pts()[(i + 1) % 4].y) / 2 }))] : pts());
  /** Grid lines at even steps of the straightened rectangle (a homography maps them). */
  const grid = () => {
    const q = quad();
    if (!q || !editor.settings.perspectiveCrop.showGrid || !isConvex(q)) return [];
    const H = squareToQuad(q);
    if (!H) return [];
    const side = Math.max(...q.map((p, i) => Math.hypot(q[(i + 1) % 4].x - p.x, q[(i + 1) % 4].y - p.y)));
    const n = Math.max(2, Math.min(24, Math.round(side / 40)));
    const out: Vec2[][] = [];
    for (let i = 1; i < n; i++) out.push([project(H, i / n, 0), project(H, i / n, 1)], [project(H, 0, i / n), project(H, 1, i / n)]);
    return out;
  };
  return (
    <g data-testid="perspective-crop" data-valid={props.overlay.valid ? "true" : "false"}>
      <Show when={quad()}>{(q) => <CropShield outline={q()} editing={props.overlay.dragging} />}</Show>
      <For each={grid()}>{(l) => <polyline points={pointsAttr(l)} fill="none" stroke={color()} stroke-width="1" opacity="0.6" />}</For>
      <polyline points={pointsAttr(quad() ? [...pts(), pts()[0]] : pts())} fill="none" stroke={color()} stroke-width="1" />
      <For each={handlePoints()}>{(p) => <Handle at={p} />}</For>
    </g>
  );
}

/** The Move tool's bounding box and handles. */
function MoveControls(props: { frame: TransformState; view: View }) {
  const h = () => handles(props.frame);
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
          <MemoryIndicator />
        </div>
      )}
    </Show>
  );
}

type Size = { readonly width: number; readonly height: number };

/** The document rectangle visible in the viewport (its bounds, for a rotated view). */
function visibleDocRect(view: View, size: Size) {
  const corners = [
    { x: 0, y: 0 },
    { x: size.width, y: 0 },
    { x: size.width, y: size.height },
    { x: 0, y: size.height },
  ].map((p) => screenToDoc(view, p));
  const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

const DASH = { lines: undefined, dashed: "6 4", dots: "1 3" } as const;

/** Multiples of `step` within [lo, hi], at most `max` of them. */
function multiples(step: number, lo: number, hi: number, max = 2000): number[] {
  if (!(step > 0) || (hi - lo) / step > max) return [];
  const out: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) out.push(k * step);
  return out;
}

/**
 * What View ▸ Show puts over the canvas: the grid (over the canvas, minor
 * lines lighter), guides (across the whole window) and the smart guides of
 * the current drag.
 */
function ViewExtras(props: { doc: Doc; view: View; guides: readonly SmartGuide[]; size: Size }) {
  const { editor } = useContext(AppContext);
  const show = () => shown(editor.viewOptions());
  const prefs = () => editor.preferences();
  const pt = (x: number, y: number) => docToScreen(props.view, { x, y });
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const a = pt(x0, y0), b = pt(x1, y1);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };
  const grid = () => {
    if (!show().grid) return [];
    const { width: w, height: h } = props.doc;
    const { major, minor } = gridSpacing(prefs(), w, h, resolutionOf(props.doc));
    const vis = visibleDocRect(props.view, props.size);
    const [x0, x1, y0, y1] = [Math.max(0, vis.x0), Math.min(w, vis.x1), Math.max(0, vis.y0), Math.min(h, vis.y1)];
    const lines: { major: boolean; at: ReturnType<typeof line> }[] = [];
    const zoom = props.view.zoom;
    const axis = (minorStep: number, majorStep: number, lo: number, hi: number, draw: (v: number) => ReturnType<typeof line>) => {
      // Subdivisions only when they're far enough apart to read; gridlines likewise.
      const step = minorStep * zoom >= 6 ? minorStep : majorStep * zoom >= 6 ? majorStep : 0;
      for (const v of multiples(step, lo, hi)) {
        const isMajor = Math.abs(v / majorStep - Math.round(v / majorStep)) < 1e-6;
        lines.push({ major: isMajor, at: draw(v) });
      }
    };
    axis(minor.x, major.x, x0, x1, (x) => line(x, y0, x, y1));
    axis(minor.y, major.y, y0, y1, (y) => line(x0, y, x1, y));
    return lines;
  };
  // Guides cross the whole window, pasteboard included.
  const guides = () => (show().guides ? (props.doc.guides ?? []) : []);
  const FAR = 1e6;
  return (
    <g data-testid="view-extras">
      <For each={grid()}>
        {(l) => (
          <line {...l.at} stroke={prefs().gridColor} stroke-width="1" stroke-dasharray={DASH[prefs().gridStyle]} opacity={l.major ? 0.9 : 0.45} data-testid="grid-line" />
        )}
      </For>
      <For each={guides()}>
        {(g) => (
          <line
            {...(g.orientation === "vertical" ? line(g.position, -FAR, g.position, FAR) : line(-FAR, g.position, FAR, g.position))}
            stroke={prefs().guideColor}
            stroke-width="1"
            stroke-dasharray={DASH[prefs().guideStyle]}
            data-testid="guide"
            data-orientation={g.orientation}
            data-position={g.position}
          />
        )}
      </For>
      <For each={props.guides}>
        {(g) => (
          <line
            {...(g.axis === "x" ? line(g.at, g.from, g.at, g.to) : line(g.from, g.at, g.to, g.at))}
            stroke={prefs().smartGuideColor}
            stroke-width="1"
            data-testid="smart-guide"
          />
        )}
      </For>
    </g>
  );
}

/**
 * View ▸ Rulers: pixel rulers along the top and left (ticks on a 1–2–5
 * scale). Dragging from one pulls out a guide — horizontal from the top,
 * vertical from the left, Alt for the other — which snaps as it goes (Shift:
 * to the ruler's ticks) and is dropped onto the canvas, or back onto the
 * ruler to cancel.
 */
function Rulers(props: { view: View; size: Size }) {
  const { editor } = useContext(AppContext);
  const [drag, setDrag] = createSignal<{ orientation: Guide["orientation"]; position: number } | null>(null);
  const step = () => rulerStep(props.view.zoom);
  // Rulers read the unrotated view (a rotated view, only ever the Crop tool's, has no straight rulers).
  const toScreen = (v: number, axis: "x" | "y") => v * props.view.zoom + (axis === "x" ? props.view.panX : props.view.panY);
  const ticks = (axis: "x" | "y") => {
    const len = axis === "x" ? props.size.width : props.size.height;
    const pan = axis === "x" ? props.view.panX : props.view.panY;
    const lo = (RULER_PX - pan) / props.view.zoom, hi = (len - pan) / props.view.zoom;
    const { major, minor } = step();
    return multiples(minor, lo, hi).map((v) => ({ at: toScreen(v, axis), major: Math.abs(v / major - Math.round(v / major)) < 1e-6, label: Math.round(v) }));
  };

  const startGuide = (from: "top" | "left") => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const host = el.parentElement!.getBoundingClientRect();
    const local = (m: PointerEvent) => ({ x: m.clientX - host.left, y: m.clientY - host.top });
    const update = (m: PointerEvent) => {
      const base: Guide["orientation"] = from === "top" ? "horizontal" : "vertical";
      const orientation = m.altKey ? (base === "horizontal" ? "vertical" : "horizontal") : base;
      const p = screenToDoc(props.view, local(m));
      setDrag({ orientation, position: editor.guidePosition(orientation, p, m.shiftKey) });
    };
    const up = (m: PointerEvent) => {
      el.removeEventListener("pointermove", update);
      el.removeEventListener("pointerup", up);
      const d = drag();
      setDrag(null);
      editor.endGuideDrag();
      const q = local(m);
      const onRuler = q.x < RULER_PX || q.y < RULER_PX || q.x > props.size.width || q.y > props.size.height;
      if (!d || onRuler) return;
      // A new guide shows guides, as in Photoshop.
      if (!shown(editor.viewOptions()).guides) editor.setViewOptions({ extras: true, showGuides: true });
      editor.addGuide(d.orientation, d.position);
    };
    el.addEventListener("pointermove", update);
    el.addEventListener("pointerup", up);
    update(e);
  };

  const ruler = "absolute overflow-hidden bg-panel text-[9px] text-dim select-none";
  return (
    <>
      <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        <Show when={drag()}>
          {(d) => {
            const at = () => (d().orientation === "vertical" ? toScreen(d().position, "x") : toScreen(d().position, "y"));
            return d().orientation === "vertical" ? (
              <line x1={at()} y1={0} x2={at()} y2={props.size.height} stroke={editor.preferences().guideColor} data-testid="guide-preview" />
            ) : (
              <line x1={0} y1={at()} x2={props.size.width} y2={at()} stroke={editor.preferences().guideColor} data-testid="guide-preview" />
            );
          }}
        </Show>
      </svg>
      <div class={ruler} style={{ left: `${RULER_PX}px`, right: "0", top: "0", height: `${RULER_PX}px` }} data-testid="ruler-top" onPointerDown={startGuide("top")}>
        <svg class="absolute h-full w-full overflow-visible" style={{ left: `-${RULER_PX}px` }}>
          <For each={ticks("x")}>
            {(t) => (
              <>
                <line x1={t.at} y1={t.major ? 0 : RULER_PX - 4} x2={t.at} y2={RULER_PX} stroke="currentColor" />
                <Show when={t.major}>
                  <text x={t.at + 2} y={9} fill="currentColor">
                    {t.label}
                  </text>
                </Show>
              </>
            )}
          </For>
        </svg>
      </div>
      <div class={ruler} style={{ top: `${RULER_PX}px`, bottom: "0", left: "0", width: `${RULER_PX}px` }} data-testid="ruler-left" onPointerDown={startGuide("left")}>
        <svg class="absolute h-full w-full overflow-visible" style={{ top: `-${RULER_PX}px` }}>
          <For each={ticks("y")}>
            {(t) => (
              <>
                <line x1={t.major ? 0 : RULER_PX - 4} y1={t.at} x2={RULER_PX} y2={t.at} stroke="currentColor" />
                <Show when={t.major}>
                  <text x={11} y={t.at + 2} fill="currentColor" transform={`rotate(-90 11 ${t.at + 2})`} text-anchor="end">
                    {t.label}
                  </text>
                </Show>
              </>
            )}
          </For>
        </svg>
      </div>
      <div class="absolute top-0 left-0 bg-panel" style={{ width: `${RULER_PX}px`, height: `${RULER_PX}px` }} />
    </>
  );
}
