import { createContext } from "solid-js";
import type { Shell } from "../editor/commands";
import type { Editor } from "../editor/editor";

export interface App {
  readonly editor: Editor;
  readonly shell: Shell;
  readonly notify: (message: string) => void;
}

/** Default-less: using it outside <AppContext> throws. */
export const AppContext = createContext<App>();

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
