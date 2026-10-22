/**
 * Cursors for the path tools, as SVG data URLs (hot spot at the tip), like
 * Photoshop's: a pen with a small symbol for what a click will do, and the
 * black and white arrows of the selection tools.
 */
export type PenCursor = "pen" | "close" | "slash" | "connect" | "continue" | "plus" | "minus" | "convert" | "direct" | "path" | "freeform" | "magnetic" | "curvature";

const PEN = '<path d="M3 3 L13 7 L21 25 L16 29 L6 13 Z M3 3 L9 13" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>';
const ARROW = (fill: string) => `<path d="M4 3 L4 21 L9 16.5 L12.5 24 L15.5 22.5 L12 15.5 L19 15.5 Z" fill="${fill}" stroke="${fill === "black" ? "white" : "black"}" stroke-width="1.3" stroke-linejoin="round"/>`;
const BADGE = (inner: string) => `<g transform="translate(18 22)" stroke="black" stroke-width="1.5" fill="none" stroke-linecap="round">${inner}</g>`;

const BODY: Record<PenCursor, string> = {
  pen: PEN,
  close: PEN + BADGE('<circle cx="4" cy="4" r="3.2" fill="white"/>'),
  slash: PEN + BADGE('<path d="M0 8 L8 0"/>'),
  connect: PEN + BADGE('<path d="M0 4 H8 M4 0 V8"/><circle cx="4" cy="4" r="5" fill="none"/>'),
  continue: PEN + BADGE('<path d="M0 8 L8 0"/><path d="M0 0 H3"/>'),
  plus: PEN + BADGE('<path d="M0 4 H8 M4 0 V8"/>'),
  minus: PEN + BADGE('<path d="M0 4 H8"/>'),
  convert: ARROW("white") + BADGE('<path d="M0 8 L4 0 L8 8"/>'),
  direct: ARROW("white"),
  path: ARROW("black"),
  freeform: PEN + BADGE('<path d="M0 6 Q2 0 4 4 T8 2"/>'),
  magnetic: PEN + BADGE('<path d="M0 8 V3 A4 4 0 0 1 8 3 V8"/>'),
  curvature: PEN + BADGE('<path d="M0 8 Q4 -4 8 8"/>'),
};

const cache = new Map<PenCursor, string>();

export function penCursor(kind: PenCursor): string {
  let c = cache.get(kind);
  if (!c) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${BODY[kind]}</svg>`;
    // The arrows point from their corner; the pens from theirs, a little in.
    const [x, y] = kind === "direct" || kind === "path" || kind === "convert" ? [4, 3] : [3, 3];
    cache.set(kind, (c = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`));
  }
  return c;
}
