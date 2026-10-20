import type { Tool, ToolId } from "../types";
import { createEyedropperTool, createHandTool, zoomTool } from "./navigate";
import { bucketTool, createPaintTool } from "./paint";
import { createLassoTool, createMarqueeTool, wandTool } from "./select";
import { createFreeTransformTool, createMoveTool, type FreeTransformTool } from "./transform";

export interface ToolInfo {
  readonly id: Exclude<ToolId, "transform">;
  readonly label: string;
  /** Single-key shortcut, Photoshop-compatible. */
  readonly key: string;
}

/** Tools shown in the toolbar, in order. Free Transform is entered via Ctrl+T instead. */
export const TOOLBAR: readonly ToolInfo[] = [
  { id: "move", label: "Move Tool", key: "v" },
  { id: "marquee-rect", label: "Rectangular Marquee", key: "m" },
  { id: "marquee-ellipse", label: "Elliptical Marquee", key: "m" },
  { id: "lasso", label: "Lasso", key: "l" },
  { id: "wand", label: "Magic Wand", key: "w" },
  { id: "brush", label: "Brush Tool", key: "b" },
  { id: "eraser", label: "Eraser", key: "e" },
  { id: "bucket", label: "Paint Bucket", key: "g" },
  { id: "eyedropper", label: "Eyedropper", key: "i" },
  { id: "hand", label: "Hand Tool", key: "h" },
  { id: "zoom", label: "Zoom Tool", key: "z" },
];

export interface Tools {
  readonly byId: Record<ToolId, Tool>;
  readonly transform: FreeTransformTool;
}

/** Tools keep per-interaction state, so each editor gets its own instances. */
export function createTools(): Tools {
  const transform = createFreeTransformTool();
  const list: Tool[] = [
    createMoveTool(),
    createMarqueeTool("rect"),
    createMarqueeTool("ellipse"),
    createLassoTool(),
    wandTool,
    createPaintTool("brush"),
    createPaintTool("eraser"),
    bucketTool,
    createEyedropperTool(),
    createHandTool(),
    zoomTool,
    transform,
  ];
  return { byId: Object.fromEntries(list.map((t) => [t.id, t])) as Record<ToolId, Tool>, transform };
}
