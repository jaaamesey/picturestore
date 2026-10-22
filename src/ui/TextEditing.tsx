import { For, Show, createMemo, onSettled, useContext } from "solid-js";
import type { Vec2 } from "../core/geometry";
import { handles } from "../core/transform";
import type { Overlay } from "../editor/types";
import { docToScreen } from "../editor/view";
import type { View } from "../gpu/renderer";
import { caretGeometry, selectionPolygons, type Motion } from "../text/edit";
import { drawText, textLayout } from "../text/engine";
import type { CharStyle, TextContent } from "../text/model";
import { textMap } from "../text/render";
import { textState } from "../editor/tools/transform";
import { AppContext } from "./context";

type TextOverlay = Extract<Overlay, { kind: "text" }>;

const ACCENT = "#2f7cf6";
const points = (pts: readonly Vec2[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

/** Text space → screen, through the warp, the layer's transform and the view. */
const toScreen = (c: TextContent, view: View) => {
  const m = textMap(c, textLayout(c));
  return (p: Vec2) => docToScreen(view, m(p));
};

/**
 * Type being edited, over the canvas: the frame (dashed for a paragraph
 * box, with handles; transform handles while Ctrl is held), the selection
 * (inverting what's under it, as in Photoshop), the blinking caret, and
 * the overflow sign when text doesn't fit. Type Mask tools show the red
 * quick mask with the type cut out of it.
 */
export function TextOverlayView(props: { overlay: TextOverlay; view: View }) {
  const c = () => props.overlay.content;
  const layout = createMemo(() => textLayout(c()));
  const map = createMemo(() => toScreen(c(), props.view));
  const frame = createMemo(() => handles(textState(c())));
  const box = () => c().frame.kind === "box";
  const selection = createMemo(() => {
    const a = Math.min(props.overlay.anchor, props.overlay.focus), b = Math.max(props.overlay.anchor, props.overlay.focus);
    // Polygons are traced finely enough to bend with a warp.
    return selectionPolygons(layout(), a, b).map((poly) => points(densify(poly, c().warp ? 3 : Infinity).map(map())));
  });
  const caret = createMemo(() => {
    if (props.overlay.anchor !== props.overlay.focus) return null;
    const g = caretGeometry(layout(), props.overlay.focus);
    return g && { a: map()(g.top), b: map()(g.bottom) };
  });
  const maskHole = createMemo(() => {
    if (!props.overlay.mask) return "";
    const d = drawText(c());
    return d.paints
      .flatMap((p) => p.fill)
      .map((poly) => `M${poly.map((q) => docToScreen(props.view, q)).map((q) => `${q.x} ${q.y}`).join("L")}Z`)
      .join("");
  });
  const corner = () => docToScreen(props.view, frame().corners[2]);
  return (
    <g data-testid="text-editing" data-overflow={layout().overflow ? "" : undefined}>
      <Show when={props.overlay.mask}>
        <defs>
          <mask id="type-mask-hole">
            <rect x="-100000" y="-100000" width="200000" height="200000" fill="white" />
            <path d={maskHole()} fill="black" />
          </mask>
        </defs>
        <rect x="-100000" y="-100000" width="200000" height="200000" fill="rgb(255 0 0 / 0.5)" mask="url(#type-mask-hole)" data-testid="type-mask-overlay" />
      </Show>
      <polygon
        points={points(frame().corners.map((p) => docToScreen(props.view, p)))}
        fill="none"
        stroke={box() ? "black" : ACCENT}
        stroke-width="1"
        stroke-dasharray={box() ? "3 3" : undefined}
        opacity={box() || props.overlay.transforming ? 1 : 0.6}
        data-testid="text-frame"
      />
      <Show when={box() || props.overlay.transforming}>
        <For each={[...frame().corners, ...frame().edges]}>
          {(p) => {
            const q = () => docToScreen(props.view, p);
            return <rect x={q().x - 3.5} y={q().y - 3.5} width="7" height="7" fill="white" stroke={props.overlay.transforming ? ACCENT : "black"} stroke-width="1" />;
          }}
        </For>
      </Show>
      <Show when={layout().overflow}>
        {/* Photoshop's overflow sign: a plus in the box's last handle. */}
        <g data-testid="text-overflow">
          <rect x={corner().x - 5} y={corner().y - 5} width="10" height="10" fill="white" stroke="black" stroke-width="1" />
          <path d={`M${corner().x - 3} ${corner().y}h6M${corner().x} ${corner().y - 3}v6`} stroke="black" stroke-width="1" />
        </g>
      </Show>
      <Show when={!props.overlay.hideSelection}>
        <For each={selection()}>{(p) => <polygon points={p} fill="white" style={{ "mix-blend-mode": "difference" }} data-testid="text-selection" />}</For>
      </Show>
      <Show when={caret()}>
        {(k) => <line x1={k().a.x} y1={k().a.y} x2={k().b.x} y2={k().b.y} stroke="white" stroke-width="1.5" class="caret-blink" style={{ "mix-blend-mode": "difference" }} data-testid="text-caret" />}
      </Show>
    </g>
  );
}

function densify(poly: readonly Vec2[], step: number): Vec2[] {
  if (!Number.isFinite(step)) return [...poly];
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** The clipboard type for styled text copied from type layers. */
const STYLED = "application/x-picturestore-text";

/** Photoshop's type shortcuts (Ctrl/Cmd+Shift+…): character and paragraph formatting while editing. */
function formatShortcut(e: KeyboardEvent): ((s: CharStyle) => Partial<CharStyle>) | Partial<CharStyle> | { paragraph: string } | null {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || !e.shiftKey) return null;
  const toggle = (k: keyof CharStyle) => (s: CharStyle) => ({ [k]: !s[k] }) as Partial<CharStyle>;
  switch (e.code) {
    case "KeyB":
      return toggle("fauxBold");
    case "KeyI":
      return toggle("fauxItalic");
    case "KeyK":
      return (s) => ({ caps: s.caps === "all" ? "normal" : "all" });
    case "KeyH":
      return e.altKey ? { paragraph: "hyphenate" } : (s) => ({ caps: s.caps === "small" ? "normal" : "small" });
    case "KeyU":
      return toggle("underline");
    case "Slash":
      return toggle("strikethrough");
    case "Equal":
      return e.altKey ? (s) => ({ position: s.position === "subscript" ? "normal" : "subscript" }) : (s) => ({ position: s.position === "superscript" ? "normal" : "superscript" });
    case "KeyX":
      return e.altKey ? { verticalScale: 1 } : { horizontalScale: 1 };
    case "KeyA":
      return e.altKey ? { leading: null } : null;
    case "KeyQ":
      return { tracking: 0 };
    case "Comma":
    case "Period": {
      const step = (e.altKey ? 10 : 2) * (e.code === "Comma" ? -1 : 1);
      return (s) => ({ size: Math.max(0.01, s.size + step) });
    }
    case "KeyL":
      return { paragraph: "left" };
    case "KeyC":
      return { paragraph: "center" };
    case "KeyR":
      return { paragraph: "right" };
    case "KeyJ":
      return { paragraph: "justify-left" };
    case "KeyF":
      return { paragraph: "justify-all" };
    case "KeyT":
      return e.altKey ? { paragraph: "composer" } : null;
  }
  return null;
}

/**
 * The text input behind type editing: a hidden textarea by the caret, so
 * the browser does what it's best at — keys, IME composition (its window
 * opens by the caret), the clipboard — and every edit goes to the editor.
 */
export function TextInput(props: { overlay: TextOverlay; view: View }) {
  const { editor } = useContext(AppContext);
  const t = editor.type;
  let area!: HTMLTextAreaElement;
  onSettled(() => {
    area.focus({ preventScroll: true });
    // Keep the focus while editing: clicks on the canvas return it here.
    const refocus = () => queueMicrotask(() => editor.type.session() && area.focus({ preventScroll: true }));
    const host = area.closest("[data-testid=viewport]");
    host?.addEventListener("pointerup", refocus);
    return () => host?.removeEventListener("pointerup", refocus);
  });
  const at = createMemo(() => {
    const c = props.overlay.content;
    const g = caretGeometry(textLayout(c), props.overlay.focus);
    return g ? docToScreen(props.view, textMap(c, textLayout(c))(g.top)) : { x: 0, y: 0 };
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Control" || e.key === "Meta") t.setTransforming(true);
    const fmt = formatShortcut(e);
    if (fmt) {
      e.preventDefault();
      if ("paragraph" in fmt) {
        const p = fmt.paragraph;
        const target = t.target();
        const para = target?.content.paragraphs[0]?.style;
        if (p === "hyphenate") t.formatParagraphs({ hyphenate: !para?.hyphenate });
        else if (p === "composer") t.formatParagraphs({ composer: para?.composer === "every" ? "single" : "every" });
        else t.formatParagraphs({ align: p as never });
      } else t.formatCharacters(fmt as Partial<CharStyle>);
      return;
    }
    // Alt with the arrows: kerning and tracking (left/right), leading (up/down), baseline shift (with Shift).
    if (e.altKey && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const sign = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const step = sign * (mod ? 100 : 20);
        const s = t.session();
        if (s && s.anchor === s.focus) t.formatCharacters((c) => ({ kerning: (typeof c.kerning === "number" ? c.kerning : 0) + step }));
        else t.formatCharacters((c) => ({ tracking: c.tracking + step }));
      } else if (e.shiftKey) t.formatCharacters((c) => ({ baselineShift: c.baselineShift + sign * (mod ? 10 : 2) }));
      else t.formatCharacters((c) => ({ leading: Math.max(0, (c.leading ?? c.size * 1.2) - sign * (mod ? 10 : 2)) }));
      return;
    }
    const motions: Record<string, Motion> = {
      ArrowLeft: mod ? "word-left" : "left",
      ArrowRight: mod ? "word-right" : "right",
      ArrowUp: mod ? "paragraph-up" : "up",
      ArrowDown: mod ? "paragraph-down" : "down",
      Home: mod ? "start" : "line-start",
      End: mod ? "end" : "line-end",
    };
    const motion = motions[e.key];
    if (motion) {
      e.preventDefault();
      return t.navigate(motion, e.shiftKey);
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        return editor.preferences().escCommits ? t.commit() : t.discard();
      case "Enter":
        e.preventDefault();
        // The numeric keypad's Enter, or Ctrl+Enter, commits; Enter starts a paragraph.
        return e.code === "NumpadEnter" || mod ? t.commit() : t.input("\n");
      case "Backspace":
        e.preventDefault();
        return t.deleteBackward(mod || e.altKey ? "word" : "char");
      case "Delete":
        e.preventDefault();
        return t.deleteForward(mod ? "word" : "char");
      case "Tab":
        e.preventDefault();
        return t.input("\t");
    }
    if (!mod) return;
    switch (e.key.toLowerCase()) {
      case "a":
        e.preventDefault();
        return t.selectAll();
      case "z":
        e.preventDefault();
        return e.shiftKey ? t.redo() : t.undo();
      case "y":
        e.preventDefault();
        return t.redo();
      case "h":
        e.preventDefault();
        return t.toggleHighlight();
    }
  };

  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType === "insertText" || e.inputType === "insertReplacementText") {
      e.preventDefault();
      if (e.data) t.input(e.data);
    } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
      e.preventDefault();
      t.input("\n");
    }
  };

  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    const piece = t.copy();
    e.preventDefault();
    if (!piece) return;
    e.clipboardData?.setData("text/plain", piece.text);
    e.clipboardData?.setData(STYLED, JSON.stringify(piece));
    if (cut) t.deleteBackward("char");
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const styled = e.clipboardData?.getData(STYLED);
    if (styled) {
      try {
        return t.paste(JSON.parse(styled));
      } catch {
        // Not ours after all: paste it as plain text.
      }
    }
    const text = e.clipboardData?.getData("text/plain");
    if (text) t.input(text);
  };

  return (
    <textarea
      ref={area}
      data-testid="text-input"
      aria-label="Type"
      class="pointer-events-none absolute h-6 w-px resize-none overflow-hidden border-0 bg-transparent p-0 text-transparent caret-transparent opacity-0 outline-none"
      style={{ left: `${at().x}px`, top: `${at().y}px` }}
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck={false}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => (e.key === "Control" || e.key === "Meta") && t.setTransforming(false)}
      onBeforeInput={onBeforeInput}
      onCompositionUpdate={(e) => t.compose(e.data, false)}
      onCompositionEnd={(e) => {
        t.compose(e.data, true);
        area.value = "";
      }}
      onInput={() => !editor.type.session()?.composing && (area.value = "")}
      onCopy={(e) => onCopy(e, false)}
      onCut={(e) => onCopy(e, true)}
      onPaste={onPaste}
    />
  );
}
