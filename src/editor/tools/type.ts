import { rasterizeContours } from "../../core/coverage";
import { addLayer, createLayer, docRect, layerById, removeLayer, updateLayer, type Doc, type Layer } from "../../core/document";
import { apply, invert, multiply, translation, vec, type Vec2 } from "../../core/geometry";
import { walk } from "../../core/layers";
import { NO_PIXELS } from "../../core/pixels";
import { combine, toMask } from "../../core/selection";
import { renderDrawing } from "../../core/shape";
import { dragTransform, hitTest, type Drag as TransformDrag } from "../../core/transform";
import { caretGeometry, indexAt, lineRange, moveCaret, paragraphOf, textLayerName, toTextSpace, wordAt, type Motion } from "../../text/edit";
import { drawText, textLayout } from "../../text/engine";
import {
  LOREM_IPSUM,
  insertContent,
  range,
  replaceText,
  setCharStyle,
  setParagraphStyle,
  sliceContent,
  styleAt,
  textContent,
  type CharRun,
  type CharStyle,
  type ParagraphStyle,
  type TextContent,
  type TextRange,
} from "../../text/model";
import type { Tool, ToolContext, ToolEvent, TypeToolId } from "../types";
import { boxToQuad, textState } from "./transform";

/**
 * The Type tools (Horizontal and Vertical Type, and their Type Mask
 * versions), as Photoshop's: clicking sets point type there and dragging
 * draws a paragraph box (Alt asks for its size); clicking existing type
 * edits it. While editing:
 *
 * - a click places the caret, dragging selects, and double, triple,
 *   quadruple and quintuple clicks select a word, a line, a paragraph and
 *   everything; Shift-click extends;
 * - the box's handles resize it (the text reflows); with Ctrl they scale
 *   and skew the type, and dragging outside the box rotates it;
 * - Ctrl-dragging inside moves the type;
 * - clicking away commits (as does choosing another tool, or anything
 *   else). Esc commits too, unless Preferences say it cancels.
 *
 * Typing arrives through the canvas's text input (see ui/TextInput.tsx)
 * as calls on the controller. A Type Mask tool's text becomes a selection
 * when committed.
 */

interface Snapshot {
  readonly content: TextContent;
  readonly anchor: number;
  readonly focus: number;
}

interface Session {
  readonly tool: TypeToolId;
  /** The document being edited (with the new layer, for new type). */
  base: Doc;
  readonly layerId: string;
  readonly isNew: boolean;
  readonly mask: boolean;
  content: TextContent;
  anchor: number;
  focus: number;
  /** Up and down keep to this inline position. */
  goal: number | null;
  /** The name follows the text (it hasn't been renamed). */
  readonly autoName: boolean;
  /** Formatting chosen with nothing selected: what's typed next takes it. */
  typing: CharRun | null;
  hide: boolean;
  transforming: boolean;
  undo: Snapshot[];
  redo: Snapshot[];
  /** IME composition: the provisional text's range. */
  composition: TextRange | null;
}

type Drag =
  | { readonly kind: "create"; readonly start: Vec2; readonly screen: Vec2; readonly alt: boolean }
  | { readonly kind: "select"; readonly unit: "char" | "word" | "line" | "paragraph"; readonly around: TextRange }
  | { readonly kind: "box"; readonly edge: number; readonly from: TextContent; readonly start: Vec2 }
  | { readonly kind: "transform"; readonly drag: TransformDrag; readonly from: TextContent }
  | { readonly kind: "move"; readonly start: Vec2; readonly from: TextContent };

/** What the UI reads of an editing session. */
export interface TypeSessionView {
  readonly layerId: string;
  readonly content: TextContent;
  readonly anchor: number;
  readonly focus: number;
  readonly mask: boolean;
  readonly isNew: boolean;
  readonly composing: boolean;
}

