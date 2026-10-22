import { replaceText, styleAt, type TextContent, type TextRange } from "./model";

/**
 * Edit ▸ Find and Replace Text, and Check Spelling's walk through words:
 * matching in type layers' text, with Photoshop's options.
 */

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  /** Ignore Accents: "é" matches "e". */
  readonly ignoreAccents: boolean;
  /** Search backwards from the start of the current selection. */
  readonly backward?: boolean;
}

/** Text folded for comparison: accents removed (one character for one, so indices hold) and case folded. */
function fold(s: string, o: FindOptions): string {
  let out = s;
  if (o.ignoreAccents) out = [...out].map((ch) => (ch.length === 1 ? (ch.normalize("NFD")[0] ?? ch) : ch)).join("");
  return o.caseSensitive ? out : out.toLowerCase();
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_'’]/u.test(c);

/** Every match of `query` in `text`, in order. */
export function findAll(text: string, query: string, o: FindOptions): TextRange[] {
  if (!query) return [];
  const t = fold(text, o), q = fold(query, o);
  const out: TextRange[] = [];
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + Math.max(1, q.length))) {
    if (o.wholeWord && (isWordChar(text[i - 1]) || isWordChar(text[i + q.length]))) continue;
    out.push({ start: i, end: i + q.length });
  }
  return out;
}

/** The next match after (or, backward, before) a selection, wrapping within the text if `wrap`. */
export function findFrom(text: string, query: string, from: TextRange, o: FindOptions, wrap = false): TextRange | null {
  const all = findAll(text, query, o);
  if (!all.length) return null;
  if (o.backward) return [...all].reverse().find((m) => m.end <= from.start && !(m.start === from.start && m.end === from.end)) ?? (wrap ? all[all.length - 1] : null);
  return all.find((m) => m.start >= from.end || m.start > from.start) ?? (wrap ? all[0] : null);
}

/** Every match replaced, each taking the style of the text it replaces (its first character). */
export function replaceAll(c: TextContent, query: string, replacement: string, o: FindOptions): { content: TextContent; count: number } {
  const matches = findAll(c.text, query, o);
  let out = c;
  for (const m of [...matches].reverse()) out = replaceText(out, m, replacement, styleAt(out, m.start + 1));
  return { content: out, count: matches.length };
}

/** The words of a text (letters, digits and apostrophes), for checking spelling. */
export function wordsIn(text: string): { word: string; start: number; end: number }[] {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}'’]+/gu)].filter((m) => /\p{L}/u.test(m[0])).map((m) => ({ word: m[0].replace(/^['’]+|['’]+$/g, ""), start: m.index + (m[0].length - m[0].replace(/^['’]+/, "").length), end: m.index + m[0].replace(/['’]+$/, "").length }));
}
