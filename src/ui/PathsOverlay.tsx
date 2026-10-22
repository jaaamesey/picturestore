import { For, Show } from "solid-js";
import { toHex } from "../core/color";
import { activeLayer, type Doc } from "../core/document";
import type { Vec2 } from "../core/geometry";
import { activeEndpoint, hasHandles, sameRef, type Knot, type Subpath } from "../core/path";
import { effectiveTarget, pathOf, validRefs } from "../editor/tools/pathEdit";
import { docToScreen } from "../editor/view";
import type { PathDisplay, PathState, PathToolId, ToolEvent, ToolId } from "../editor/types";
import type { View } from "../gpu/renderer";

const PATH_TOOLS: readonly ToolId[] = ["pen", "freeform-pen", "curvature-pen", "add-anchor", "delete-anchor", "convert-point", "path-select", "direct-select"] satisfies readonly PathToolId[];
export const isPathTool = (t: ToolId) => PATH_TOOLS.includes(t);

/** An SVG path through a component's knots, in screen space. */
function outline(s: Subpath, at: (p: Vec2) => Vec2): string {
  const n = s.knots.length;
  if (!n) return "";
  const pt = (p: Vec2) => `${at(p).x},${at(p).y}`;
  let d = `M${pt(s.knots[0].anchor)}`;
  const last = s.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = s.knots[i], b = s.knots[(i + 1) % n];
    d += ` C${pt(a.out)} ${pt(b.in)} ${pt(b.anchor)}`;
  }
  return s.closed && n > 1 ? `${d}Z` : d;
}

/**
 * The target path over the canvas, as Photoshop draws it: a line of the
 * Path options' colour and thickness; with a path tool, its anchor points
 * (hollow when not selected, solid when selected) and the direction lines of
 * selected ones, ending in filled circles. A Pen tool's Rubber Band shows the
 * segment to the pointer.
 */
export function PathsOverlay(props: {
  doc: Doc;
  view: View;
  state: PathState;
  tool: ToolId;
  display: PathDisplay;
  showTarget: boolean;
  hover: ToolEvent | null;
  rubberBand: boolean;
}) {
  const at = (p: Vec2) => docToScreen(props.view, p);
  const color = () => toHex(props.display.color);
  const target = () => {
    const t = effectiveTarget(props.doc, props.state);
    // A shape's path shows only to the path tools; the work and saved paths show whenever Target Path is on.
    if (!t || (t.kind === "layer" && !isPathTool(props.tool))) return null;
    if (t.kind !== "layer" && !props.showTarget && !isPathTool(props.tool)) return null;
    return t;
  };
  const path = () => {
    const t = target();
    return t ? pathOf(props.doc, t) : null;
  };
  const selected = () => (path() ? validRefs(path()!, props.state.selected) : []);
  const isSel = (sub: number, knot: number) => selected().some((r) => sameRef(r, { sub, knot }));
  const anchors = () => isPathTool(props.tool);
  /** Knots whose direction lines show: the selected ones. */
  const withHandles = () => {
    const p = path();
    return p ? selected().flatMap((r) => (hasHandles(p.subpaths[r.sub].knots[r.knot]) ? [p.subpaths[r.sub].knots[r.knot]] : [])) : [];
  };
  const rubber = () => {
    const p = path(), h = props.hover;
    if (!p || !h || !props.rubberBand || props.tool !== "pen") return null;
    const end = activeEndpoint(p, selected());
    if (!end) return null;
    const a = p.subpaths[end.sub].knots[end.knot];
    const to = { x: h.x, y: h.y };
    // From the point's direction line on its open side, if it has one; straight otherwise.
    const side: "in" | "out" = end.knot === 0 && p.subpaths[end.sub].knots.length > 1 ? "in" : "out";
    return `M${at(a.anchor).x},${at(a.anchor).y} C${at(a[side]).x},${at(a[side]).y} ${at(to).x},${at(to).y} ${at(to).x},${at(to).y}`;
  };
  const handlePoints = (k: Knot) => [k.in, k.out].filter((p) => p.x !== k.anchor.x || p.y !== k.anchor.y);
  return (
    <Show when={path()}>
      {(p) => (
        <g data-testid="path-overlay" data-tool={props.tool} fill="none" stroke={color()} stroke-width={props.display.thickness} stroke-linejoin="round">
          <For each={p().subpaths}>{(s) => <path d={outline(s, at)} data-testid="path-component" />}</For>
          <Show when={rubber()}>{(d) => <path d={d()} stroke-dasharray="4 3" data-testid="rubber-band" />}</Show>
          <Show when={anchors()}>
            <For each={withHandles()}>
              {(k) => (
                <For each={handlePoints(k)}>
                  {(h) => (
                    <>
                      <line x1={at(k.anchor).x} y1={at(k.anchor).y} x2={at(h).x} y2={at(h).y} stroke-width="1" />
                      <circle cx={at(h).x} cy={at(h).y} r="3.5" fill={color()} stroke="white" stroke-width="0.5" data-testid="path-handle" />
                    </>
                  )}
                </For>
              )}
            </For>
            <For each={p().subpaths}>
              {(s, si) => (
                <For each={s.knots}>
                  {(k, ki) => (
                    <rect
                      x={at(k.anchor).x - 3.5}
                      y={at(k.anchor).y - 3.5}
                      width="7"
                      height="7"
                      fill={isSel(si(), ki()) ? color() : "white"}
                      stroke={color()}
                      stroke-width="1"
                      data-testid="path-anchor"
                      data-selected={isSel(si(), ki()) ? "" : undefined}
                      data-x={k.anchor.x}
                      data-y={k.anchor.y}
                    />
                  )}
                </For>
              )}
            </For>
          </Show>
        </g>
      )}
    </Show>
  );
}

/** Whether the active layer is a shape (for the Pen tools' options). */
export const onShapeLayer = (doc: Doc) => activeLayer(doc)?.content.kind === "shape";