export interface TypeController {
  readonly tools: readonly Tool[];
  session(): TypeSessionView | null;
  /** Starts editing a type layer (the active one unless named), selecting everything or placing the caret at the end. */
  edit(ctx: ToolContext, layerId: string, select: "all" | "end"): boolean;
  /** Typed or pasted text, replacing the selection. */
  input(ctx: ToolContext, text: string): void;
  /** Styled text (copied from type), replacing the selection. */
  paste(ctx: ToolContext, piece: Pick<TextContent, "text" | "runs">): void;
  /** The selection as styled text, for copying. */
  copy(): Pick<TextContent, "text" | "runs" | "paragraphs"> | null;
  deleteBackward(ctx: ToolContext, unit: "char" | "word"): void;
  deleteForward(ctx: ToolContext, unit: "char" | "word"): void;
  navigate(ctx: ToolContext, motion: Motion, extend: boolean): void;
  select(ctx: ToolContext, anchor: number, focus: number): void;
  selectAll(ctx: ToolContext): void;
  /** IME: the composition so far (replacing the previous one), and whether it's final. */
  compose(ctx: ToolContext, text: string, done: boolean): void;
  /** Character attributes on the selection (or what's typed next, with a caret). */
  format(ctx: ToolContext, patch: Partial<CharStyle> | ((s: CharStyle) => Partial<CharStyle>)): void;
  /** Paragraph attributes on the paragraphs the selection touches. */
  formatParagraph(ctx: ToolContext, patch: Partial<ParagraphStyle>): void;
  /** Any change to the whole content (orientation, anti-aliasing, warp). */
  update(ctx: ToolContext, f: (c: TextContent) => TextContent): void;
  undo(ctx: ToolContext): boolean;
  redo(ctx: ToolContext): boolean;
  toggleHighlight(ctx: ToolContext): void;
  /** Ctrl held or released: transform handles show on the frame. */
  setTransforming(ctx: ToolContext, on: boolean): void;
  /** Ends the session keeping the edits (one history step). */
  commit(ctx: ToolContext): void;
  /** Ends the session discarding them. */
  discard(ctx: ToolContext): void;
}

const isVertical = (t: TypeToolId) => t === "type-vertical" || t === "type-mask-vertical";
const isMask = (t: TypeToolId) => t === "type-mask-horizontal" || t === "type-mask-vertical";

/** Screen pixels a pointer moves before a press becomes a box drag. */
const DRAG_PX = 4;
/** Screen pixels around the frame that still count as on it. */
const FRAME_PX = 8;

