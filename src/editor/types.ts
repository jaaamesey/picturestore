import type { BrushSettings } from "../core/brush";
import type { RGB } from "../core/color";
import type { Doc } from "../core/document";
import type { Rect, Vec2 } from "../core/geometry";
import type { SelectionMode } from "../core/selection";
import type { TransformState } from "../core/transform";
import type { FloatingLayer, View } from "../gpu/renderer";

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
  | "transform";

export interface ToolSettings {
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
  | { readonly kind: "transform"; readonly state: TransformState };

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
  /** Shows a provisional document (and optional floating pixels) without recording history. */
  preview(doc: Doc | null, floating?: FloatingLayer | null): void;
  /** Records a history state and clears any preview. */
  commit(label: string, doc: Doc): void;
  overlay(o: Overlay | null): void;
  /** Redraws after in-place changes to previewed tiles. */
  requestRender(): void;
  setView(v: View): void;
  setForeground(c: RGB): void;
  /** Activates another tool (e.g. leaving Free Transform). */
  setTool(id: ToolId): void;
}

export interface Tool {
  readonly id: ToolId;
  cursor?(ctx: ToolContext, e: ToolEvent | null): string;
  down?(ctx: ToolContext, e: ToolEvent): void;
  move?(ctx: ToolContext, e: ToolEvent): void;
  up?(ctx: ToolContext, e: ToolEvent): void;
  /** Enter / the commit button. */
  commit?(ctx: ToolContext): void;
  /** Escape, or switching away mid-operation. */
  cancel?(ctx: ToolContext): void;
}
