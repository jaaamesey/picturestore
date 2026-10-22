import { For, Show } from "solid-js";
import { toHex } from "../core/color";
import { activeLayer, type Doc } from "../core/document";
import type { Vec2 } from "../core/geometry";
import { relaxKnots } from "../core/curvature";
import { subpathData } from "../core/pathSvg";
import { activeEndpoint, hasHandles, reverseKnots, sameRef, type Knot } from "../core/path";
import { effectiveTarget, pathOf, validRefs } from "../editor/tools/pathEdit";
import { docToScreen } from "../editor/view";
import type { PathDisplay, PathState, PathToolId, ToolEvent, ToolId } from "../editor/types";
import type { View } from "../gpu/renderer";

const PATH_TOOLS: readonly ToolId[] = ["pen", "freeform-pen", "curvature-pen", "add-anchor", "delete-anchor", "convert-point", "path-select", "direct-select"] satisfies readonly PathToolId[];
export const isPathTool = (t: ToolId) => PATH_TOOLS.includes(t);

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
    const curvature = props.tool === "curvature-pen";
    if (!p || !h || !(curvature || (props.rubberBand && props.tool === "pen"))) return null;
    const end = activeEndpoint(p, selected());
    if (!end) return null;
    const s = p.subpaths[end.sub];
    const to = { x: h.x, y: h.y };
    // The path runs on from its last point, or from its first when that's the end continued from.
    const first = end.knot === 0 && s.knots.length > 1;
    const a = s.knots[end.knot];
    const svg = (from: Knot, out: Vec2, into: Vec2, dest: Vec2) => `M${at(from.anchor).x},${at(from.anchor).y} C${at(out).x},${at(out).y} ${at(into).x},${at(into).y} ${at(dest).x},${at(dest).y}`;
    if (curvature) {
      // The curve forms through the pointer as if it were the next point.
      const ordered = first ? reverseKnots(s.knots) : s.knots;
      const relaxed = relaxKnots([...ordered, { anchor: to, in: to, out: to, smooth: true, auto: true }], false);
      const [from, next] = relaxed.slice(-2);
      return svg(from, from.out, next.in, next.anchor);
    }
    // From the point's direction line on its open side, if it has one; straight otherwise.
    return svg(a, a[first ? "in" : "out"], to, to);
  };
  const handlePoints = (k: Knot) => [k.in, k.out].filter((p) => p.x !== k.anchor.x || p.y !== k.anchor.y);
  return (
    <Show when={path()}>
      {(p) => (
        <g data-testid="path-overlay" data-tool={props.tool} fill="none" stroke={color()} stroke-width={props.display.thickness} stroke-linejoin="round">
          <For each={p().subpaths}>{(s) => <path d={subpathData(s, at)} data-testid="path-component" />}</For>
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
