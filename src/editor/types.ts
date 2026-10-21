import type { BrushSettings } from "../core/brush";
import type { CropBox, CropConstraint, CropOverlay, Length } from "../core/crop";
import type { RGB } from "../core/color";
import type { Rasterizers } from "../core/content";
import type { Doc, EditTarget } from "../core/document";
import type { StrokeAlign } from "../core/shape";
import type { Rect, Vec2 } from "../core/geometry";
import type { SelectionMode } from "../core/selection";
import type { Filter } from "../core/rasterize";
import type { TransformMode, TransformState } from "../core/transform";
import type { FloatingLayer, View } from "../gpu/renderer";
import type { Snapper } from "./snapping";
import type { ViewOptions } from "./viewOptions";

export type ToolId =
  | "move"
  | "marquee-rect"
  | "marquee-ellipse"
  | "lasso"
  | "wand"
  | "brush"
  | "eraser"
  | "bucket"
  | "eyedropper"
  | "hand"
  | "zoom"
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "polygon"
  | "line"
  | "crop"
  | "perspective-crop"
  | "transform";

export type ShapeToolId = "rectangle" | "ellipse" | "triangle" | "polygon" | "line";

export interface ShapeSettings {
  /** "shape" creates a live shape layer; "pixels" fills the shape into the active layer. */
  readonly mode: "shape" | "pixels";
  /** "foreground" follows the foreground colour until a fill is picked; null = no fill. */
  readonly fill: RGB | null | "foreground";
  readonly stroke: { readonly color: RGB; readonly width: number; readonly align: StrokeAlign } | null;
  /** Rectangle corner radius. */
  readonly radius: number;
  /** Polygon sides and star ratio (1 = regular polygon). */
  readonly sides: number;
  readonly starRatio: number;
  /** Line weight. */
  readonly weight: number;
}

export type ShapeStroke = NonNullable<ShapeSettings["stroke"]>;

/** A change to shape options; a stroke patch names only the stroke properties it changes (null removes the stroke). */
export type ShapeOptionsPatch = Partial<Omit<ShapeSettings, "stroke">> & { readonly stroke?: Partial<ShapeStroke> | null };

export interface TransformSettings {
  /** Move tool: show the bounding box and handles of the active layer/selection (Photoshop's default: on). */
  readonly showControls: boolean;
  /** Maintain aspect ratio (the options bar's link); Shift inverts it while dragging. */
  readonly link: boolean;
  /** Show and allow dragging the reference point (hidden by default, as in Photoshop). */
  readonly showReference: boolean;
  readonly interpolation: Filter;
}

export interface CropSettings {
  /** The ratio menu and fields: a ratio, or W x H x Resolution. */
  readonly constraint: CropConstraint;
  /** Unchecked, cropped-away pixels are kept beyond the canvas (smart objects and shapes always keep theirs). */
  readonly deletePixels: boolean;
  readonly overlay: CropOverlay;
  /** Flips asymmetric overlays (Shift+O). */
  readonly orientation: number;
  readonly showOverlay: "always" | "auto" | "never";
  /** Classic Mode: the box moves and turns over the image, instead of the image under the box. */
  readonly classic: boolean;
  /** Off (H): nothing is shown outside the box. */
  readonly showCropped: boolean;
  /** The box is kept centred in the window (not in Classic Mode). */
  readonly autoCenter: boolean;
  readonly shield: boolean;
  /** null matches the canvas (the workspace colour). */
  readonly shieldColor: RGB | null;
  readonly shieldOpacity: number;
  /** The shield lightens while the box is being edited. */
  readonly autoAdjustOpacity: boolean;
  /** The Straighten tool is armed (or hold Ctrl). */
  readonly straighten: boolean;
}

export interface PerspectiveCropSettings {
  readonly width: Length | null;
  readonly height: Length | null;
  readonly resolution: number | null;
  readonly showGrid: boolean;
}

export interface ToolSettings {
  readonly transform: TransformSettings;
  readonly crop: CropSettings;
  readonly perspectiveCrop: PerspectiveCropSettings;
  readonly shape: ShapeSettings;
  readonly brush: BrushSettings;
  readonly eraser: BrushSettings;
  readonly selectionMode: SelectionMode;
  /** Magic wand / paint bucket colour tolerance, 0–255. */
  readonly tolerance: number;
  readonly contiguous: boolean;
}

