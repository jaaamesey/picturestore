import { createMemo, createRoot, createSignal, createStore, snapshot, type Accessor } from "solid-js";
import { DEFAULT_BRUSH } from "../core/brush";
import { BLACK, WHITE, type RGB } from "../core/color";
import {
  activeLayer,
  addLayer,
  clearTiles,
  createDocument,
  docRect,
  duplicateLayer,
  fillTiles,
  mergeDown,
  moveLayer,
  removeLayer,
  updateLayer,
  type Doc,
  type Layer,
  type NewDocumentOptions,
} from "../core/document";
import { amend, canRedo, canUndo, createHistory, currentDoc, jump, push, redo, undo, type History } from "../core/history";
import { invertSelection, selectAll } from "../core/selection";
import { roundOut } from "../core/geometry";
import { transformFloatingCpu, type Floating } from "../core/raster";
import type { Filter } from "../core/rasterize";
import { tilesFromImage, type TileMap } from "../core/tiles";
import type { TransformMode, TransformState } from "../core/transform";
import { mappingBounds, type Mapping } from "../core/warp";
import type { FloatingLayer, Renderer, View } from "../gpu/renderer";
import { createTools } from "./tools";
import type { TransformCommand } from "./tools/transform";
import type { Overlay, ToolContext, ToolEvent, ToolId, ToolSettings } from "./types";
import { fitView, nextZoomStep, prevZoomStep, zoomAt } from "./view";

/** One open document (a tab): its history, transient preview state and viewport. */
export interface DocumentSession {
  readonly id: string;
  readonly name: Accessor<string>;
  readonly history: Accessor<History>;
  /** Current history state. */
  readonly doc: Accessor<Doc>;
  /** What's on screen: the preview while a tool is mid-operation, else `doc`. */
  readonly displayed: Accessor<Doc>;
  readonly floating: Accessor<FloatingLayer | null>;
  readonly overlay: Accessor<Overlay | null>;
  readonly view: Accessor<View>;
  readonly dirty: Accessor<boolean>;
}

interface SessionInternals extends DocumentSession {
  setName(n: string): void;
  setHistory(h: History | ((h: History) => History)): void;
  setPreview(d: Doc | null): void;
  setFloating(f: FloatingLayer | null): void;
  setOverlay(o: Overlay | null): void;
  setView(v: View): void;
  markSaved(doc: Doc): void;
}

let sessionCounter = 0;

function createSession(doc: Doc, name: string, label: string): SessionInternals {
  const [nameSig, setName] = createSignal(name);
  const [history, setHistory] = createSignal(createHistory(doc, label));
  const [preview, setPreview] = createSignal<Doc | null>(null);
  const [floating, setFloating] = createSignal<FloatingLayer | null>(null);
  const [overlay, setOverlay] = createSignal<Overlay | null>(null);
  const [view, setView] = createSignal<View>({ zoom: 1, panX: 0, panY: 0 });
  const [saved, setSaved] = createSignal<Doc | null>(doc);
  const current = createMemo(() => currentDoc(history()));
  return {
    id: `doc${++sessionCounter}`,
    name: nameSig,
    history,
    doc: current,
    displayed: createMemo(() => preview() ?? current()),
    floating,
    overlay,
    view,
    dirty: createMemo(() => saved() !== current()),
    setName,
    setHistory,
    setPreview,
    setFloating,
    setOverlay,
    setView,
    markSaved: (doc) => setSaved(doc),
  };
}

export const DEFAULT_SETTINGS: ToolSettings = {
  transform: { showControls: true, link: true, showReference: false, interpolation: "bicubic" },
  brush: DEFAULT_BRUSH,
  eraser: { ...DEFAULT_BRUSH, hardness: 1 },
  selectionMode: "replace",
  tolerance: 32,
  contiguous: true,
};

export type Editor = ReturnType<typeof createEditor>;

type Resampler = Renderer["resample"];

type Writable<T> = { -readonly [K in keyof T]: T[K] extends object ? Writable<T[K]> : T[K] };

/**
 * Application state and actions. Documents are immutable values held in
 * signals; tools are plain state machines driven through a {@link ToolContext}.
 */
