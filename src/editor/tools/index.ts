import type { Tool, ToolId } from "../types";
import { createEyedropperTool, createHandTool, zoomTool } from "./navigate";
import { bucketTool, createPaintTool } from "./paint";
import { createLassoTool, createMarqueeTool, wandTool } from "./select";
import { createShapeTool } from "./shape";
import { createMoveTool, createTransformController, type TransformController } from "./transform";
import { createCropTool, type CropController } from "./crop";
import { createPerspectiveCropTool } from "./perspectiveCrop";
import { createPenTool } from "./pen";
import { createAddAnchorTool, createConvertPointTool, createDeleteAnchorTool, createDirectSelectTool, createPathSelectTool } from "./pathTools";
import { createTypeController, type TypeController } from "./type";

export interface ToolInfo {
  readonly id: Exclude<ToolId, "transform">;
  readonly label: string;
  /** Single-key shortcut, Photoshop-compatible. */
  readonly key: string;
}

/**
 * Tools shown in the toolbar, in order. Tools sharing a key form a group,
 * shown as one button with a flyout (as in Photoshop). Free Transform is
 * entered via Ctrl+T instead.
 */
export const TOOLBAR: readonly ToolInfo[] = [
  { id: "move", label: "Move Tool", key: "v" },
  { id: "marquee-rect", label: "Rectangular Marquee", key: "m" },
  { id: "marquee-ellipse", label: "Elliptical Marquee", key: "m" },
  { id: "lasso", label: "Lasso", key: "l" },
  { id: "wand", label: "Magic Wand", key: "w" },
  { id: "crop", label: "Crop Tool", key: "c" },
  { id: "perspective-crop", label: "Perspective Crop Tool", key: "c" },
  { id: "brush", label: "Brush Tool", key: "b" },
  { id: "eraser", label: "Eraser", key: "e" },
  { id: "bucket", label: "Paint Bucket", key: "g" },
  { id: "eyedropper", label: "Eyedropper", key: "i" },
  { id: "pen", label: "Pen Tool", key: "p" },
  { id: "add-anchor", label: "Add Anchor Point Tool", key: "p" },
  { id: "delete-anchor", label: "Delete Anchor Point Tool", key: "p" },
  { id: "convert-point", label: "Convert Point Tool", key: "p" },
  { id: "type-horizontal", label: "Horizontal Type Tool", key: "t" },
  { id: "type-vertical", label: "Vertical Type Tool", key: "t" },
  { id: "type-mask-vertical", label: "Vertical Type Mask Tool", key: "t" },
  { id: "type-mask-horizontal", label: "Horizontal Type Mask Tool", key: "t" },
  { id: "path-select", label: "Path Selection Tool", key: "a" },
  { id: "direct-select", label: "Direct Selection Tool", key: "a" },
  { id: "rectangle", label: "Rectangle Tool", key: "u" },
  { id: "ellipse", label: "Ellipse Tool", key: "u" },
  { id: "triangle", label: "Triangle Tool", key: "u" },
  { id: "polygon", label: "Polygon Tool", key: "u" },
  { id: "line", label: "Line Tool", key: "u" },
  { id: "hand", label: "Hand Tool", key: "h" },
  { id: "zoom", label: "Zoom Tool", key: "z" },
];

/** Toolbar groups, in order: tools sharing a shortcut key. */
export const TOOL_GROUPS: readonly (readonly ToolInfo[])[] = [...new Set(TOOLBAR.map((t) => t.key))].map((k) =>
  TOOLBAR.filter((t) => t.key === k),
);

export const SHAPE_TOOLS: readonly ToolId[] = ["rectangle", "ellipse", "triangle", "polygon", "line"];

export interface Tools {
  readonly byId: Record<ToolId, Tool>;
  readonly transform: TransformController;
  readonly crop: CropController;
  readonly type: TypeController;
}

/** Tools keep per-interaction state, so each editor gets its own instances. */
export function createTools(): Tools {
  const transform = createTransformController();
  const crop = createCropTool();
  const type = createTypeController();
  const list: Tool[] = [
    createMoveTool(transform),
    createMarqueeTool("rect"),
    createMarqueeTool("ellipse"),
    createLassoTool(),
    wandTool,
    crop,
    createPerspectiveCropTool(),
    createPaintTool("brush"),
    createPaintTool("eraser"),
    bucketTool,
    createEyedropperTool(),
    createPenTool(),
    createAddAnchorTool(),
    createDeleteAnchorTool(),
    createConvertPointTool(),
    ...type.tools,
    createPathSelectTool(),
    createDirectSelectTool(),
    createShapeTool("rectangle"),
    createShapeTool("ellipse"),
    createShapeTool("triangle"),
    createShapeTool("polygon"),
    createShapeTool("line"),
    createHandTool(),
    zoomTool,
    transform,
  ];
  return { byId: Object.fromEntries(list.map((t) => [t.id, t])) as Record<ToolId, Tool>, transform, crop, type };
}
