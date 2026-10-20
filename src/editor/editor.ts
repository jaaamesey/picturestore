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
import type { TransformState } from "../core/transform";
import type { FloatingLayer, View } from "../gpu/renderer";
import { createTools } from "./tools";
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
  markSaved(): void;
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
    markSaved: () => setSaved(currentDoc(history())),
  };
}

export const DEFAULT_SETTINGS: ToolSettings = {
  brush: DEFAULT_BRUSH,
  eraser: { ...DEFAULT_BRUSH, hardness: 1 },
  selectionMode: "replace",
  tolerance: 32,
  contiguous: true,
};

export type Editor = ReturnType<typeof createEditor>;

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
    const [toolId, setToolId] = createSignal<ToolId>("brush");
    const [settings, setSettings] = createStore<Writable<ToolSettings>>(structuredClone(DEFAULT_SETTINGS));
    const [foreground, setForeground] = createSignal<RGB>(BLACK);
    const [background, setBackground] = createSignal<RGB>(WHITE);
    const [viewportSize, setViewportSize] = createSignal({ width: 800, height: 600 });

    let renderRequested: () => void = () => {};
    let mergeKey: string | null = null;

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
      withTool((ctx) => tools.byId[toolId()].cancel?.(ctx));
    }

    function setTool(id: ToolId) {
      if (id === toolId()) return;
      const prev = tools.byId[toolId()];
      setToolId(id);
      withTool((ctx) => prev.cancel?.(ctx));
    }

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
      markSaved: () => active()?.markSaved(),

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
      pointerDown: (e: ToolEvent) => withTool((ctx) => tools.byId[toolId()].down?.(ctx, e)),
      pointerMove: (e: ToolEvent) => withTool((ctx) => tools.byId[toolId()].move?.(ctx, e)),
      pointerUp: (e: ToolEvent) => withTool((ctx) => tools.byId[toolId()].up?.(ctx, e)),
      cursor: (e: ToolEvent | null) => {
        const s = active();
        return s ? (tools.byId[toolId()].cursor?.(context(s), e) ?? "default") : "default";
      },
      /** Enter: commits the current tool's operation (e.g. Free Transform). */
      commitTool: () => withTool((ctx) => tools.byId[toolId()].commit?.(ctx)),
      cancelTool,

      undo: () => {
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

      // Edit
      freeTransform() {
        const s = active();
        if (!s || toolId() === "transform") return;
        const back = toolId();
        cancelTool();
        const ctx = context(s);
        if (tools.transform.begin(ctx, back)) setToolId("transform");
      },
      /** Numeric entry for an active Free Transform. */
      setTransform: (state: TransformState) => withTool((ctx) => tools.transform.set(ctx, state)),
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