export function createEditor() {
  return createRoot(() => {
    const tools = createTools();
    const [sessions, setSessions] = createSignal<SessionInternals[]>([]);
    const [activeId, setActiveId] = createSignal<string | null>(null);
    const active = createMemo(() => sessions().find((s) => s.id === activeId()) ?? null);
    const [toolId, setToolSignal] = createSignal<ToolId>("brush");
    // Signal reads lag writes until Solid flushes; editor logic needs the tool synchronously.
    let currentTool: ToolId = "brush";
    const setToolId = (id: ToolId) => {
      currentTool = id;
      setToolSignal(id);
    };
    const [settings, setSettings] = createStore<Writable<ToolSettings>>(structuredClone(DEFAULT_SETTINGS));
    const [foreground, setForeground] = createSignal<RGB>(BLACK);
    const [background, setBackground] = createSignal<RGB>(WHITE);
    const [viewportSize, setViewportSize] = createSignal({ width: 800, height: 600 });

    const [busy, setBusy] = createSignal(false);
    let renderRequested: () => void = () => {};
    let gpuResample: Resampler | null = null;
    let reportError: (message: string) => void = (m) => console.error(m);
    let mergeKey: string | null = null;
    let switching = false;

    async function resample(f: Floating, mapping: Mapping, filter: Filter): Promise<TileMap> {
      const dest = roundOut(mappingBounds(mapping));
      if (!gpuResample) return transformFloatingCpu(f, mapping, filter);
      const pixels = await gpuResample(f, mapping, dest, filter);
      return tilesFromImage(dest.w, dest.h, pixels, dest.x, dest.y);
    }

    function context(s: SessionInternals): ToolContext {
      return {
        doc: s.doc(),
        view: s.view(),
        settings: snapshot(settings),
        foreground: foreground(),
        preview(doc, floating = null) {
          s.setPreview(doc);
          s.setFloating(floating);
          renderRequested();
        },
        commit: (label, doc) => commitTo(s, label, doc),
        commitAsync(label, pending) {
          setBusy(true);
          pending
            .then((doc) => commitTo(s, label, doc))
            .catch((err: unknown) => {
              s.setPreview(null);
              s.setFloating(null);
              reportError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
            })
            .finally(() => setBusy(false));
        },
        resample,
        overlay: s.setOverlay,
        requestRender: () => renderRequested(),
        setView: s.setView,
        setForeground,
        setTool,
      };
    }

    function commitTo(s: SessionInternals, label: string, doc: Doc, key: string | null = null) {
      s.setPreview(null);
      s.setFloating(null);
      const h = s.history();
      s.setHistory(key !== null && key === mergeKey ? amend(h, label, doc) : push(h, label, doc));
      mergeKey = key;
      renderRequested();
    }

    /** Applies `fn` to the active document as one undoable step. `key` coalesces repeated edits. */
    function edit(label: string, fn: (d: Doc) => Doc, key: string | null = null) {
      const s = active();
      if (!s) return;
      cancelTool();
      const before = s.doc();
      const after = fn(before);
      if (after !== before) commitTo(s, label, after, key);
    }

    function withTool(fn: (ctx: ToolContext, s: SessionInternals) => void) {
      const s = active();
      if (s) fn(context(s), s);
    }

    function cancelTool() {
      withTool((ctx) => tools.byId[currentTool].cancel?.(ctx));
    }

    /**
     * Switching away from Free Transform applies it. Re-entrant calls (the
     * transform session restoring its previous tool as it ends) are ignored.
     */
    function setTool(id: ToolId) {
      if (switching || id === currentTool) return;
      const prev = tools.byId[currentTool];
      switching = true;
      setToolId(id);
      withTool((ctx) => (prev.id === "transform" ? prev.commit?.(ctx) : prev.cancel?.(ctx)));
      switching = false;
    }

    /** Runs a tool action unless a commit is still being computed. */
    const whenIdle = (fn: () => void) => {
      if (!busy()) fn();
    };

    function openDocument(doc: Doc, name: string, label = "Open") {
      cancelTool();
      const s = createSession(doc, name, label);
      const { width, height } = viewportSize();
      s.setView(fitView(doc.width, doc.height, width, height));
      setSessions((list) => [...list, s]);
      setActiveId(s.id);
      return s as DocumentSession;
    }

    function closeDocument(id: string) {
      if (active()?.id === id) cancelTool();
      const list = sessions();
      const i = list.findIndex((s) => s.id === id);
      if (i < 0) return;
      const rest = list.filter((s) => s.id !== id);
      setSessions(rest);
      if (activeId() === id) setActiveId(rest[Math.min(i, rest.length - 1)]?.id ?? null);
    }

    function setView(v: View) {
      active()?.setView(v);
    }

    function zoomBy(direction: 1 | -1) {
      const s = active();
      if (!s) return;
      const { width, height } = viewportSize();
      const v = s.view();
      const z = direction > 0 ? nextZoomStep(v.zoom) : prevZoomStep(v.zoom);
      s.setView(zoomAt(v, z, { x: width / 2, y: height / 2 }));
    }

    function fit(maxZoom = Infinity) {
      const s = active();
      if (!s) return;
      const { width, height } = viewportSize();
      s.setView(fitView(s.doc().width, s.doc().height, width, height, 24, maxZoom));
    }

    function actualPixels() {
      const s = active();
      if (!s) return;
      const { width, height } = viewportSize();
      const d = s.doc();
      s.setView({ zoom: 1, panX: Math.round((width - d.width) / 2), panY: Math.round((height - d.height) / 2) });
    }

    /** True when the last transform command found a session already open. */
    let sessionWasOpen = false;

    function beginTransform(mode: TransformMode): boolean {
      const s = active();
      if (!s) return false;
      if (currentTool === "transform") {
        sessionWasOpen = true;
        // E.g. Ctrl+T while warping switches back to Free Transform, as in Photoshop.
        withTool((ctx) => tools.transform.setMode(ctx, mode));
        return true;
      }
      sessionWasOpen = false;
      const back = currentTool;
      cancelTool();
      if (!tools.transform.begin(context(s), { returnTo: back, mode })) {
        reportError("Could not complete the request because the layer is empty.");
        return false;
      }
      setToolId("transform");
      return true;
    }

    const layerEdit = (label: string, fn: (d: Doc, l: Layer) => Doc) =>
      edit(label, (d) => {
        const l = activeLayer(d);
        return l ? fn(d, l) : d;
      });

    return {
      tools,
      sessions: sessions as Accessor<readonly DocumentSession[]>,
      active: active as Accessor<DocumentSession | null>,
      setActive: (id: string) => {
        cancelTool();
        setActiveId(id);
      },
      openDocument,
      newDocument: (opts: NewDocumentOptions, name = "Untitled") => openDocument(createDocument(opts), name, "New"),
      closeDocument,
      renameDocument: (id: string, name: string) => sessions().find((s) => s.id === id)?.setName(name),
      /** Records `doc` as what's on disk (the user may keep editing while a save is in flight). */
      markSaved: (id: string, doc: Doc) => sessions().find((s) => s.id === id)?.markSaved(doc),

      tool: toolId,
      setTool,
      settings,
      setSettings,
      foreground,
      background,
      setForeground,
      setBackground,
      swapColors() {
        const f = foreground();
        setForeground(background());
        setBackground(f);
      },
      resetColors() {
        setForeground(BLACK);
        setBackground(WHITE);
      },

      // Pointer input, already converted to document space by the viewport.
      busy,
      pointerDown: (e: ToolEvent) => whenIdle(() => withTool((ctx) => tools.byId[currentTool].down?.(ctx, e))),
      pointerMove: (e: ToolEvent) => whenIdle(() => withTool((ctx) => tools.byId[currentTool].move?.(ctx, e))),
      pointerUp: (e: ToolEvent) => whenIdle(() => withTool((ctx) => tools.byId[currentTool].up?.(ctx, e))),
      cursor: (e: ToolEvent | null) => {
        const s = active();
        return s ? (tools.byId[toolId()].cursor?.(context(s), e) ?? "default") : "default";
      },
      /** Enter: commits the current tool's operation (e.g. Free Transform). */
      commitTool: () => withTool((ctx) => tools.byId[currentTool].commit?.(ctx)),
      cancelTool,

      undo: () => {
        // Inside Free Transform, Ctrl+Z steps back through the session first.
        if (currentTool === "transform") {
          let stepped = false;
          withTool((ctx) => (stepped = tools.transform.undo(ctx)));
          if (stepped) return;
        }
        cancelTool();
        mergeKey = null;
        active()?.setHistory(undo);
      },
      redo: () => {
        cancelTool();
        mergeKey = null;
        active()?.setHistory(redo);
      },
      jumpHistory: (i: number) => {
        cancelTool();
        mergeKey = null;
        active()?.setHistory((h) => jump(h, i));
      },
      canUndo: () => !!active() && canUndo(active()!.history()),
      canRedo: () => !!active() && canRedo(active()!.history()),

      // Viewport
      setView,
      setViewportSize,
      viewportSize,
      zoomIn: () => zoomBy(1),
      zoomOut: () => zoomBy(-1),
      fitOnScreen: () => fit(),
      actualPixels,
      onRenderRequest: (fn: () => void) => {
        renderRequested = fn;
      },
      /** The viewport's renderer provides commit-quality GPU resampling. */
      setResampler: (fn: Resampler | null) => {
        gpuResample = fn;
      },
      onError: (fn: (message: string) => void) => {
        reportError = fn;
      },

      // Edit ▸ Free Transform / Transform ▸ …
      freeTransform: (mode: TransformMode = "free") => whenIdle(() => beginTransform(mode)),
      /** Rotate/flip: within a session it's one more step; otherwise it applies immediately, like Photoshop. */
      transformCommand: (c: TransformCommand) =>
        whenIdle(() => {
          if (currentTool !== "transform" && !beginTransform("free")) return;
          withTool((ctx) => tools.transform.command(ctx, c));
          if (!sessionWasOpen) withTool((ctx) => tools.transform.commit?.(ctx));
        }),
      /** Numeric entry for an active Free Transform. */
      setTransform: (state: TransformState) => withTool((ctx) => tools.transform.setState(ctx, state)),
      setTransformMode: (mode: TransformMode) => withTool((ctx) => tools.transform.setMode(ctx, mode)),
      fill: (color: RGB) =>
        layerEdit("Fill", (d, l) => updateLayer(d, l.id, { tiles: fillTiles(l.tiles, docRect(d), color, d.selection) })),
      clear: () => layerEdit("Clear", (d, l) => updateLayer(d, l.id, { tiles: clearTiles(l.tiles, d.selection) })),

      // Select
      selectAll: () => edit("Select All", (d) => ({ ...d, selection: selectAll(d.width, d.height) })),
      deselect: () => edit("Deselect", (d) => (d.selection ? { ...d, selection: null } : d)),
      invertSelection: () => edit("Inverse", (d) => ({ ...d, selection: invertSelection(d.selection, d.width, d.height) })),

      // Layers
      newLayer: () => edit("New Layer", (d) => addLayer(d)),
      duplicateLayer: () => layerEdit("Duplicate Layer", (d, l) => duplicateLayer(d, l.id)),
      deleteLayer: (id?: string) => edit("Delete Layer", (d) => removeLayer(d, id ?? d.activeLayerId)),
      mergeDown: () => layerEdit("Merge Down", (d, l) => mergeDown(d, l.id)),
      moveLayer: (id: string, toIndex: number) => edit("Layer Order", (d) => moveLayer(d, id, toIndex)),
      selectLayer: (id: string) => {
        cancelTool();
        const s = active();
        // Selecting a layer isn't a history step in Photoshop; update the current entry in place.
        if (!s || s.doc().activeLayerId === id) return;
        s.setHistory((h) => ({
          ...h,
          entries: h.entries.map((e, i) => (i === h.index ? { ...e, doc: { ...e.doc, activeLayerId: id } } : e)),
        }));
      },
      setLayerProps: (id: string, patch: Partial<Pick<Layer, "name" | "visible" | "opacity" | "blendMode">>) => {
        const [label, key] =
          "opacity" in patch ? ["Opacity Change", `opacity:${id}`]
          : "blendMode" in patch ? ["Blending Change", null]
          : "visible" in patch ? [patch.visible ? "Show Layer" : "Hide Layer", null]
          : ["Rename Layer", null];
        edit(label, (d) => updateLayer(d, id, patch), key);
      },
    };
  });
}
