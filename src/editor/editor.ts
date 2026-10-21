import { createMemo, createRoot, createSignal, createStore, snapshot, type Accessor } from "solid-js";
import { copyMerged, copyPixels, pasteCenter, pasteFloating } from "../core/clipboard";
import { smartObjectLayer, withContent } from "../core/content";
import { DEFAULT_BRUSH } from "../core/brush";
import { BLACK, WHITE, type RGB } from "../core/color";
import {
  activeLayer,
  addLayer,
  clearTiles,
  convertToSmartObject,
  createDocument,
  createLayer,
  docRect,
  duplicateLayer,
  fillTiles,
  flatten,
  mergeDown,
  moveLayerRelative,
  nextLayerName,
  rasterizeLayer,
  removeLayer,
  updateLayer,
  type Doc,
  type Layer,
  type NewDocumentOptions,
  type SmartSource,
} from "../core/document";
import {
  amend,
  canRedo,
  canUndo,
  createHistory,
  currentDoc,
  jump,
  push,
  redo,
  replaceCurrent,
  undo,
  type History,
} from "../core/history";
import { invertSelection, selectAll } from "../core/selection";
import { intersect, isEmpty, rect, roundOut, type Rect } from "../core/geometry";
import { transformFloatingCpu, type Floating } from "../core/raster";
import type { Filter } from "../core/rasterize";
import { renderShape } from "../core/shape";
import { EMPTY_TILES, contentBounds, tilesFromImage, type TileMap } from "../core/tiles";
import type { TransformMode, TransformState } from "../core/transform";
import { mappingBounds, type Mapping } from "../core/warp";
import type { FloatingLayer, Renderer, View } from "../gpu/renderer";
import { SHAPE_TOOLS, createTools } from "./tools";
import { shapeGeometry, shapeStyle } from "./tools/shape";
import type { TransformCommand } from "./tools/transform";
import type { Overlay, ShapeSettings, ShapeToolId, ToolContext, ToolEvent, ToolId, ToolSettings } from "./types";
import { fitView, nextZoomStep, prevZoomStep, screenToDoc, zoomAt } from "./view";

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
  /** For a smart object's contents opened with Edit Contents: where saving writes back to. */
  readonly smartLink: SmartLink | null;
}

export interface SmartLink {
  readonly parentId: string;
  readonly sourceId: string;
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

function createSession(doc: Doc, name: string, label: string, smartLink: SmartLink | null): SessionInternals {
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
    smartLink,
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
  shape: { mode: "shape", fill: "foreground", stroke: null, radius: 0, sides: 5, starRatio: 1, weight: 2 },
  brush: DEFAULT_BRUSH,
  eraser: { ...DEFAULT_BRUSH, hardness: 1 },
  selectionMode: "replace",
  tolerance: 32,
  contiguous: true,
};

export type Editor = ReturnType<typeof createEditor>;

/** Photoshop's prompts before a pixel edit on a smart object or shape. */
export const RASTERIZE_PROMPTS = {
  smart: "This Smart Object must be rasterized before proceeding. Its contents will no longer be directly editable. Rasterize the Smart Object?",
  shape: "This shape layer must be rasterized before proceeding. Its vector mask will no longer be editable. Rasterize the shape?",
} as const;

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
    // Commits computed asynchronously (GPU resampling). A plain counter, not
    // the signal, gates input: signal reads lag writes until Solid flushes.
    let pending = 0;
    const track = <T>(p: Promise<T>): Promise<T> => {
      pending++;
      setBusy(true);
      return p.finally(() => {
        if (--pending === 0) setBusy(false);
      });
    };
    let renderRequested: () => void = () => {};
    let gpuResample: Resampler | null = null;
    let reportError: (message: string) => void = (m) => console.error(m);
    let askConfirm: (message: string) => Promise<boolean> = async () => false;
    let mergeKey: string | null = null;
    let switching = false;

    async function resample(f: Floating, mapping: Mapping, filter: Filter, clip?: Rect): Promise<TileMap> {
      const bounds = roundOut(mappingBounds(mapping));
      const dest = clip ? intersect(bounds, clip) : bounds;
      if (isEmpty(dest) || isEmpty(f.bounds)) return EMPTY_TILES;
      if (!gpuResample) return transformFloatingCpu(f, mapping, filter, clip);
      const pixels = await gpuResample(f, mapping, dest, filter);
      return tilesFromImage(dest.w, dest.h, pixels, dest.x, dest.y);
    }