/** Straight quotes typed become curly (Use Smart Quotes): opening after a space, a bracket or nothing. */
function smartQuote(ch: string, before: string): string {
  const opening = !before || /[\s([{“‘\-–—]/.test(before);
  if (ch === '"') return opening ? "“" : "”";
  if (ch === "'") return opening ? "‘" : "’";
  return ch;
}

const inside = (q: readonly Vec2[], p: Vec2) => {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
};

/** A quad grown by `d` about its centre. */
const grown = (q: readonly Vec2[], d: number) => {
  const cx = (q[0].x + q[2].x) / 2, cy = (q[0].y + q[2].y) / 2;
  return q.map((p) => {
    const len = Math.hypot(p.x - cx, p.y - cy) || 1;
    return vec(p.x + ((p.x - cx) / len) * d, p.y + ((p.y - cy) / len) * d);
  });
};

/** The topmost visible type layer under a document point. */
function typeLayerAt(doc: Doc, p: Vec2, tolerance: number): Layer | null {
  const layers = [...walk(doc.layers)].reverse();
  // The active layer first: clicking it where layers overlap edits it.
  const active = layers.find((l) => l.id === doc.activeLayerId);
  for (const l of active ? [active, ...layers] : layers) {
    if (l.content.kind !== "text" || !l.visible) continue;
    if (inside(grown(textState(l.content).quad, tolerance), p)) return l;
  }
  return null;
}

export function createTypeController(): TypeController {
  let s: Session | null = null;
  let drag: Drag | null = null;
  let clicks = { count: 0, at: 0 };

  const sel = (x: Session) => range(x.anchor, x.focus);
  const layout = (x: Session) => textLayout(x.content);

  /** The document as edited, and the overlay. */
  function show(ctx: ToolContext) {
    if (!s) return;
    const l = layerById(s.base, s.layerId);
    if (!l) return;
    const name = s.autoName && !s.mask ? textLayerName(s.content.text) : l.name;
    // A Type Mask tool's text isn't a layer: it shows in the quick mask instead.
    ctx.preview(updateLayer(s.base, s.layerId, { content: s.content, name, pixels: NO_PIXELS, ...(s.mask && { visible: false }) }));
    ctx.overlay({ kind: "text", layerId: s.layerId, content: s.content, anchor: s.anchor, focus: s.focus, mask: s.mask, hideSelection: s.hide, transforming: s.transforming, composing: !!s.composition });
  }

  /** Records the state before an edit, for undo within the session. */
  const remember = (x: Session) => {
    x.undo.push({ content: x.content, anchor: x.anchor, focus: x.focus });
    if (x.undo.length > 200) x.undo.shift();
    x.redo = [];
  };

  const setCaret = (x: Session, anchor: number, focus = anchor) => {
    x.anchor = anchor;
    x.focus = focus;
    x.typing = null;
  };

  function start(ctx: ToolContext, tool: TypeToolId, doc: Doc, layer: Layer, isNew: boolean, select: "all" | "end" | number) {
    const content = layer.content as TextContent;
    const n = content.text.length;
    s = {
      tool,
      base: { ...doc, activeLayerId: layer.id, maskTargeted: false },
      layerId: layer.id,
      isNew,
      mask: isMask(tool),
      content: { ...content, stale: false },
      anchor: select === "all" ? 0 : select === "end" ? n : select,
      focus: select === "all" ? n : select === "end" ? n : select,
      goal: null,
      autoName: isNew || layer.name === textLayerName(content.text),
      typing: null,
      hide: false,
      transforming: false,
      undo: [],
      redo: [],
      composition: null,
    };
    show(ctx);
  }

  /** New type at a point or in a box (text space at the document). */
  function create(ctx: ToolContext, tool: TypeToolId, at: Vec2, box: { width: number; height: number } | null) {
    const { type } = ctx.settings;
    const placeholder = ctx.preferences.placeholderText ? (box ? LOREM_IPSUM : "Lorem Ipsum") : "";
    const char: CharStyle = { ...type.char, color: ctx.foreground };
    const frame = box ? ({ kind: "box", ...box } as const) : ({ kind: "point" } as const);
    let content: TextContent = { ...textContent(placeholder, char, type.paragraph, frame, translation(at.x, at.y)), antiAlias: type.antiAlias };
    if (isVertical(tool)) content = { ...content, orientation: "vertical" };
    const layer = createLayer({ name: textLayerName(placeholder) || "Layer", content });
    start(ctx, tool, addLayer(ctx.doc, layer), layer, true, "all");
  }

  /** The type as committed: its layer with pixels, or for a mask tool, the selection. */
  function finish(ctx: ToolContext, x: Session) {
    const doc = x.base;
    if (x.mask) {
      // The text's outline as a selection, combined as the selection options say.
      const d = drawText(x.content);
      const polys = d.paints.flatMap((p) => [...p.fill, ...p.stroke]);
      const cov = rasterizeContours(polys, docRect(doc));
      const shape = cov && toMask(cov.data, cov.region, doc.width, doc.height);
      const original = x.isNew ? removeLayer(doc, x.layerId) : doc;
      const before = ctx.doc;
      ctx.commit("Type Mask", { ...original, activeLayerId: before.activeLayerId, selection: combine(before.selection, shape, ctx.settings.selectionMode) });
      return;
    }
    if (!x.content.text.length) {
      // Empty type isn't kept (Photoshop deletes the layer).
      if (x.isNew) return ctx.preview(null);
      return ctx.commit("Delete Layer", removeLayer(doc, x.layerId));
    }
    const l = layerById(doc, x.layerId)!;
    const name = x.autoName ? textLayerName(x.content.text) : l.name;
    // Rendered right away (exact, on the CPU), so whatever comes next sees the committed type.
    const pixels = renderDrawing(drawText(x.content), docRect(doc));
    const committed = updateLayer(doc, x.layerId, { content: x.content, name, pixels });
    ctx.commit(x.isNew ? "Type Layer" : "Edit Type Layer", committed);
  }

  function end(ctx: ToolContext, keep: boolean) {
    const x = s;
    s = null;
    drag = null;
    ctx.overlay(null);
    if (!x) return;
    const changed = x.isNew || x.content !== (layerById(x.base, x.layerId)?.content as TextContent | undefined) || x.mask;
    if (keep && changed) finish(ctx, x);
    else ctx.preview(null);
  }

  const edit = (ctx: ToolContext, f: (x: Session) => void) => {
    if (!s) return;
    f(s);
    show(ctx);
  };

  /** Replaces the selection with text in the typing style. */
  function replace(x: Session, text: string, piece?: Pick<TextContent, "text" | "runs">) {
    remember(x);
    const r = sel(x);
    x.content = piece ? insertContent(x.content, r, piece) : replaceText(x.content, r, text, x.typing ?? undefined);
    const at = r.start + (piece ? piece.text.length : text.length);
    setCaret(x, at);
    x.goal = null;
  }

  /** Selection by unit (word, line, paragraph) around a caret stop. */
  const unitAt = (x: Session, unit: "char" | "word" | "line" | "paragraph", i: number): TextRange =>
    unit === "word" ? wordAt(x.content.text, i) : unit === "line" ? lineRange(layout(x), i) : unit === "paragraph" ? paragraphOf(x.content.text, i) : { start: i, end: i };

  /** Where a document point lands in the text. */
  const indexOf = (x: Session, p: Vec2) => indexAt(layout(x), toTextSpace(x.content, layout(x), p));

  /** The frame's transform state, and whether `p` is on it (within tolerance). */
  const frameOf = (x: Session) => textState(x.content);

  function down(ctx: ToolContext, tool: TypeToolId, e: ToolEvent) {
    const p = vec(e.x, e.y);
    const tol = FRAME_PX / ctx.view.zoom;
    if (s) {
      const x = s;
      const state = frameOf(x);
      const hit = hitTest(state, p, { tolerance: 7 / ctx.view.zoom, mode: "free", showReference: false, rotateBand: 24 / ctx.view.zoom });
      // Handles: resize the box (reflowing), or with Ctrl scale and skew the type; outside, rotate.
      if (hit.kind === "corner" || hit.kind === "edge" || hit.kind === "rotate") {
        if (hit.kind !== "rotate" && !e.mod && x.content.frame.kind === "box") {
          drag = { kind: "box", edge: hit.kind === "corner" ? hit.index : 4 + hit.index, from: x.content, start: p };
          remember(x);
          return;
        }
        if (hit.kind === "rotate" || e.mod) {
          drag = { kind: "transform", drag: { hit, start: p, from: state, mode: "free", link: ctx.settings.transform.link }, from: x.content };
          remember(x);
          return;
        }
      }
      if (e.mod && inside(grown(state.quad, tol), p)) {
        drag = { kind: "move", start: p, from: x.content };
        remember(x);
        return;
      }
      if (!inside(grown(state.quad, tol), p)) {
        // Clicking away commits.
        end(ctx, true);
        return;
      }
      // Multiple clicks select by word, line, paragraph and all.
      const now = performance.now();
      clicks = { count: e.clicks >= 2 ? e.clicks : now - clicks.at < 500 ? clicks.count + 1 : 1, at: now };
      const i = indexOf(x, p);
      const n = Math.min(clicks.count, 5);
      if (n >= 5) {
        setCaret(x, 0, x.content.text.length);
        drag = null;
      } else {
        const unit = (["char", "char", "word", "line", "paragraph"] as const)[n];
        const around = unitAt(x, unit, i);
        if (e.shift && n === 1) setCaret(x, x.anchor, i);
        else setCaret(x, around.start, around.end);
        drag = { kind: "select", unit, around: e.shift && n === 1 ? range(x.anchor, x.anchor) : around };
      }
      x.goal = null;
      show(ctx);
      return;
    }
    // Not editing: type under the pointer is edited (Shift starts new type instead).
    const hitLayer = !e.shift ? typeLayerAt(ctx.doc, p, tol) : null;
    if (hitLayer) {
      const c = hitLayer.content as TextContent;
      start(ctx, isMask(tool) ? tool : c.orientation === "vertical" ? "type-vertical" : "type-horizontal", ctx.doc, hitLayer, false, 0);
      const i = indexOf(s!, p);
      setCaret(s!, i);
      drag = { kind: "select", unit: "char", around: { start: i, end: i } };
      show(ctx);
      return;
    }
    drag = { kind: "create", start: p, screen: vec(e.screenX, e.screenY), alt: e.alt };
  }

  function move(ctx: ToolContext, e: ToolEvent) {
    const p = vec(e.x, e.y);
    if (s && s.transforming !== e.mod && !drag) {
      s.transforming = e.mod;
      show(ctx);
    }
    if (!drag || !s) return;
    const x = s;
    switch (drag.kind) {
      case "select": {
        const i = indexOf(x, p);
        const at = unitAt(x, drag.unit, i);
        // Extending by units: from the far end of the unit first clicked.
        if (i >= drag.around.start) setCaret(x, drag.around.start, Math.max(at.end, drag.around.end));
        else setCaret(x, drag.around.end, at.start);
        show(ctx);
        return;
      }
      case "box": {
        x.content = resizeBox(drag.from, drag.edge, drag.start, p);
        show(ctx);
        return;
      }
      case "transform": {
        const state = dragTransform(drag.drag, p, e);
        const b = drag.drag.from.source;
        x.content = { ...drag.from, transform: boxToQuad(b, state.quad) };
        show(ctx);
        return;
      }
      case "move": {
        const t = drag.from.transform;
        x.content = { ...drag.from, transform: [t[0], t[1], t[2], t[3], t[4] + p.x - drag.start.x, t[5] + p.y - drag.start.y] };
        show(ctx);
        return;
      }
    }
  }

  async function up(ctx: ToolContext, tool: TypeToolId, e: ToolEvent) {
    const d = drag;
    drag = null;
    if (!d || d.kind !== "create") return;
    const p = vec(e.x, e.y);
    const moved = Math.hypot(e.screenX - d.screen.x, e.screenY - d.screen.y) >= DRAG_PX;
    if (d.alt && !moved) {
      // Alt-click: the Paragraph Text Size dialog.
      const size = await ctx.askBoxSize();
      if (size) create(ctx, tool, d.start, size);
      return;
    }
    if (!moved) return create(ctx, tool, d.start, null);
    const x0 = Math.min(d.start.x, p.x), y0 = Math.min(d.start.y, p.y);
    create(ctx, tool, vec(x0, y0), { width: Math.abs(p.x - d.start.x), height: Math.abs(p.y - d.start.y) });
  }

  const tools: Tool[] = (["type-horizontal", "type-vertical", "type-mask-horizontal", "type-mask-vertical"] as const).map((id) => ({
    id,
    latestMoveOnly: true,
    commitOnSwitch: true,
    cursor(ctx, e) {
      if (!e) return "text";
      const p = vec(e.x, e.y);
      if (s) {
        const state = frameOf(s);
        const hit = hitTest(state, p, { tolerance: 7 / ctx.view.zoom, mode: "free", showReference: false, rotateBand: 24 / ctx.view.zoom });
        if (hit.kind === "rotate") return "grab";
        if (hit.kind === "corner" || hit.kind === "edge") return hit.kind === "corner" && (hit.index === 0 || hit.index === 2) ? "nwse-resize" : hit.kind === "corner" ? "nesw-resize" : hit.index % 2 ? "ew-resize" : "ns-resize";
        if (e.mod && inside(state.quad, p)) return "move";
        return inside(grown(state.quad, FRAME_PX / ctx.view.zoom), p) ? (isVertical(s.tool) ? "vertical-text" : "text") : "default";
      }
      return isVertical(id) ? "vertical-text" : "text";
    },
    down: (ctx, e) => down(ctx, id, e),
    move,
    up: (ctx, e) => void up(ctx, id, e),
    commit: (ctx) => end(ctx, true),
    // The editor cancels a tool before other commands: type commits then, as Photoshop does.
    cancel: (ctx) => end(ctx, true),
  }));

  return {
    tools,
    session: () =>
      s && { layerId: s.layerId, content: s.content, anchor: s.anchor, focus: s.focus, mask: s.mask, isNew: s.isNew, composing: !!s.composition },
    edit(ctx, layerId, select) {
      const layer = layerById(ctx.doc, layerId);
      if (!layer || layer.content.kind !== "text") return false;
      if (s) end(ctx, true);
      start(ctx, layer.content.orientation === "vertical" ? "type-vertical" : "type-horizontal", ctx.doc, layer, false, select);
      return true;
    },
    input(ctx, text) {
      edit(ctx, (x) => {
        // Smart quotes, as typed.
        if (ctx.preferences.smartQuotes && text.length === 1 && (text === '"' || text === "'")) text = smartQuote(text, x.content.text[sel(x).start - 1] ?? "");
        replace(x, text.replace(/\r\n?/g, "\n"));
      });
    },
    paste: (ctx, piece) => edit(ctx, (x) => replace(x, piece.text, piece)),
    copy: () => (s && s.anchor !== s.focus ? sliceContent(s.content, sel(s)) : null),
    deleteBackward(ctx, unit) {
      edit(ctx, (x) => {
        const r = sel(x);
        if (r.start === r.end) {
          if (r.start === 0) return;
          const to = unit === "word" ? moveCaret(layout(x), x.content.text, r.start, "word-left", null).index : moveCaret(layout(x), x.content.text, r.start, "left", null).index;
          setCaret(x, to, r.start);
        }
        replace(x, "");
      });
    },
    deleteForward(ctx, unit) {
      edit(ctx, (x) => {
        const r = sel(x);
        if (r.start === r.end) {
          if (r.end >= x.content.text.length) return;
          const to = moveCaret(layout(x), x.content.text, r.end, unit === "word" ? "word-right" : "right", null).index;
          setCaret(x, r.start, to);
        }
        replace(x, "");
      });
    },
    navigate(ctx, motion, extend) {
      edit(ctx, (x) => {
        const r = sel(x);
        // Left/right with a selection collapse it to that side.
        if (!extend && r.start !== r.end && (motion === "left" || motion === "right")) {
          setCaret(x, motion === "left" ? r.start : r.end);
          x.goal = null;
          return;
        }
        const m = moveCaret(layout(x), x.content.text, x.focus, motion, x.goal);
        if (extend) {
          x.focus = m.index;
          x.typing = null;
        } else setCaret(x, m.index);
        x.goal = m.goal;
      });
    },
    select: (ctx, anchor, focus) => edit(ctx, (x) => setCaret(x, anchor, focus)),
    selectAll: (ctx) => edit(ctx, (x) => setCaret(x, 0, x.content.text.length)),
    compose(ctx, text, done) {
      edit(ctx, (x) => {
        const r = x.composition ?? sel(x);
        if (!x.composition) remember(x);
        x.content = replaceText(x.content, r, text, x.typing ?? undefined);
        x.composition = done ? null : { start: r.start, end: r.start + text.length };
        x.anchor = x.focus = r.start + text.length;
      });
    },
    format(ctx, patch) {
      edit(ctx, (x) => {
        const r = sel(x);
        const resolve = (st: CharStyle) => (typeof patch === "function" ? patch(st) : patch);
        if (r.start === r.end) {
          // With a caret, formatting applies to what's typed next.
          const base = x.typing ?? styleAt(x.content, r.start);
          x.typing = { ...base, style: { ...base.style, ...resolve(base.style) } };
          if (!x.content.text.length) x.content = setCharStyle(x.content, r, x.typing.style);
          return;
        }
        remember(x);
        if (typeof patch === "function") {
          let c = x.content, pos = 0;
          for (const run of x.content.runs) {
            const a = Math.max(pos, r.start), b = Math.min(pos + run.length, r.end);
            if (b > a) c = setCharStyle(c, { start: a, end: b }, patch(run.style));
            pos += run.length;
          }
          x.content = c;
        } else x.content = setCharStyle(x.content, r, patch);
      });
    },
    formatParagraph(ctx, patch) {
      edit(ctx, (x) => {
        remember(x);
        x.content = setParagraphStyle(x.content, sel(x), patch);
      });
    },
    update(ctx, f) {
      edit(ctx, (x) => {
        remember(x);
        x.content = f(x.content);
        const n = x.content.text.length;
        setCaret(x, Math.min(x.anchor, n), Math.min(x.focus, n));
      });
    },
    undo(ctx) {
      if (!s?.undo.length) return false;
      edit(ctx, (x) => {
        x.redo.push({ content: x.content, anchor: x.anchor, focus: x.focus });
        const prev = x.undo.pop()!;
        x.content = prev.content;
        setCaret(x, prev.anchor, prev.focus);
      });
      return true;
    },
    redo(ctx) {
      if (!s?.redo.length) return false;
      edit(ctx, (x) => {
        x.undo.push({ content: x.content, anchor: x.anchor, focus: x.focus });
        const next = x.redo.pop()!;
        x.content = next.content;
        setCaret(x, next.anchor, next.focus);
      });
      return true;
    },
    toggleHighlight: (ctx) => edit(ctx, (x) => void (x.hide = !x.hide)),
    setTransforming(ctx, on) {
      if (s && s.transforming !== on) edit(ctx, (x) => void (x.transforming = on));
    },
    commit: (ctx) => end(ctx, true),
    discard: (ctx) => end(ctx, false),
  };
}

/**
 * The paragraph box with a handle dragged: corners 0–3 (TL, TR, BR, BL),
 * edges 4–7 (top, right, bottom, left). The text keeps its scale; the box
 * changes and the text reflows. Moving the top or left edge moves the
 * box's origin.
 */
export function resizeBox(c: TextContent, handle: number, from: Vec2, to: Vec2): TextContent {
  if (c.frame.kind !== "box") return c;
  const inv = invert(c.transform);
  const a = apply(inv, from), b = apply(inv, to);
  const dx = b.x - a.x, dy = b.y - a.y;
  const { width, height } = c.frame;
  const left = handle === 0 || handle === 3 || handle === 7, right = handle === 1 || handle === 2 || handle === 5;
  const top = handle === 0 || handle === 1 || handle === 4, bottom = handle === 2 || handle === 3 || handle === 6;
  let x0 = 0, y0 = 0, x1 = width, y1 = height;
  if (left) x0 += dx;
  if (right) x1 += dx;
  if (top) y0 += dy;
  if (bottom) y1 += dy;
  const nx0 = Math.min(x0, x1), ny0 = Math.min(y0, y1);
  const frame = { kind: "box" as const, width: Math.max(1, Math.abs(x1 - x0)), height: Math.max(1, Math.abs(y1 - y0)) };
  return { ...c, frame, transform: multiply(c.transform, translation(nx0, ny0)) };
}

/** Where the caret is on screen, for the input element (so IME windows open by it): its top in document space. */
export function caretPoint(c: TextContent, index: number): Vec2 | null {
  const g = caretGeometry(textLayout(c), index);
  return g ? apply(c.transform, g.top) : null;
}
