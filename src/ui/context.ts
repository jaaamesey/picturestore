import { createContext } from "solid-js";
import type { Shell } from "../editor/commands";
import type { Editor } from "../editor/editor";
import type { MenuItem } from "./MenuBar";

export interface App {
  readonly editor: Editor;
  readonly shell: Shell;
  readonly notify: (message: string) => void;
  /** Opens a context menu at viewport coordinates (one at a time; Escape or clicking elsewhere closes it). */
  readonly openMenu: (x: number, y: number, items: readonly MenuItem[]) => void;
}

/** Default-less: using it outside <AppContext> throws. */
export const AppContext = createContext<App>();

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