/** Transient vector overlays drawn above the canvas in screen space. */
export type Overlay =
  | { readonly kind: "marquee"; readonly shape: "rect" | "ellipse"; readonly rect: Rect }
  | { readonly kind: "lasso"; readonly points: readonly Vec2[] }
  | { readonly kind: "transform"; readonly state: TransformState; readonly mode: TransformMode }
  /** The Move tool's bounding box, following content while it's dragged. */
  | { readonly kind: "frame"; readonly state: TransformState }
  | {
      readonly kind: "crop";
      readonly box: CropBox;
      /** What's being dragged, if anything. */
      readonly drag: "resize" | "move" | "rotate" | "draw" | "straighten" | null;
      /** The Straighten tool's line, in document space. */
      readonly line?: readonly [Vec2, Vec2];
    }
  | {
      readonly kind: "perspective-crop";
      /** Corners clicked so far, or the quad (TL, TR, BR, BL). */
      readonly points: readonly Vec2[];
      /** Whether the quad can be straightened (it's convex). */
      readonly valid: boolean;
      readonly dragging: boolean;
    };

export interface ToolEvent {
  /** Document coordinates (fractional). */
  readonly x: number;
  readonly y: number;
  /** Viewport coordinates in CSS pixels. */
  readonly screenX: number;
  readonly screenY: number;
  readonly pressure: number;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Ctrl, or Cmd on macOS. */
  readonly mod: boolean;
  /** Primary button press count (2 = double-click). */
  readonly clicks: number;
}

/**
 * Everything a tool may read or do. Tools never touch reactive state or the
 * GPU directly, which keeps them unit-testable with a plain object.
 */
export interface ToolContext {
  /** The committed document (the current history state). */
  readonly doc: Doc;
  readonly view: View;
  readonly settings: ToolSettings;
  readonly foreground: RGB;
  readonly background: RGB;
  /** Shows a provisional document (and optional floating pixels) without recording history. */
  preview(doc: Doc | null, floating?: FloatingLayer | null): void;
  /** Records a history state and clears any preview. */
  commit(label: string, doc: Doc): void;
  /**
   * Like `commit`, for results computed asynchronously (GPU resampling). The
   * preview stays up and input is blocked until it settles; `landed` runs
   * once it's recorded.
   */
  commitAsync(label: string, doc: Promise<Doc>, landed?: () => void): void;
  /** The viewport's size, in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** Changes tool settings from within a tool (keyboard toggles). */
  updateSettings(fn: (s: Writable<ToolSettings>) => void): void;
  /** Commit-quality resampling and shape rasterization (on the GPU in the app). */
  readonly raster: Rasterizers;
  /**
   * What a pixel tool edits (see `editTarget` in core/document): the active
   * layer's pixels, or its mask. Smart objects and shapes must be rasterized
   * first: the user is asked, and if they agree the layer is rasterized and
   * then, as in Photoshop, the action goes ahead (`proceed` runs it again
   * with a fresh context; actions that can't be repeated, like a brush
   * stroke, omit it). Null when there's nothing editable (a group without a
   * mask: the user is told why).
   */
  editTarget(proceed?: (ctx: ToolContext) => void): EditTarget | null;
  overlay(o: Overlay | null): void;
  /** Snapping (View ▸ Snap): where dragged points and moving boxes land. */
  readonly snap: Snapper;
  /** The View menu's toggles (whether guides are shown and locked, rulers). */
  readonly viewOptions: ViewOptions;
  /** Redraws after in-place changes to previewed pixels. */
  requestRender(): void;
  setView(v: View): void;
  setForeground(c: RGB): void;
  /** Activates another tool (e.g. leaving Free Transform). */
  setTool(id: ToolId): void;
}

export interface Tool {
  readonly id: ToolId;
  /**
   * Only the latest pointer position matters (the tool shows a state, not a
   * path), so the viewport delivers one move per frame instead of every
   * coalesced event. Painting tools need them all.
   */
  readonly latestMoveOnly?: boolean;
  cursor?(ctx: ToolContext, e: ToolEvent | null): string;
  down?(ctx: ToolContext, e: ToolEvent): void;
  move?(ctx: ToolContext, e: ToolEvent): void;
  up?(ctx: ToolContext, e: ToolEvent): void;
  /** Enter / the commit button. */
  commit?(ctx: ToolContext): void;
  /** Escape, or switching away mid-operation. */
  cancel?(ctx: ToolContext): void;
  /** Switching away applies the operation (Free Transform, Crop) rather than cancelling it. */
  readonly commitOnSwitch?: boolean;
  /** The tool was selected. */
  activate?(ctx: ToolContext): void;
  /** The document, its tab, or the tool's settings changed: catch up. */
  sync?(ctx: ToolContext): void;
  /** A key without Ctrl/Alt while the tool is selected; true when the tool used it. */
  key?(ctx: ToolContext, e: ToolKey): boolean;
}

export interface ToolKey {
  readonly key: string;
  readonly shift: boolean;
}

/** Deeply mutable, for store setters. */
export type Writable<T> = { -readonly [K in keyof T]: T[K] extends object ? Writable<T[K]> : T[K] };
