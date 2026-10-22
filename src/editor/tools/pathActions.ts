import {
  alignSubpaths,
  allAnchors,
  arrangeSubpaths,
  distributeSubpaths,
  mergeComponents,
  selectedSubpaths,
  setOps,
  type Alignment,
  type Distribution,
  type PathOp,
} from "../../core/path";
import type { ToolContext } from "../types";
import { editing, recordPath, selectPoints, validRefs } from "./pathEdit";

/** What the Path Selection tools' options bar does to the selected components. */
export type PathAction =
  | { readonly kind: "operation"; readonly op: PathOp }
  | { readonly kind: "align"; readonly how: Alignment }
  | { readonly kind: "distribute"; readonly how: Distribution }
  | { readonly kind: "arrange"; readonly how: "front" | "forward" | "backward" | "back" }
  | { readonly kind: "merge" };

/** How many components are selected, and how many there are. */
export function componentCounts(ctx: Pick<ToolContext, "doc" | "paths">): { selected: number; total: number } {
  const ed = editing(ctx as ToolContext);
  if (!ed) return { selected: 0, total: 0 };
  return { selected: selectedSubpaths(ed.path, validRefs(ed.path, ctx.paths.selected)).length, total: ed.path.subpaths.length };
}

/** Runs an action on the selected components of the path being edited, as one history step. */
export function runPathAction(ctx: ToolContext, a: PathAction): void {
  const ed = editing(ctx);
  if (!ed) return;
  const subs = selectedSubpaths(ed.path, validRefs(ed.path, ctx.paths.selected));
  switch (a.kind) {
    case "operation":
      if (subs.length) recordPath(ctx, "Change Path Operation", ed, setOps(ed.path, subs, a.op));
      return;
    case "align":
      if (subs.length >= 2) recordPath(ctx, "Align Path Components", ed, alignSubpaths(ed.path, subs, a.how));
      return;
    case "distribute":
      if (subs.length >= 3) recordPath(ctx, "Distribute Path Components", ed, distributeSubpaths(ed.path, subs, a.how));
      return;
    case "arrange": {
      if (!subs.length) return;
      const r = arrangeSubpaths(ed.path, subs, a.how);
      recordPath(ctx, "Arrange Path Components", ed, r.path);
      return selectPoints(ctx, ed.target, allAnchors(r.path, r.moved));
    }
    case "merge":
      // Merge Shape Components acts on the whole path.
      recordPath(ctx, "Merge Shape Components", ed, mergeComponents(ed.path));
      return selectPoints(ctx, ed.target, []);
  }
}
