import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, range, setCharStyle, setParagraphStyle, type CharStyle, type ParagraphStyle, type TextContent, type TextRange } from "../text/model";
import { drawText } from "../text/engine";
import type { Motion } from "../text/edit";
import { createEffect, createMemo, createRoot, createSignal, createStore, snapshot, type Accessor } from "solid-js";
import { copyMerged, copyPixels, pasteCenter, pasteFloating } from "../core/clipboard";
import { placementMapping, resizedPlacement, smartObjectLayer, withContent, type Rasterizers } from "../core/content";
import { affine3, canvasOffset, imageSize, resizeCanvas, setResolution, transformDocument, type Anchor, type ImageSizeOptions } from "../core/documentTransform";
import { DEFAULT_BRUSH } from "../core/brush";
import { BLACK, WHITE, type RGB } from "../core/color";
import {
  activeLayer,
  addLayer,
  clearPixels,
  convertToSmartObject,
  createDocument,
  createLayer,
  docRect,
  duplicateLayer,
  editTarget,
  fillPixels,
  groupLayers,
  layerById,
  maskTone,
  moveLayer as moveLayerTo,
  moveLayerRelative,
  nextLayerName,
  numberedName,
  rasterizeLayer,
  removeLayer,
  ungroup,
  updateLayer,
  withTargetPixels,
  createGroup,
  HIDE_ALL,
  REVEAL_ALL,
  type EditTarget,
  type LayerMask,
  type Doc,
  type Guide,
  type Layer,
  type LayerContent,
  type NewDocumentOptions,
  resolutionOf,
  type SmartSource,
} from "../core/document";
import { adjustPixels, adjustedBackground, applyMask, flatten, histogram, maskValues, mergeDown, selectionFrom } from "../core/composite";
import { adjustmentLabel, compile, defaultAdjustment, equalizeCurve, type Adjustment, type AdjustmentKind, type Program } from "../core/adjustments";
import type { LayerBlendMode } from "../core/blend";
import { hasPixels, isClipped, isGroup, locate, walk, type Placement as LayerPlacement } from "../core/layers";
import {
  amend,
  canRedo,
  canUndo,
  createHistory,
  currentDoc,
  dropOne,
  historyBytes,
  jump,
  limitSteps,
  push,
  redo,
  replaceCurrent,
  undo,
  type History,
} from "../core/history";
import { combine, invertSelection, selectAll, type SelectionMode } from "../core/selection";
import { intersect, isEmpty, rect, roundOut, translation, type Rect, type Vec2 } from "../core/geometry";
import { transformFloatingCpu, type Floating } from "../core/raster";
import type { Filter } from "../core/rasterize";
import { renderDrawing, renderShape, type ShapeGeometry, type ShapeStyle, type VectorDrawing } from "../core/shape";
import { NO_PIXELS, contentBounds, pixelsFromImage, type Pixels } from "../core/pixels";
import type { TransformMode, TransformState } from "../core/transform";
import { mappingBounds, type Mapping } from "../core/warp";
import type { FloatingLayer, Renderer, View } from "../gpu/renderer";
import { createPreviewWorker } from "../preview/client";
import { SHAPE_TOOLS, createTools } from "./tools";
import { shapeGeometry, shapeStyle } from "./tools/shape";
import type { TransformCommand } from "./tools/transform";
import { createSnapper, guidePosition } from "./snapping";
import { activeSnapTo, loadViewOptions, saveViewOptions, shown, type ViewOptions } from "./viewOptions";
import type { SmartGuide } from "../core/snap";
import type { ShapeOptionsPatch, ShapeStroke } from "./types";
import type { Overlay, ShapeSettings, ShapeToolId, ToolContext, ToolEvent, ToolId, ToolKey, ToolSettings, Writable } from "./types";
import { loadPreferences, savePreferences, type Preferences } from "./preferences";
import { fitView, followRemap, nextZoomStep, placeAt, prevZoomStep, screenToDoc, zoomAt } from "./view";

/** One open document (a tab): its history, transient preview state and viewport. */
export interface DocumentSession {
  readonly id: string;
  readonly name: Accessor<string>;
  readonly history: Accessor<History>;
  /** Current history state. */
  readonly doc: Accessor<Doc>;
  /** What's on screen: the preview while a tool is mid-operation, else `doc` (or, viewing a mask, the mask). */
  readonly displayed: Accessor<Doc>;
  /** Floating pixels being transformed, as shown (a moving mask is shown as itself while it's viewed). */
  readonly floating: Accessor<FloatingLayer | null>;
  /** Alt-clicking a mask thumbnail shows the active layer's mask alone, in grey, until it's clicked again. */
  readonly maskView: Accessor<boolean>;
  readonly overlay: Accessor<Overlay | null>;
  /** Smart guides of the current drag's snap. */
  readonly smartGuides: Accessor<readonly SmartGuide[]>;
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
  setMaskView(on: boolean): void;
  setOverlay(o: Overlay | null): void;
  setSmartGuides(g: readonly SmartGuide[]): void;
  setView(v: View): void;
  markSaved(doc: Doc | null): void;
}

let sessionCounter = 0;

function createSession(doc: Doc, name: string, label: string, smartLink: SmartLink | null): SessionInternals {
  const [nameSig, setName] = createSignal(name);
  // History is read synchronously by editor logic (signal reads lag writes
  // until Solid flushes), so the signal only carries change notifications.
  let h = createHistory(doc, label);
  const [version, bump] = createSignal(0);
  const history = () => (version(), h);
  const [preview, setPreview] = createSignal<Doc | null>(null);
  const [floating, setFloating] = createSignal<FloatingLayer | null>(null);
  const [overlay, setOverlay] = createSignal<Overlay | null>(null);
  const [smartGuides, setSmartGuides] = createSignal<readonly SmartGuide[]>([]);
  const [view, setView] = createSignal<View>({ zoom: 1, panX: 0, panY: 0 });
  const [saved, setSaved] = createSignal<Doc | null>(doc);
  const [maskView, setMaskView] = createSignal(false);
  const current = () => currentDoc(history());
  const shown = createMemo(() => preview() ?? current());
  const viewedMask = () => (maskView() ? activeLayer(shown())?.mask ?? null : null);
  return {
    id: `doc${++sessionCounter}`,
    name: nameSig,
    history,
    doc: current,
    displayed: createMemo(() => {
      const d = shown();
      const l = activeLayer(d);
      return maskView() && l?.mask ? maskViewDoc(d, l.id, l.mask) : d;
    }),
    floating: createMemo(() => {
      const f = floating();
      return f && viewedMask() ? { layerId: f.layerId, pixels: f.mask, mask: null } : f;
    }),
    maskView: () => !!viewedMask(),
    setMaskView,
    overlay,
    smartGuides,
    view,
    dirty: createMemo(() => saved() !== current()),
    smartLink,
    setName,
    setHistory(next) {
      const n = typeof next === "function" ? next(h) : next;
      if (n === h) return;
      h = n;
      bump((v) => v + 1);
    },
    setPreview,
    setFloating,
    setOverlay,
    setSmartGuides: (g) => setSmartGuides((prev) => (prev.length === 0 && g.length === 0 ? prev : g)),
    setView,
    markSaved: (doc) => setSaved(doc),
  };
}

