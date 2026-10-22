import { NO_TEXT_STYLES, type TextStyles } from "../text/model";

/**
 * Type ▸ Save / Load Default Type Styles: named styles kept in this browser,
 * which new documents start with, as Photoshop's defaults do.
 */

const KEY = "picturestore.typeStyles";

export function loadDefaultStyles(): TextStyles {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as TextStyles | null;
    return s && Array.isArray(s.character) && Array.isArray(s.paragraph) ? s : NO_TEXT_STYLES;
  } catch {
    return NO_TEXT_STYLES;
  }
}

export function saveDefaultStyles(s: TextStyles): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage full or disabled.
  }
}