    /** Asks to rasterize a smart object or shape (Photoshop's prompt), then does so as its own step. */
    async function offerRasterize(s: SessionInternals, layer: Layer) {
      if (layer.content.kind === "pixels") return;
      if (!(await askConfirm(RASTERIZE_PROMPTS[layer.content.kind]))) return;
      if (pending === 0 && sessions().includes(s)) commitTo(s, "Rasterize Layer", rasterizeLayer(s.doc(), layer.id));
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
        commitAsync: (label, doc) => commitAsync(s, label, doc),
        resample,
        requireEditable(layer) {
          if (layer.content.kind === "pixels") return true;
          void offerRasterize(s, layer);
          return false;
        },
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

    /**
     * Records a result computed asynchronously. The preview stays up and
     * input is blocked meanwhile; if the document changed underneath anyway
     * (it can't through the UI), the stale result is dropped rather than
     * overwriting newer history.
     */
    function commitAsync(s: SessionInternals, label: string, result: Promise<Doc>) {
      const base = s.doc();
      void track(result).then(
        (doc) => {
          if (s.doc() === base) commitTo(s, label, doc);
          else s.setPreview(null);
        },
        (err: unknown) => {
          s.setPreview(null);
          s.setFloating(null);
          reportError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
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

    /** Runs an action unless a commit is still being computed. */
    const whenIdle =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (pending === 0) fn(...args);
      };

    function openDocument(doc: Doc, name: string, label = "Open", smartLink: SmartLink | null = null) {
      cancelTool();
      const s = createSession(doc, name, label, smartLink);
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

    /** A pixel edit of the active layer; smart objects and shapes must be rasterized first. */
    function pixelEdit(label: string, fn: (d: Doc, l: Layer) => Doc) {
      const s = active();
      const l = s && activeLayer(s.doc());
      if (s && l && context(s).requireEditable(l)) layerEdit(label, fn);
    }

    // --- Clipboard -------------------------------------------------------------
    // The system clipboard gets a PNG (see the UI); pasting our own copy back
    // uses these pixels, losslessly and without re-decoding.
    let clipboard: Floating | null = null;

    function copy(merged: boolean): Floating | null {
      const s = active();
      const d = s?.doc();
      const l = d && activeLayer(d);
      if (!d || !l) return null;
      const f = merged ? copyMerged(d) : copyPixels(d, l);
      if (f) clipboard = f;
      else reportError(`Could not complete the ${merged ? "Copy Merged" : "Copy"} command because the selected area is empty.`);
      return f;
    }

    /** The visible part of the canvas, in document space. */
    function visibleRect(s: SessionInternals): Rect {
      const { width, height } = viewportSize();
      const a = screenToDoc(s.view(), { x: 0, y: 0 });
      const b = screenToDoc(s.view(), { x: width, y: height });
      return rect(a.x, a.y, b.x - a.x, b.y - a.y);
    }

    function paste(f: Floating, inPlace: boolean) {
      edit("Paste", (d) => pasteFloating(d, f, inPlace ? null : pasteCenter(d, visibleRect(active()!))));
    }

    // --- Smart objects -----------------------------------------------------------

    /**
     * Place Embedded: the image becomes a smart object, centred and fitted to
     * the canvas, inside a Free Transform session. Committing records the
     * placement; cancelling discards the layer.
     */
    function placeEmbedded(source: SmartSource) {
      const s = active();
      if (!s) return;
      cancelTool();
      const base = s.doc();
      void track(smartObjectLayer(base, source, resample)).then(
        (layer) => {
          if (active() !== s || s.doc() !== base || currentTool === "transform") return;
          const doc = addLayer(base, layer);
          if (tools.transform.begin(context(s), { returnTo: currentTool, place: { doc, label: "Place Embedded" } })) setToolId("transform");
        },
        (err: unknown) => reportError(`Place failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    /**
     * Saving a smart object's contents (opened with Edit Contents) updates
     * every layer in the parent document that shares the source.
     */
    function updateSmartObject(childId: string): boolean {
      const child = sessions().find((x) => x.id === childId);
      const link = child?.smartLink;
      const parent = link && sessions().find((x) => x.id === link.parentId);
      if (!child || !link) return false;
      if (!parent) {
        reportError("The document containing this Smart Object has been closed.");
        return true;
      }
      const cd = child.doc();
      const pd = parent.doc();
      const old = pd.layers.find((l) => l.content.kind === "smart" && l.content.source.id === link.sourceId);
      if (!old || old.content.kind !== "smart") {
        reportError("The Smart Object no longer exists in its document.");
        return true;
      }
      const source: SmartSource = {
        ...old.content.source,
        width: cd.width,
        height: cd.height,
        tiles: tilesFromImage(cd.width, cd.height, flatten(cd)),
        file: null,
      };
      const clip = docRect(pd);
      const update = async () => {
        let d = pd;
        for (const l of pd.layers) {
          if (l.content.kind !== "smart" || l.content.source.id !== link.sourceId) continue;
          // The placement keeps its quad, so the new contents fill the same area.
          const placement = { ...l.content.placement, source: rect(0, 0, cd.width, cd.height) };
          const { content, tiles } = await withContent(l, { kind: "smart", source, placement }, clip, resample);
          d = updateLayer(d, l.id, { content, tiles });
        }
        return d;
      };
      commitAsync(parent, "Update Smart Object", update());
      child.markSaved(cd);
      return true;
    }

    // --- Shapes ------------------------------------------------------------------

    /**
     * Shape options apply to the next shape and, with a shape tool active, to
     * the selected shape layer (consecutive changes coalesce into one step).
     */
    function setShapeOptions(patch: Partial<ShapeSettings>) {
      const next = { ...snapshot(settings).shape, ...patch };
      setSettings((st) => void Object.assign(st.shape, patch));
      const s = active();
      const l = s && activeLayer(s.doc());
      if (!s || !l || l.content.kind !== "shape" || !SHAPE_TOOLS.includes(currentTool)) return;
      const c = l.content;
      const style = "fill" in patch || "stroke" in patch ? shapeStyle(next, foreground()) : c.style;
      const g = c.geometry;
      const geometry =
        (g.kind === "rectangle" && "radius" in patch) || (g.kind === "polygon" && ("sides" in patch || "starRatio" in patch))
          ? shapeGeometry(g.kind as ShapeToolId, next)
          : g;
      if (style === c.style && geometry === g) return;
      const mapping = { source: c.placement.source, quad: c.placement.quad, patch: c.placement.patch };
      edit(
        "Shape Properties",
        (d) =>
          updateLayer(d, l.id, {
            content: { ...c, style, geometry },
            tiles: renderShape(geometry, style, mapping, docRect(d)),
          }),
        `shape:${l.id}`,
      );
    }

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
      setShapeOptions,
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
      pointerDown: whenIdle((e: ToolEvent) => withTool((ctx) => tools.byId[currentTool].down?.(ctx, e))),
      pointerMove: whenIdle((e: ToolEvent) => withTool((ctx) => tools.byId[currentTool].move?.(ctx, e))),
      pointerUp: whenIdle((e: ToolEvent) => withTool((ctx) => tools.byId[currentTool].up?.(ctx, e))),
      cursor: (e: ToolEvent | null) => {
        const s = active();
        return s ? (tools.byId[toolId()].cursor?.(context(s), e) ?? "default") : "default";
      },
      /** Enter: commits the current tool's operation (e.g. Free Transform). */
      commitTool: whenIdle(() => withTool((ctx) => tools.byId[currentTool].commit?.(ctx))),
      cancelTool,

      undo: whenIdle(() => {
        // Inside Free Transform, Ctrl+Z steps back through the session first.
        if (currentTool === "transform") {
          let stepped = false;
          withTool((ctx) => (stepped = tools.transform.undo(ctx)));
          if (stepped) return;
        }
        cancelTool();
        mergeKey = null;
        active()?.setHistory(undo);
      }),
      redo: whenIdle(() => {
        cancelTool();
        mergeKey = null;
        active()?.setHistory(redo);
      }),
      jumpHistory: whenIdle((i: number) => {
        cancelTool();
        mergeKey = null;
        active()?.setHistory((h) => jump(h, i));
      }),
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
      /** The UI's modal OK/Cancel prompt. */
      onConfirm: (fn: (message: string) => Promise<boolean>) => {
        askConfirm = fn;
      },

      // Edit ▸ Free Transform / Transform ▸ …
      freeTransform: whenIdle((mode: TransformMode = "free") => void beginTransform(mode)),
      /** Rotate/flip: within a session it's one more step; otherwise it applies immediately, like Photoshop. */
      transformCommand: whenIdle((c: TransformCommand) => {
        if (currentTool !== "transform" && !beginTransform("free")) return;
        withTool((ctx) => tools.transform.command(ctx, c));
        if (!sessionWasOpen) withTool((ctx) => tools.transform.commit?.(ctx));
      }),
      /** Numeric entry for an active Free Transform. */
      setTransform: (state: TransformState) => withTool((ctx) => tools.transform.setState(ctx, state)),
      setTransformMode: (mode: TransformMode) => withTool((ctx) => tools.transform.setMode(ctx, mode)),
      fill: whenIdle((color: RGB) =>
        pixelEdit("Fill", (d, l) => updateLayer(d, l.id, { tiles: fillTiles(l.tiles, docRect(d), color, d.selection) })),
      ),
      clear: whenIdle(() => pixelEdit("Clear", (d, l) => updateLayer(d, l.id, { tiles: clearTiles(l.tiles, d.selection) }))),

      // Clipboard. `copy`/`cut` return the pixels for the system clipboard.
      copy: (merged = false) => (pending === 0 ? copy(merged) : null),
      cut(): Floating | null {
        const s = active();
        const l = s && activeLayer(s.doc());
        if (pending > 0 || !s || !l || !context(s).requireEditable(l)) return null;
        const f = copy(false);
        if (f) pixelEdit("Cut", (d, x) => updateLayer(d, x.id, { tiles: clearTiles(x.tiles, d.selection) }));
        return f;
      },
      /** Pastes the internal clipboard (our own copy). False when it's empty. */
      paste: (inPlace = false): boolean => {
        if (pending > 0 || !clipboard || !active()) return false;
        paste(clipboard, inPlace);
        return true;
      },
      /** Pastes decoded pixels from another application as a new layer. */
      pasteImage: whenIdle((tiles: TileMap) => {
        const bounds = contentBounds(tiles);
        if (!isEmpty(bounds)) paste({ tiles, bounds }, false);
      }),
      placeEmbedded: whenIdle(placeEmbedded),
      updateSmartObject,

      // Select
      selectAll: whenIdle(() => edit("Select All", (d) => ({ ...d, selection: selectAll(d.width, d.height) }))),
      deselect: whenIdle(() => edit("Deselect", (d) => (d.selection ? { ...d, selection: null } : d))),
      invertSelection: whenIdle(() => edit("Inverse", (d) => ({ ...d, selection: invertSelection(d.selection, d.width, d.height) }))),

      // Layers
      newLayer: whenIdle(() => edit("New Layer", (d) => addLayer(d))),
      duplicateLayer: whenIdle(() => layerEdit("Duplicate Layer", (d, l) => duplicateLayer(d, l.id))),
      /** Layer via Copy (Ctrl+J): the selected pixels as a new layer, or a duplicate with no selection. */
      layerViaCopy: whenIdle(() =>
        layerEdit("Layer Via Copy", (d, l) => {
          if (!d.selection) return duplicateLayer(d, l.id);
          const f = copyPixels(d, l);
          return f ? addLayer(d, createLayer({ name: nextLayerName(d), tiles: f.tiles })) : d;
        }),
      ),
      layerViaCut: whenIdle(() =>
        pixelEdit("Layer Via Cut", (d, l) => {
          const f = d.selection && copyPixels(d, l);
          if (!f) return d;
          const cut = updateLayer(d, l.id, { tiles: clearTiles(l.tiles, d.selection) });
          return addLayer(cut, createLayer({ name: nextLayerName(d), tiles: f.tiles }));
        }),
      ),
      deleteLayer: whenIdle((id?: string) => edit("Delete Layer", (d) => removeLayer(d, id ?? d.activeLayerId))),
      mergeDown: whenIdle(() => layerEdit("Merge Down", (d, l) => mergeDown(d, l.id))),
      convertToSmartObject: whenIdle(() => layerEdit("Convert to Smart Object", (d, l) => convertToSmartObject(d, l.id))),
      rasterizeLayer: whenIdle(() => layerEdit("Rasterize Layer", (d, l) => rasterizeLayer(d, l.id))),
      /** Drops a layer directly above or below another (Layers panel drag and drop). */
      moveLayer: whenIdle((id: string, targetId: string, placement: "above" | "below") =>
        edit("Layer Order", (d) => moveLayerRelative(d, id, targetId, placement)),
      ),
      selectLayer: whenIdle((id: string) => {
        cancelTool();
        const s = active();
        // Selecting a layer isn't a history step in Photoshop; update the current entry in place.
        if (!s || s.doc().activeLayerId === id) return;
        s.setHistory((h) => replaceCurrent(h, { ...currentDoc(h), activeLayerId: id }));
      }),
      setLayerProps: whenIdle((id: string, patch: Partial<Pick<Layer, "name" | "visible" | "opacity" | "blendMode">>) => {
        const [label, key] =
          "opacity" in patch ? ["Opacity Change", `opacity:${id}`]
          : "blendMode" in patch ? ["Blending Change", null]
          : "visible" in patch ? [patch.visible ? "Show Layer" : "Hide Layer", null]
          : ["Rename Layer", null];
        edit(label, (d) => updateLayer(d, id, patch), key);
      }),
    };
  });
}