/** Fills of a mask's background grey, cached per size (they're the whole canvas). */
const backdrops = new Map<string, Pixels>();

/**
 * A document showing just a layer's mask, as Photoshop does when its
 * thumbnail is Alt-clicked: its grey over its background. The mask is
 * drawn as a layer with the active layer's id, so a mask being painted or
 * moved shows live.
 */
function maskViewDoc(d: Doc, id: string, mask: LayerMask): Doc {
  const key = `${d.width}x${d.height}:${mask.background}`;
  let fill = backdrops.get(key);
  if (!fill) {
    const v = mask.background;
    backdrops.set(key, (fill = fillPixels(NO_PIXELS, docRect(d), { r: v, g: v, b: v })));
  }
  const back = createLayer({ id: "mask-view-background", name: "mask background", pixels: fill });
  return { ...d, layers: [back, createLayer({ name: "mask", pixels: mask.pixels, id })], activeLayerId: id };
}

/** A stroke's properties before any are chosen. */
export const DEFAULT_STROKE: ShapeStroke = { color: BLACK, width: 3, align: "inside" };

export const DEFAULT_SETTINGS: ToolSettings = {
  transform: { showControls: true, link: true, showReference: false, interpolation: "bicubic" },
  shape: { mode: "shape", fill: "foreground", stroke: null, radius: 0, sides: 5, starRatio: 1, weight: 2 },
  type: { char: DEFAULT_CHAR_STYLE, paragraph: DEFAULT_PARAGRAPH_STYLE, antiAlias: "sharp" },
  brush: DEFAULT_BRUSH,
  eraser: { ...DEFAULT_BRUSH, hardness: 1 },
  selectionMode: "replace",
  tolerance: 32,
  contiguous: true,
  crop: {
    constraint: { mode: "ratio", width: null, height: null, resolution: null },
    deletePixels: true,
    overlay: "thirds",
    orientation: 0,
    showOverlay: "auto",
    classic: false,
    showCropped: true,
    autoCenter: true,
    shield: true,
    shieldColor: null,
    shieldOpacity: 0.75,
    autoAdjustOpacity: true,
    straighten: false,
  },
  perspectiveCrop: { width: null, height: null, resolution: null, showGrid: true },
};

export type Editor = ReturnType<typeof createEditor>;

/**
 * How memory-constrained the app is. RAM: "limited" when history states were
 * freed to stay within Memory Usage; "exhausted" after an allocation failed.
 * GPU: the display's quality reduction (0 = full; n = drawn at 1/2ⁿ resolution).
 */
export interface MemoryStatus {
  readonly ram: "ok" | "limited" | "exhausted";
  readonly gpuLevel: number;
}

/** Engines report failed allocations as RangeErrors ("Array buffer allocation failed", "Invalid array length"). */
export const isOutOfMemory = (err: unknown) =>
  err instanceof RangeError && /alloc|memory|array (buffer )?length/i.test(err.message);

export const OUT_OF_MEMORY = "Could not complete your request because there is not enough memory (RAM).";

/** Photoshop's prompts before a pixel edit on a smart object, shape or type layer. */
export const RASTERIZE_PROMPTS = {
  smart: "This Smart Object must be rasterized before proceeding. Its contents will no longer be directly editable. Rasterize the Smart Object?",
  shape: "This shape layer must be rasterized before proceeding. Its vector mask will no longer be editable. Rasterize the shape?",
  text: "This type layer must be rasterized before proceeding. Its text will no longer be editable. Rasterize the type?",
} as const;

const rasterizable = (c: LayerContent): c is Extract<LayerContent, { kind: keyof typeof RASTERIZE_PROMPTS }> => c.kind in RASTERIZE_PROMPTS;

/** What the editor uses the GPU renderer for, besides display. */
type GpuRaster = Pick<Renderer, "resample" | "rasterizeShape" | "rasterizeDrawing" | "adjust">;

/** Photoshop's messages when a pixel edit has nothing to edit. */
export const NOT_EDITABLE = {
  group: "Could not complete your request because the target layer is a group.",
  adjustment: "Could not complete your request because the content of the layer is not directly editable.",
} as const;

/**
 * Application state and actions. Documents are immutable values held in
 * signals; tools are plain state machines driven through a {@link ToolContext}.
 */
export function createEditor() {
  return createRoot(() => {
    const tools = createTools();
    // Like history, the open sessions and the active one are read
    // synchronously (e.g. right after opening a document); signals only notify.
    let sessionList: SessionInternals[] = [];
    let activeIdNow: string | null = null;
    const [sessionsVersion, bumpSessions] = createSignal(0);
    const sessions = () => (sessionsVersion(), sessionList);
    const setSessions = (fn: (list: SessionInternals[]) => SessionInternals[]) => {
      sessionList = fn(sessionList);
      bumpSessions((v) => v + 1);
    };
    const setActiveId = (id: string | null) => {
      activeIdNow = id;
      bumpSessions((v) => v + 1);
    };
    const active = () => sessions().find((s) => s.id === activeIdNow) ?? null;
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
    const [preferences, setPreferencesSignal] = createSignal<Preferences>(loadPreferences());
    let prefs = preferences();
    const [viewOptions, setViewOptionsSignal] = createSignal<ViewOptions>(loadViewOptions());
    let viewNow = viewOptions();
    const [memory, setMemory] = createSignal<MemoryStatus>({ ram: "ok", gpuLevel: 0 });
    let memoryNow = memory();
    const updateMemory = (patch: Partial<MemoryStatus>) => {
      memoryNow = { ...memoryNow, ...patch };
      setMemory(memoryNow);
    };

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
    let gpu: GpuRaster | null = null;
    let reportError: (message: string) => void = (m) => console.error(m);
    let gpuReset: () => void = () => {};
    let previews: ReturnType<typeof createPreviewWorker> | null = null;
    let askConfirm: (message: string) => Promise<boolean> = async () => false;
    let askBoxSize: () => Promise<{ width: number; height: number } | null> = async () => null;
    let mergeKey: string | null = null;
    let switching = false;

    async function resample(f: Floating, mapping: Mapping, filter: Filter, clip?: Rect): Promise<Pixels> {
      const bounds = roundOut(mappingBounds(mapping));
      const dest = clip ? intersect(bounds, clip) : bounds;
      if (isEmpty(dest) || isEmpty(f.bounds)) return NO_PIXELS;
      if (gpu) {
        try {
          const pixels = await gpu.resample(f, mapping, dest, filter);
          return pixelsFromImage(dest.w, dest.h, pixels, dest.x, dest.y);
        } catch (err) {
          // Out of GPU memory (or the device was lost): the CPU reference gives the same result, just slower.
          if (isOutOfMemory(err)) throw err;
          console.warn("GPU resampling failed; falling back to the CPU:", err);
        }
      }
      return transformFloatingCpu(f, mapping, filter, clip);
    }

    /** A shape's pixels: rasterized on the GPU and read back; the CPU reference without one. */
    async function rasterizeShape(g: ShapeGeometry, style: ShapeStyle, m: Mapping, clip: Rect): Promise<Pixels> {
      if (gpu) {
        try {
          return await gpu.rasterizeShape(g, style, m, clip);
        } catch (err) {
          console.warn("GPU shape rasterization failed; falling back to the CPU:", err);
        }
      }
      return renderShape(g, style, m, clip);
    }

    /** Vector art's pixels (type): the same way. */
    async function rasterizeDrawing(d: VectorDrawing, clip: Rect): Promise<Pixels> {
      if (gpu) {
        try {
          return await gpu.rasterizeDrawing(d, clip);
        } catch (err) {
          console.warn("GPU rasterization failed; falling back to the CPU:", err);
        }
      }
      return renderDrawing(d, clip);
    }

    const raster: Rasterizers = { resample, shape: rasterizeShape, drawing: rasterizeDrawing };

    /** Asks to rasterize a smart object, shape or type (Photoshop's prompt), does so as its own step, then carries on with `proceed`. */
    async function offerRasterize(s: SessionInternals, layer: Layer, proceed?: (ctx: ToolContext) => void) {
      if (!rasterizable(layer.content)) return;
      if (!(await askConfirm(RASTERIZE_PROMPTS[layer.content.kind]))) return;
      if (pending !== 0 || !sessions().includes(s)) return;
      commitTo(s, "Rasterize Layer", rasterizeLayer(s.doc(), layer.id));
      if (proceed && active() === s) guard(() => proceed(context(s)))();
    }

    /** The session's edit target, if it can be edited directly (see ToolContext.editTarget). */
    function editableTarget(s: SessionInternals, proceed?: (ctx: ToolContext) => void): EditTarget | null {
      const t = editTarget(s.doc());
      if (!t || t.mask || t.layer.content.kind === "pixels") return t;
      const c = t.layer.content;
      if (c.kind === "group" || c.kind === "adjustment") reportError(NOT_EDITABLE[c.kind]);
      else void offerRasterize(s, t.layer, proceed);
      return null;
    }

    function context(s: SessionInternals): ToolContext {
      return {
        doc: s.doc(),
        view: s.view(),
        settings: snapshot(settings),
        foreground: foreground(),
        background: background(),
        preview(doc, floating = null) {
          s.setPreview(doc);
          s.setFloating(floating);
          renderRequested();
        },
        commit: (label, doc) => commitTo(s, label, doc),
        commitAsync: (label, doc, landed) => commitAsync(s, label, doc, null, landed),
        viewport: viewportSize(),
        updateSettings: (fn) => setSettings(fn),
        raster,
        editTarget: (proceed) => editableTarget(s, proceed),
        overlay: s.setOverlay,
        snap: snapperFor(s),
        viewOptions: viewNow,
        requestRender: () => renderRequested(),
        setView: s.setView,
        setForeground,
        setTool,
        preferences: prefs,
        askBoxSize: () => askBoxSize(),
      };
    }

    /** Snapping as View ▸ Snap and Snap To say, at the session's zoom; smart guides when shown. */
    const snapperFor = (s: SessionInternals) =>
      createSnapper(s.doc(), s.view().zoom, activeSnapTo(viewNow), prefs, (g) => s.setSmartGuides(shown(viewNow).smartGuides ? g : []));

    /** Applies `fn` to the active document's guides as one undoable step. */
    function guideEdit(label: string, fn: (g: readonly Guide[]) => readonly Guide[]) {
      edit(label, (d) => {
        const guides = fn(d.guides ?? []);
        return guides === (d.guides ?? []) ? d : { ...d, guides };
      });
    }

    function commitTo(s: SessionInternals, label: string, doc: Doc, key: string | null = null) {
      s.setPreview(null);
      s.setFloating(null);
      const h = s.history();
      s.setHistory(key !== null && key === mergeKey ? amend(h, label, doc) : push(h, label, doc, { steps: prefs.historyStates, bytes: Infinity }));
      mergeKey = key;
      enforceMemoryBudget();
      renderRequested();
    }

    /**
     * Keeps everything open documents retain (their states and history)
     * within Preferences ▸ Performance ▸ Memory Usage, freeing the oldest
     * history state of whichever document holds the most, one at a time.
     */
    function enforceMemoryBudget() {
      const budget = prefs.memoryUsageMB * 2 ** 20;
      const list = sessions();
      let total = list.reduce((sum, x) => sum + historyBytes(x.history()), 0);
      let freed = false;
      while (total > budget) {
        let best: SessionInternals | null = null;
        for (const x of list) if (x.history().entries.length > 1 && (!best || historyBytes(x.history()) > historyBytes(best.history()))) best = x;
        const next = best && dropOne(best.history());
        if (!best || !next) break;
        total += historyBytes(next) - historyBytes(best.history());
        best.setHistory(next);
        freed = true;
      }
      if (freed && memoryNow.ram === "ok") updateMemory({ ram: "limited" });
      else if (!freed && total < budget * 0.75 && memoryNow.ram === "limited") updateMemory({ ram: "ok" });
    }

    /**
     * An allocation failed: abandon the operation, free every undo state
     * but the current one (and the clipboard), and say so. Documents
     * themselves are never touched.
     */
    function outOfMemory() {
      for (const x of sessions()) {
        x.setPreview(null);
        x.setFloating(null);
        x.setOverlay(null);
        let h: History | null = x.history();
        while (h && h.entries.length > 1) h = dropOne(h);
        if (h) x.setHistory(h);
      }
      clipboard = null;
      mergeKey = null;
      updateMemory({ ram: "exhausted" });
      reportError(`${OUT_OF_MEMORY} Undo history was cleared to free memory.`);
      renderRequested();
    }

    /** Runs `fn`, turning allocation failures into {@link outOfMemory} instead of a broken state. */
    function guard<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
      return (...args) => {
        try {
          return fn(...args);
        } catch (err) {
          if (!isOutOfMemory(err)) throw err;
          try {
            withTool((ctx) => tools.byId[currentTool].cancel?.(ctx));
          } catch {
            // The tool's own state may be what failed; it's reset below regardless.
          }
          outOfMemory();
          return undefined;
        }
      };
    }

    /**
     * Records a result computed asynchronously. The preview stays up and
     * input is blocked meanwhile; if the document changed underneath anyway
     * (it can't through the UI), the stale result is dropped rather than
     * overwriting newer history.
     */
    function commitAsync(s: SessionInternals, label: string, result: Promise<Doc>, key: string | null = null, landed?: () => void) {
      const base = s.doc();
      void track(result).then(
        (doc) => {
          if (s.doc() === base) {
            commitTo(s, label, doc, key);
            landed?.();
          } else s.setPreview(null);
          if (pending === 0) runShapeEdit();
        },
        (err: unknown) => {
          s.setPreview(null);
          s.setFloating(null);
          if (isOutOfMemory(err)) outOfMemory();
          else reportError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (pending === 0) runShapeEdit();
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
     * Switching away from Free Transform or Crop applies it. Re-entrant calls
     * (the transform session restoring its previous tool as it ends) are ignored.
     */
    function setTool(id: ToolId) {
      if (switching || id === currentTool) return;
      const prev = tools.byId[currentTool];
      switching = true;
      setToolId(id);
      withTool((ctx) => (prev.commitOnSwitch ? prev.commit?.(ctx) : prev.cancel?.(ctx)));
      withTool((ctx) => tools.byId[id].activate?.(ctx));
      switching = false;
    }

    // Tools catch up with the document (undo, another tab) and their settings (the crop ratio, Classic Mode).
    createEffect(
      () => {
        const s = active();
        const c = settings.crop;
        return [s, s?.doc(), toolId(), c.constraint, c.classic, c.autoCenter];
      },
      () => {
        if (pending === 0) withTool((ctx) => tools.byId[currentTool].sync?.(ctx));
      },
    );

    /** Runs an action unless a commit is still being computed; allocation failures are contained. */
    const whenIdle = <A extends unknown[]>(fn: (...args: A) => void) => {
      const guarded = guard(fn);
      return (...args: A) => {
        if (pending === 0) guarded(...args);
      };
    };

    function openDocument(doc: Doc, name: string, label = "Open", smartLink: SmartLink | null = null) {
      cancelTool();
      const s = createSession(doc, name, label, smartLink);
      const { width, height } = viewportSize();
      s.setView(fitView(doc.width, doc.height, width, height));
      setSessions((list) => [...list, s]);
      setActiveId(s.id);
      enforceMemoryBudget();
      return s as DocumentSession;
    }

    function closeDocument(id: string) {
      if (active()?.id === id) cancelTool();
      const list = sessions();
      const i = list.findIndex((s) => s.id === id);
      if (i < 0) return;
      const rest = list.filter((s) => s.id !== id);
      setSessions(() => rest);
      if (activeIdNow === id) setActiveId(rest[Math.min(i, rest.length - 1)]?.id ?? null);
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
      s.setView(fitView(s.doc().width, s.doc().height, width, height, 24, maxZoom, s.view().rotation));
    }

    function actualPixels() {
      const s = active();
      if (!s) return;
      const { width, height } = viewportSize();
      const d = s.doc();
      s.setView(placeAt(1, s.view().rotation ?? 0, { x: d.width / 2, y: d.height / 2 }, { x: Math.round(width / 2), y: Math.round(height / 2) }));
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

    /** A pixel edit of the edit target (the active layer, or its mask); smart objects and shapes must be rasterized first. */
    function pixelEdit(label: string, fn: (d: Doc, t: EditTarget) => Doc) {
      const s = active();
      if (!s || !editableTarget(s, () => pixelEdit(label, fn))) return;
      edit(label, (d) => {
        const t = editTarget(d);
        return t ? fn(d, t) : d;
      });
    }

    // --- Clipboard -------------------------------------------------------------
    // The system clipboard gets a PNG (see the UI); pasting our own copy back
    // uses these pixels, losslessly and without re-decoding.
    let clipboard: Floating | null = null;

    function copy(merged: boolean): Floating | null {
      const s = active();
      const d = s?.doc();
      const l = d && activeLayer(d);
      if (!d || !l || (!merged && !hasPixels(l))) return null;
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

    /** Cut: copies, then clears the selection (after rasterizing, if the user agrees). */
    function cut(): Floating | null {
      const s = active();
      const l = s && activeLayer(s.doc());
      if (pending > 0 || !s || !l || !hasPixels(l)) return null;
      if (l.content.kind !== "pixels") return void offerRasterize(s, l, () => void cut()), null;
      const f = copy(false);
      if (f) edit("Cut", (d) => updateLayer(d, l.id, { pixels: clearPixels(l.pixels, d.selection) }));
      return f;
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
      void track(smartObjectLayer(base, source, raster)).then(
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
      const old = [...walk(pd.layers)].find((l) => l.content.kind === "smart" && l.content.source.id === link.sourceId);
      if (!old || old.content.kind !== "smart") {
        reportError("The Smart Object no longer exists in its document.");
        return true;
      }
      const source: SmartSource = {
        ...old.content.source,
        width: cd.width,
        height: cd.height,
        pixels: pixelsFromImage(cd.width, cd.height, flatten(cd)),
        file: null,
      };
      const clip = docRect(pd);
      const update = async () => {
        let d = pd;
        for (const l of walk(pd.layers)) {
          if (l.content.kind !== "smart" || l.content.source.id !== link.sourceId) continue;
          // As in Photoshop: same transform, centred where the old contents were.
          const placement = resizedPlacement(l.content.placement, cd.width, cd.height);
          const { content, pixels } = await withContent(l, { kind: "smart", source, placement }, clip, raster);
          d = updateLayer(d, l.id, { content, pixels });
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
    /**
     * Shape options apply to the next shape and, with a shape tool active, to
     * the selected shape layer. The change shows at once (the renderer draws
     * the vector); its pixels follow from the GPU. Changes made meanwhile
     * (dragging a colour) collapse into the latest, which always lands, and
     * consecutive changes coalesce into one history step.
     */
    /**
     * Shape options (the options bar). With a shape layer selected and a
     * shape tool active they edit the layer, as in Photoshop. Edits arrive
     * faster than they're rasterized, so each builds on the latest one asked
     * for, not on what's been committed (or rendered in the options bar) so
     * far; a stroke patch changes only the stroke properties it names.
     */
    function setShapeOptions(patch: ShapeOptionsPatch) {
      const s = active();
      const l = s && activeLayer(s.doc());
      const editing = !!s && !!l && l.content.kind === "shape" && SHAPE_TOOLS.includes(currentTool);
      const c = editing ? latestShape(s!, l!) : null;
      const { stroke: strokePatch, ...rest } = patch;
      const baseStroke = c ? c.style.stroke : snapshot(settings).shape.stroke;
      const resolved: Partial<ShapeSettings> =
        strokePatch === undefined ? rest : { ...rest, stroke: strokePatch && { ...(baseStroke ?? DEFAULT_STROKE), ...strokePatch } };
      const next = { ...snapshot(settings).shape, ...resolved };
      setSettings((st) => void Object.assign(st.shape, resolved));
      if (!c) return;
      const style =
        "fill" in patch || "stroke" in resolved
          ? { fill: "fill" in patch ? shapeStyle(next, foreground()).fill : c.style.fill, stroke: "stroke" in resolved ? next.stroke : c.style.stroke }
          : c.style;
      const g = c.geometry;
      const geometry =
        (g.kind === "rectangle" && "radius" in patch) || (g.kind === "polygon" && ("sides" in patch || "starRatio" in patch))
          ? shapeGeometry(g.kind as ShapeToolId, next)
          : g;
      if (style === c.style && geometry === g) return;
      shapeEdit = { s: s!, id: l!.id, content: { ...c, style, geometry } };
      requestedShape = shapeEdit;
      s!.setPreview(updateLayer(s!.doc(), l!.id, { content: shapeEdit.content }));
      renderRequested();
      if (pending === 0) runShapeEdit();
    }

    type ShapeEdit = { s: SessionInternals; id: string; content: Extract<LayerContent, { kind: "shape" }> };
    let shapeEdit: ShapeEdit | null = null;
    /** The last shape edit asked for: while edits are queued or rasterizing, the next builds on it. */
    let requestedShape: ShapeEdit | null = null;
    const latestShape = (s: SessionInternals, l: Layer) => {
      const inFlight = shapeEdit !== null || pending > 0;
      const r = requestedShape;
      return inFlight && r && r.s === s && r.id === l.id ? r.content : (l.content as ShapeEdit["content"]);
    };

    function runShapeEdit() {
      const e = shapeEdit;
      shapeEdit = null;
      if (!e || !sessions().includes(e.s)) return;
      const d = e.s.doc();
      const l = layerById(d, e.id);
      if (!l || l.content.kind !== "shape") return;
      const { content } = e;
      const shown = updateLayer(d, e.id, { content });
      e.s.setPreview(shown);
      const pixels = raster.shape(content.geometry, content.style, placementMapping(content.placement), docRect(d));
      commitAsync(e.s, "Shape Properties", pixels.then((rendered) => updateLayer(d, e.id, { content, pixels: rendered })), `shape:${e.id}`);
    }

    /** Applies an adjustment program to the edit target, within the selection, as one step (computed on the GPU). */
    function applyProgram(label: string, program: (pixels: Pixels, d: Doc) => Program) {
      const s = active();
      const t = s && editableTarget(s, () => applyProgram(label, program));
      if (!s || !t) return;
      cancelTool();
      const d = s.doc();
      // A mask is adjusted as all its values over the canvas, not just what's been painted on it.
      const mask = t.mask ? t.layer.mask! : null;
      const pixels = mask ? maskValues(mask, docRect(d)) : t.pixels;
      const p = program(pixels, d);
      const result = adjust(pixels, p, d.selection).then((out) =>
        mask ? updateLayer(d, t.layer.id, { mask: { ...mask, pixels: out, background: adjustedBackground(mask, p, d.selection) } }) : withTargetPixels(d, t, out),
      );
      commitAsync(s, label, result);
    }

    /** Adjusts pixels on the GPU (the CPU reference without one). */
    async function adjust(pixels: Pixels, p: Program, selection: Doc["selection"]): Promise<Pixels> {
      return gpu ? gpu.adjust(pixels, p, selection) : adjustPixels(pixels, p, selection);
    }

    /** A new mask: from the selection (Reveal/Hide Selection), else Reveal All / Hide All. */
    function maskFor(d: Doc, hide: boolean): LayerMask {
      const base = hide ? REVEAL_ALL : HIDE_ALL;
      if (!d.selection) return hide ? HIDE_ALL : REVEAL_ALL;
      const shade = hide ? 0 : 255;
      return { ...base, pixels: fillPixels(NO_PIXELS, d.selection.bounds, { r: shade, g: shade, b: shade }, d.selection) };
    }

    /** What Ctrl+E does to the active layer, as the Layer menu names it. */
    function mergeLabel(d: Doc): string | null {
      const p = locate(d.layers, d.activeLayerId);
      if (!p) return null;
      const l = p.siblings[p.index];
      if (isGroup(l)) return "Merge Group";
      if (!isClipped(p.siblings, p.index) && p.siblings[p.index + 1]?.clipped) return "Merge Clipping Mask";
      return "Merge Down";
    }

    // --- Type ---------------------------------------------------------------------

    /** Runs `fn` on the Type tools' controller, with the active document's context. */
    const typing = <R>(fn: (ctx: ToolContext) => R): R | undefined => {
      const s = active();
      return s && pending === 0 ? guard(() => fn(context(s)))() : undefined;
    };

    /** What the type panels show and change: the text being edited (its selection), else the active type layer (all of it). */
    function textTarget(): { readonly content: TextContent; readonly range: TextRange; readonly editing: boolean; readonly layerId: string } | null {
      const s = active();
      const o = s?.overlay();
      if (o?.kind === "text") return { content: o.content, range: range(o.anchor, o.focus), editing: true, layerId: o.layerId };
      const l = s && activeLayer(s.doc());
      if (l?.content.kind === "text") return { content: l.content, range: { start: 0, end: l.content.text.length }, editing: false, layerId: l.id };
      return null;
    }

    /** A type layer's content changed, as one history step: laid out and rendered again. */
    function typeLayerEdit(label: string, f: (c: TextContent) => TextContent, key: string | null = null) {
      edit(
        label,
        (d) => {
          const l = activeLayer(d);
          if (!l || l.content.kind !== "text") return d;
          const content = { ...f(l.content), stale: false };
          return updateLayer(d, l.id, { content, pixels: renderDrawing(drawText(content), docRect(d)) });
        },
        key,
      );
    }

    /**
     * Character attributes: on the selection while editing type, on the
     * whole active type layer, else on what new type takes (the Type tools'
     * settings).
     */
    function formatCharacters(patch: Partial<CharStyle> | ((s: CharStyle) => Partial<CharStyle>), key?: string) {
      const t = textTarget();
      if (t?.editing) return typing((ctx) => tools.type.format(ctx, patch));
      if (t) {
        return typeLayerEdit("Edit Type Layer", (c) => {
          let out = c;
          let pos = 0;
          for (const run of c.runs) {
            if (run.length) out = setCharStyle(out, { start: pos, end: pos + run.length }, typeof patch === "function" ? patch(run.style) : patch);
            pos += run.length;
          }
          return c.text.length ? out : setCharStyle(c, { start: 0, end: 0 }, typeof patch === "function" ? patch(c.runs[0].style) : patch);
        }, key ? `char:${key}` : null);
      }
      setSettings((st) => void Object.assign(st.type.char, typeof patch === "function" ? patch(snapshot(settings).type.char) : patch));
    }

    function formatParagraphs(patch: Partial<ParagraphStyle>, key?: string) {
      const t = textTarget();
      if (t?.editing) return typing((ctx) => tools.type.formatParagraph(ctx, patch));
      if (t) return typeLayerEdit("Edit Type Layer", (c) => setParagraphStyle(c, { start: 0, end: c.text.length }, patch), key ? `para:${key}` : null);
      setSettings((st) => void Object.assign(st.type.paragraph, patch));
    }

    /** A change to the whole of the type (orientation, anti-aliasing, warp, frame). */
    function updateType(label: string, f: (c: TextContent) => TextContent) {
      const t = textTarget();
      if (t?.editing) return typing((ctx) => tools.type.update(ctx, f));
      if (t) typeLayerEdit(label, f);
    }

    const editor = {
      tools,
      sessions: sessions as Accessor<readonly DocumentSession[]>,
      active: active as Accessor<DocumentSession | null>,
      setActive: (id: string) => {
        cancelTool();
        setActiveId(id);
      },
      openDocument,
      newDocument: (opts: NewDocumentOptions, name = "Untitled") => openDocument(createDocument(opts), name, "New"),
      closeDocument: (id: string) => {
        closeDocument(id);
        enforceMemoryBudget();
      },
      renameDocument: (id: string, name: string) => sessions().find((s) => s.id === id)?.setName(name),
      /** Records `doc` as what's on disk (the user may keep editing while a save is in flight). */
      markSaved: (id: string, doc: Doc | null) => sessions().find((s) => s.id === id)?.markSaved(doc),

      tool: toolId,
      setTool,
      settings,
      setSettings,
      setShapeOptions,
      /** Type: the session's input, and formatting (see formatCharacters). */
      type: {
        session: () => {
          const o = active()?.overlay();
          return o?.kind === "text" ? o : null;
        },
        target: textTarget,
        input: (text: string) => typing((ctx) => tools.type.input(ctx, text)),
        paste: (piece: Pick<TextContent, "text" | "runs">) => typing((ctx) => tools.type.paste(ctx, piece)),
        copy: () => tools.type.copy(),
        deleteBackward: (unit: "char" | "word" = "char") => typing((ctx) => tools.type.deleteBackward(ctx, unit)),
        deleteForward: (unit: "char" | "word" = "char") => typing((ctx) => tools.type.deleteForward(ctx, unit)),
        navigate: (motion: Motion, extend = false) => typing((ctx) => tools.type.navigate(ctx, motion, extend)),
        select: (anchor: number, focus: number) => typing((ctx) => tools.type.select(ctx, anchor, focus)),
        selectAll: () => typing((ctx) => tools.type.selectAll(ctx)),
        compose: (text: string, done: boolean) => typing((ctx) => tools.type.compose(ctx, text, done)),
        undo: () => !!typing((ctx) => tools.type.undo(ctx)),
        redo: () => !!typing((ctx) => tools.type.redo(ctx)),
        toggleHighlight: () => typing((ctx) => tools.type.toggleHighlight(ctx)),
        setTransforming: (on: boolean) => typing((ctx) => tools.type.setTransforming(ctx, on)),
        commit: () => typing((ctx) => tools.type.commit(ctx)),
        discard: () => typing((ctx) => tools.type.discard(ctx)),
        /** Edits a type layer's text (double-clicking its thumbnail selects it all). */
        edit: (layerId: string, select: "all" | "end" = "all") => {
          if (!currentTool.startsWith("type-")) setTool("type-horizontal");
          typing((ctx) => tools.type.edit(ctx, layerId, select));
        },
        formatCharacters,
        formatParagraphs,
        update: updateType,
      },
      foreground,
      background,
      setForeground,
      setBackground,
      swapColors() {
        const f = foreground();
        setForeground(background());
        setBackground(f);
      },
      /** Default Colors (D): black on white, or white on black while a mask is the target, as in Photoshop. */
      resetColors() {
        const d = active()?.doc();
        const mask = !!d && !!editTarget(d)?.mask;
        setForeground(mask ? WHITE : BLACK);
        setBackground(mask ? BLACK : WHITE);
      },

      // Pointer input, already converted to document space by the viewport.
      busy,
      pointerDown: whenIdle((e: ToolEvent) => withTool((ctx) => tools.byId[currentTool].down?.(ctx, e))),
      /** Whether the current tool wants only the latest of a frame's pointer moves. */
      latestMoveOnly: () => !!tools.byId[currentTool].latestMoveOnly,
      pointerMove: whenIdle((e: ToolEvent) => withTool((ctx) => tools.byId[currentTool].move?.(ctx, e))),
      pointerUp: whenIdle((e: ToolEvent) =>
        withTool((ctx, s) => {
          tools.byId[currentTool].up?.(ctx, e);
          // Smart guides show only while dragging.
          s.setSmartGuides([]);
        }),
      ),
      cursor: (e: ToolEvent | null) => {
        const s = active();
        return s ? (tools.byId[toolId()].cursor?.(context(s), e) ?? "default") : "default";
      },
      /** A plain key for the current tool (the Crop tool's H, O, X, P, I); true when it used it. */
      toolKey(e: ToolKey): boolean {
        let used = false;
        if (pending === 0) withTool((ctx) => (used = !!tools.byId[currentTool].key?.(ctx, e)));
        return used;
      },
      /** Rotate Crop Box: portrait ⇄ landscape. */
      rotateCropBox: whenIdle(() => currentTool === "crop" && withTool((ctx) => tools.crop.rotateBox(ctx))),
      /** Image ▸ Crop: to the selection's bounds, deleting what's outside. */
      cropToSelection: whenIdle(() => {
        const s = active();
        const b = s?.doc().selection?.bounds;
        if (!s || !b) return;
        cancelTool();
        const d = s.doc();
        const t = { matrix: affine3(translation(-b.x, -b.y)), width: b.w, height: b.h, lengthScale: 1, filter: "nearest" as const, clipToCanvas: true };
        // What was on screen stays put, as with Canvas Size.
        commitAsync(s, "Crop", transformDocument(d, t, raster), null, () =>
          s.setView(followRemap(s.view(), viewportSize(), { width: b.w, height: b.h }, (p) => ({ x: p.x - b.x, y: p.y - b.y }), false)),
        );
      }),
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

      // View ▸ Show, Snap, Snap To, Rulers, Lock Guides: application-wide and remembered.
      viewOptions,
      setViewOptions(patch: Partial<ViewOptions>) {
        viewNow = { ...viewNow, ...patch };
        setViewOptionsSignal(viewNow);
        saveViewOptions(viewNow);
      },
      // Guides: part of the document, so each change is a history step.
      addGuide: whenIdle((orientation: Guide["orientation"], position: number) => guideEdit("New Guide", (g) => [...g, { orientation, position }])),
      clearGuides: whenIdle(() => guideEdit("Clear Guides", (g) => (g.length ? [] : g))),
      /**
       * Where a guide dragged to `p` (document space) lands: snapped like
       * anything else (but not to other guides), or with Shift to the
       * ruler's ticks.
       */
      guidePosition(orientation: Guide["orientation"], p: Vec2, shift: boolean): number {
        const s = active();
        return s ? guidePosition(snapperFor(s), s.view().zoom, orientation, p, shift) : 0;
      },
      endGuideDrag: () => active()?.setSmartGuides([]),

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
      /** The viewport's renderer provides commit-quality GPU resampling and shape rasterization. */
      setGpu: (r: GpuRaster | null) => {
        gpu = r;
      },
      onError: (fn: (message: string) => void) => {
        reportError = fn;
      },
      preferences,
      /** Applies and persists preferences; a lower History States limit trims history immediately. */
      setPreferences(p: Preferences) {
        prefs = p;
        setPreferencesSignal(p);
        savePreferences(p);
        for (const x of sessions()) x.setHistory((h) => limitSteps(h, p.historyStates));
        enforceMemoryBudget();
      },
      memory,
      /** The renderer reports display quality reductions under GPU memory pressure. */
      setGpuLevel: (gpuLevel: number) => updateMemory({ gpuLevel }),
      onGpuReset: (fn: () => void) => {
        gpuReset = fn;
      },
      /** Asks the renderer to try full display quality again. */
      retryFullQuality: () => gpuReset(),
      /** Dismisses the "exhausted" state once the user has seen it. */
      acknowledgeMemory: () => memoryNow.ram === "exhausted" && updateMemory({ ram: "ok" }),
      /** The UI's modal OK/Cancel prompt. */
      /** The UI's Paragraph Text Size dialog (Alt-click with a Type tool). */
      onAskBoxSize: (fn: () => Promise<{ width: number; height: number } | null>) => {
        askBoxSize = fn;
      },
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
        pixelEdit("Fill", (d, t) => withTargetPixels(d, t, fillPixels(t.pixels, docRect(d), t.mask ? maskTone(color) : color, d.selection))),
      ),
      /** Delete: erases the selection; on a mask, fills it with the background colour (as Photoshop does). */
      clear: whenIdle(() =>
        pixelEdit("Clear", (d, t) =>
          withTargetPixels(d, t, t.mask ? fillPixels(t.pixels, docRect(d), maskTone(background()), d.selection) : clearPixels(t.pixels, d.selection)),
        ),
      ),

      // Clipboard. `copy`/`cut` return the pixels for the system clipboard.
      copy: (merged = false) => (pending === 0 ? copy(merged) : null),
      cut,
      /** Pastes the internal clipboard (our own copy). False when it's empty. */
      paste: (inPlace = false): boolean => {
        if (pending > 0 || !clipboard || !active()) return false;
        paste(clipboard, inPlace);
        return true;
      },
      /** Pastes decoded pixels from another application as a new layer. */
      pasteImage: whenIdle((pixels: Pixels) => {
        const bounds = contentBounds(pixels);
        if (!isEmpty(bounds)) paste({ pixels, bounds }, false);
      }),
      placeEmbedded: whenIdle(placeEmbedded),
      /**
       * Image ▸ Image Size. With `resample`, everything scales to the new
       * pixel dimensions; without, only the resolution changes.
       */
      imageSize: whenIdle((o: ImageSizeOptions & { resample: boolean }) => {
        const s = active();
        if (!s) return;
        cancelTool();
        const d = s.doc();
        if (!o.resample) {
          if (o.resolution !== resolutionOf(d)) commitTo(s, "Image Size", setResolution(d, o.resolution));
          return;
        }
        if (o.width === d.width && o.height === d.height && o.resolution === resolutionOf(d)) return;
        const sx = o.width / d.width, sy = o.height / d.height;
        // Same zoom (as Photoshop); the centred point of the image stays centred.
        commitAsync(s, "Image Size", imageSize(d, o, raster), null, () =>
          s.setView(followRemap(s.view(), viewportSize(), o, (p) => ({ x: p.x * sx, y: p.y * sy }), true)),
        );
      }),
      /**
       * Image Size's preview: what it would produce within `window` (a
       * rectangle of the new image), drawn at `scale` — rendered in a worker,
       * off the main thread. `endImageSizePreview` frees it.
       */
      imageSizePreview(o: ImageSizeOptions & { resample: boolean }, window: Rect, scale: number): Promise<ImageData | null> {
        const s = active();
        if (!s || window.w < 1 || window.h < 1) return Promise.resolve(null);
        previews ??= createPreviewWorker();
        return previews.render(s.doc(), o, window, scale);
      },
      endImageSizePreview() {
        previews?.dispose();
        previews = null;
      },
      /** Image ▸ Canvas Size. */
      canvasSize: whenIdle((width: number, height: number, anchor: Anchor) => {
        const s = active();
        if (!s) return;
        cancelTool();
        const d = s.doc();
        if (width === d.width && height === d.height) return;
        const { x: dx, y: dy } = canvasOffset(d, width, height, anchor);
        // Same zoom; what was on screen stays put, with the new canvas around it.
        commitAsync(s, "Canvas Size", resizeCanvas(d, width, height, anchor, raster), null, () =>
          s.setView(followRemap(s.view(), viewportSize(), { width, height }, (p) => ({ x: p.x + dx, y: p.y + dy }), false)),
        );
      }),
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
          if (!d.selection || !hasPixels(l)) return duplicateLayer(d, l.id);
          const f = copyPixels(d, l);
          return f ? addLayer(d, createLayer({ name: nextLayerName(d), pixels: f.pixels }), l.id, "above") : d;
        }),
      ),
      layerViaCut: whenIdle(() =>
        pixelEdit("Layer Via Cut", (d, t) => {
          const f = !t.mask && d.selection && copyPixels(d, t.layer);
          if (!f) return d;
          const cut = updateLayer(d, t.layer.id, { pixels: clearPixels(t.pixels, d.selection) });
          return addLayer(cut, createLayer({ name: nextLayerName(d), pixels: f.pixels }), t.layer.id, "above");
        }),
      ),
      /** Deletes a layer; a group with its contents, or (`groupOnly`) just the group, its layers staying where they were. */
      deleteLayer: whenIdle((id?: string, groupOnly: boolean = false) =>
        edit(groupOnly ? "Delete Group" : "Delete Layer", (d) => (groupOnly ? ungroup(d, id ?? d.activeLayerId) : removeLayer(d, id ?? d.activeLayerId))),
      ),
      /**
       * Merge Down (Ctrl+E), which on a group is Merge Group and on a
       * clipping group's base Merge Clipping Mask.
       */
      mergeDown: whenIdle(() => layerEdit(mergeLabel(active()!.doc()) ?? "Merge Down", (d, l) => mergeDown(d, l.id))),
      convertToSmartObject: whenIdle(() => layerEdit("Convert to Smart Object", (d, l) => convertToSmartObject(d, l.id))),
      rasterizeLayer: whenIdle(() => layerEdit("Rasterize Layer", (d, l) => rasterizeLayer(d, l.id))),
      /** Layer ▸ Arrange: up/down one step within its group (or the document), or to its top/bottom. */
      arrange: whenIdle((to: "forward" | "backward" | "front" | "back") => {
        const labels = { forward: "Bring Forward", backward: "Send Backward", front: "Bring to Front", back: "Send to Back" };
        layerEdit(labels[to], (d, l) => {
          const p = locate(d.layers, l.id)!;
          const target = { forward: p.index + 1, backward: p.index - 1, front: p.siblings.length - 1, back: 0 }[to];
          return target === p.index || target < 0 || target >= p.siblings.length ? d : moveLayerTo(d, l.id, target);
        });
      }),
      /** Drops a layer above or below another, or into a group (Layers panel drag and drop). */
      moveLayer: whenIdle((id: string, targetId: string, placement: LayerPlacement) =>
        edit("Layer Order", (d) => moveLayerRelative(d, id, targetId, placement)),
      ),
      /** Selects a layer, targeting its pixels or (`mask`) its mask. Not a history step, as in Photoshop. */
      selectLayer: whenIdle((id: string, mask: boolean = false) => {
        cancelTool();
        const s = active();
        const d = s?.doc();
        if (!s || !d) return;
        // Clicking a thumbnail ends viewing the mask, as in Photoshop.
        s.setMaskView(false);
        renderRequested();
        if (d.activeLayerId === id && !!d.maskTargeted === mask) return;
        s.setHistory((h) => replaceCurrent(h, { ...currentDoc(h), activeLayerId: id, maskTargeted: mask }));
      }),
      setLayerProps: whenIdle((id: string, patch: Partial<Pick<Layer, "name" | "visible" | "opacity" | "blendMode">> & { blendMode?: LayerBlendMode }) => {
        const [label, key] =
          "opacity" in patch ? ["Opacity Change", `opacity:${id}`]
          : "blendMode" in patch ? ["Blending Change", null]
          : "visible" in patch ? [patch.visible ? "Show Layer" : "Hide Layer", null]
          : ["Rename Layer", null];
        edit(label, (d) => updateLayer(d, id, patch), key);
      }),
      /** Expands or collapses a group in the Layers panel (not a history step). */
      setGroupOpen(id: string, open: boolean) {
        const s = active();
        const g = s && layerById(s.doc(), id);
        if (!s || !g || !isGroup(g) || g.content.open === open) return;
        s.setHistory((h) => replaceCurrent(h, updateLayer(currentDoc(h), id, { content: { ...g.content, open } })));
      },

      // Groups
      /** New Group: an empty group above the active layer. */
      newGroup: whenIdle(() => edit("New Group", (d) => addLayer(d, createGroup(numberedName(d, "Group")), d.activeLayerId, "above"))),
      /** Group Layers (Ctrl+G). */
      groupLayers: whenIdle((ids?: readonly string[]) => edit("Group Layers", (d) => groupLayers(d, ids ?? [d.activeLayerId]))),
      /** Ungroup Layers (Shift+Ctrl+G). */
      ungroup: whenIdle(() =>
        edit("Ungroup Layers", (d) => {
          const l = activeLayer(d);
          return l && isGroup(l) ? ungroup(d, l.id) : d;
        }),
      ),

      // Clipping masks
      /**
       * Create/Release Clipping Mask (Alt+Ctrl+G), or Alt-clicking between
       * layers: clips a layer to the one below; on a clipped layer, releases
       * it and the clipped layers above it, as Photoshop does.
       */
      toggleClippingMask: whenIdle((id?: string) =>
        edit("Clipping Mask", (d) => {
          const p = locate(d.layers, id ?? d.activeLayerId);
          if (!p || p.index === 0) return d;
          const l = p.siblings[p.index];
          if (!l.clipped) return updateLayer(d, l.id, { clipped: true });
          let out = d;
          for (let i = p.index; i < p.siblings.length && p.siblings[i].clipped; i++) out = updateLayer(out, p.siblings[i].id, { clipped: false });
          return out;
        }),
      ),

      // Layer masks
      /**
       * Add Layer Mask: Reveal All, or from the selection (Reveal Selection).
       * `hide` (Alt-click) gives Hide All / Hide Selection. The mask becomes
       * the target, and the selection is dropped, as in Photoshop.
       */
      addMask: whenIdle((hide: boolean = false) =>
        edit("Add Layer Mask", (d) => {
          const l = activeLayer(d);
          if (!l || l.mask) return d;
          return { ...updateLayer(d, l.id, { mask: maskFor(d, hide) }), maskTargeted: true, selection: null };
        }),
      ),
      deleteMask: whenIdle(() =>
        edit("Delete Layer Mask", (d) => {
          const l = activeLayer(d);
          return l?.mask ? { ...updateLayer(d, l.id, { mask: null }), maskTargeted: false } : d;
        }),
      ),
      /** Apply Layer Mask: into a pixel layer's transparency. */
      applyMask: whenIdle(() =>
        edit("Apply Layer Mask", (d) => {
          const l = activeLayer(d);
          if (!l?.mask || l.content.kind !== "pixels") return d;
          return { ...updateLayer(d, l.id, { pixels: l.mask.enabled ? applyMask(l.pixels, l.mask) : l.pixels, mask: null }), maskTargeted: false };
        }),
      ),
      /** Alt-click a mask thumbnail: shows the mask alone (and targets it), or stops showing it. */
      toggleMaskView: whenIdle((id: string) => {
        const s = active();
        const d = s?.doc();
        if (!s || !d || !layerById(d, id)?.mask) return;
        const on = !(s.maskView() && d.activeLayerId === id);
        if (d.activeLayerId !== id || !d.maskTargeted) s.setHistory((h) => replaceCurrent(h, { ...currentDoc(h), activeLayerId: id, maskTargeted: true }));
        s.setMaskView(on);
        renderRequested();
      }),
      /**
       * Ctrl-click a thumbnail: the layer's transparency, or its mask, as the
       * selection; with Shift added to it, with Alt subtracted, with both intersected.
       */
      loadSelection: whenIdle((id: string, from: "layer" | "mask", mode: SelectionMode = "replace") =>
        edit("Load Selection", (d) => {
          const l = layerById(d, id);
          if (!l || (from === "mask" ? !l.mask : !hasPixels(l))) return d;
          const shape = selectionFrom(from === "mask" ? l.mask! : l.pixels, d.width, d.height);
          return { ...d, selection: combine(d.selection, shape, mode) };
        }),
      ),
      /** Disable/Enable Layer Mask (Shift-click its thumbnail), and linking it to the layer. */
      setMaskProps: whenIdle((id: string, patch: Partial<Pick<LayerMask, "enabled" | "linked" | "density">>) =>
        edit(
          "density" in patch ? "Mask Density" : "enabled" in patch ? (patch.enabled ? "Enable Layer Mask" : "Disable Layer Mask") : patch.linked ? "Link" : "Unlink",
          (d) => {
            const l = layerById(d, id);
            return l?.mask ? updateLayer(d, id, { mask: { ...l.mask, ...patch } }) : d;
          },
          "density" in patch ? `density:${id}` : null,
        ),
      ),

      // Adjustments
      /**
       * New adjustment layer above the active layer, with Photoshop's
       * defaults; its mask is the selection (else Reveal All).
       */
      newAdjustmentLayer: whenIdle((kind: AdjustmentKind) =>
        edit(`New ${adjustmentLabel(kind)} Layer`, (d) => {
          const layer = createLayer({
            name: numberedName(d, adjustmentLabel(kind)),
            content: { kind: "adjustment", adjustment: defaultAdjustment(kind, foreground(), background()) },
            mask: maskFor(d, false),
          });
          return { ...addLayer(d, layer, d.activeLayerId, "above"), maskTargeted: false };
        }),
      ),
      /** Changes an adjustment layer's settings (the Properties panel); consecutive changes coalesce. */
      setAdjustment: whenIdle((id: string, adjustment: Adjustment) =>
        edit(adjustmentLabel(adjustment.kind), (d) => (layerById(d, id)?.content.kind === "adjustment" ? updateLayer(d, id, { content: { kind: "adjustment", adjustment } }) : d), `adjust:${id}`),
      ),
      /**
       * Image ▸ Adjustments' live preview: the adjustment over the active
       * layer only (within the selection), drawn by the compositor. Null ends it.
       */
      previewAdjustment(adjustment: Adjustment | null) {
        const s = active();
        if (!s || pending > 0) return;
        const d = s.doc();
        const t = editTarget(d);
        if (!adjustment || !t || t.mask || t.layer.content.kind !== "pixels") return s.setPreview(null), renderRequested();
        const probe = createLayer({ name: "", content: { kind: "adjustment", adjustment }, clipped: true, mask: d.selection ? maskFor(d, false) : null });
        s.setPreview(addLayer(d, probe, t.layer.id, "above"));
        renderRequested();
      },
      /**
       * Image ▸ Adjustments: applies an adjustment to the edit target's
       * pixels (or its mask), within the selection. Computed on the GPU.
       */
      applyAdjustment: whenIdle((adjustment: Adjustment) => applyProgram(adjustmentLabel(adjustment.kind), () => compile(adjustment))),
      /** Image ▸ Adjustments ▸ Desaturate: each pixel to its HSL lightness, as Photoshop does. */
      desaturate: whenIdle(() => {
        const hs = defaultAdjustment("hue-saturation") as Extract<Adjustment, { kind: "hue-saturation" }>;
        applyProgram("Desaturate", () => compile({ ...hs, master: { ...hs.master, saturation: -100 } }));
      }),
      /** Image ▸ Adjustments ▸ Equalize: spreads the target's values (within the selection) evenly over the range. */
      equalize: whenIdle(() => applyProgram("Equalize", (pixels, d) => {
        const c = equalizeCurve(histogram(pixels, d.selection));
        return { kind: "curves", r: c, g: c, b: c, luma: false, preserveLuminosity: false };
      })),
          mergeLabel: () => (active() ? mergeLabel(active()!.doc()) : null),
    };
    return editor;
  });
}
