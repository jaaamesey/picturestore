import { Errored, For, Loading, Show, createMemo, createSignal, onSettled, useContext } from "solid-js";
import { flatten } from "../core/document";
import { rect } from "../core/geometry";
import { transformFloatingCpu } from "../core/raster";
import { readRect } from "../core/tiles";
import { findCommand, runCommand, stepBrushSize, toolForKey, type Shell } from "../editor/commands";
import { createEditor, type DocumentSession } from "../editor/editor";
import { requestDevice } from "../gpu/renderer";
import {
  EXTENSIONS,
  download,
  encodeDocument,
  isPsdName,
  pickFiles,
  pickSaveTarget,
  readDocument,
  stripExtension,
  writeFile,
  type ExportFormat,
  type OpenedFile,
} from "../io/files";
import { AppContext, type App as AppValue } from "./context";
import { Button } from "./controls";
import { Icon } from "./icons";
import { MenuBar } from "./MenuBar";
import { NewDocumentDialog } from "./NewDocumentDialog";
import { OptionsBar } from "./OptionsBar";
import { HistoryPanel } from "./panels/HistoryPanel";
import { LayersPanel } from "./panels/LayersPanel";
import { Toolbar } from "./Toolbar";
import { Viewport } from "./Viewport";

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;

export function App() {
  const editor = createEditor();
  const [showNew, setShowNew] = createSignal(false);
  const [message, setMessage] = createSignal<string | null>(null);
  let messageTimer = 0;

  const notify = (m: string) => {
    setMessage(m);
    clearTimeout(messageTimer);
    messageTimer = window.setTimeout(() => setMessage(null), 4000);
  };

  /** Where each document lives on disk, when the browser lets us save back in place. */
  const fileHandles = new WeakMap<DocumentSession, FileSystemFileHandle>();
  editor.onError(notify);

  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function openFiles(files: readonly OpenedFile[]) {
    for (const { file, handle } of files) {
      try {
        const session = editor.openDocument(await readDocument(file), stripExtension(file.name));
        // Only PSDs save back to their own file; images get "Save as PSD".
        if (handle && isPsdName(file.name)) fileHandles.set(session, handle);
      } catch (err) {
        console.error(err);
        notify(`Couldn't open ${file.name}: ${errorText(err)}`);
      }
    }
  }

  async function saveAs() {
    const s = editor.active();
    if (!s) return;
    try {
      const target = await pickSaveTarget(`${s.name()}.psd`);
      if (target === null) return; // cancelled
      const doc = s.doc();
      const blob = await encodeDocument(doc, "psd");
      if (target === "unsupported") {
        download(blob, `${s.name()}.psd`);
      } else {
        await writeFile(target, blob);
        fileHandles.set(s, target);
        editor.renameDocument(s.id, stripExtension(target.name));
      }
      editor.markSaved(s.id, doc);
    } catch (err) {
      console.error(err);
      notify(`Save failed: ${errorText(err)}`);
    }
  }

  async function save() {
    const s = editor.active();
    if (!s) return;
    const handle = fileHandles.get(s);
    if (!handle) return saveAs();
    try {
      const doc = s.doc();
      await writeFile(handle, await encodeDocument(doc, "psd"));
      editor.markSaved(s.id, doc);
    } catch (err) {
      console.error(err);
      notify(`Save failed: ${errorText(err)}`);
    }
  }

  async function exportAs(format: ExportFormat) {
    const s = editor.active();
    if (!s) return;
    try {
      download(await encodeDocument(s.doc(), format), `${s.name()}.${EXTENSIONS[format]}`);
    } catch (err) {
      console.error(err);
      notify(`Export failed: ${errorText(err)}`);
    }
  }

  const shell: Shell = {
    newDocument: () => setShowNew(true),
    open: () => void pickFiles().then(openFiles, (err) => notify(`Couldn't open: ${errorText(err)}`)),
    save: () => void save(),
    saveAs: () => void saveAs(),
    exportAs: (format) => void exportAs(format),
  };
  const app: AppValue = { editor, shell, notify };

  onSettled(() => {
    window.__ps = {
      ...window.__ps,
      editor,
      pixel: (x, y) => [...flatten(editor.active()!.displayed(), rect(x, y, 1, 1))],
      reference: { transformFloatingCpu, readRect },
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || showNew()) return;
      const id = findCommand(e);
      if (id) {
        e.preventDefault();
        runCommand(id, editor, shell);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Enter") return editor.commitTool();
      if (e.key === "Escape") return editor.cancelTool();
      if (e.key === "x" || e.key === "X") return editor.swapColors();
      if (e.key === "d" || e.key === "D") return editor.resetColors();
      if (e.key === "[" || e.key === "]") {
        const t = editor.tool() === "eraser" ? "eraser" : "brush";
        const size = stepBrushSize(editor.settings[t].size, e.key === "]" ? 1 : -1);
        return editor.setSettings((s) => void (s[t].size = size));
      }
      const tool = toolForKey(e.key, editor.tool(), e.shiftKey);
      if (tool) editor.setTool(tool);
    };

    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length) void openFiles([...e.dataTransfer.files].map((file) => ({ file, handle: null })));
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editor.sessions().some((s) => s.dirty())) e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  });

  // Documents live on the CPU and the GPU only caches them, so a lost device
  // (driver reset, GPU switch) is recovered by requesting a new one.
  const [deviceEpoch, setDeviceEpoch] = createSignal(0);
  const readback = new URLSearchParams(location.search).get("present") === "readback";
  const device = createMemo(() => {
    const epoch = deviceEpoch();
    return requestDevice().then((d) => {
      void d.lost.then((info) => {
        if (info.reason === "destroyed" || epoch !== deviceEpoch()) return;
        console.warn("WebGPU device lost:", info.message);
        notify("The GPU was reset; restored the canvas.");
        setDeviceEpoch(epoch + 1);
      });
      return d;
    });
  });

  return (
    <AppContext value={app}>
      <div class="flex h-full flex-col">
        <MenuBar />
        <OptionsBar />
        <div class="flex min-h-0 flex-1">
          <Toolbar />
          <main class="flex min-w-0 flex-1 flex-col">
            <Tabs />
            <div class="relative min-h-0 flex-1">
              <Errored fallback={(err) => <div class="grid h-full place-items-center p-8 text-dim">{errorText(err())}</div>}>
                <Loading fallback={<div class="grid h-full place-items-center text-dim">Starting GPU…</div>}>
                  <Viewport device={device()} readback={readback} />
                </Loading>
              </Errored>
              <Show when={editor.sessions().length === 0}>
                <StartScreen />
              </Show>
            </div>
          </main>
          <aside class="flex w-64 flex-col border-l border-line bg-panel">
            <HistoryPanel />
            <LayersPanel />
          </aside>
        </div>
      </div>
      <Show when={showNew()}>
        <NewDocumentDialog
          onClose={() => setShowNew(false)}
          onCreate={(opts, name) => {
            setShowNew(false);
            editor.newDocument(opts, name);
          }}
        />
      </Show>
      <Show when={message()}>
        {(m) => (
          <div class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-sm bg-raised px-4 py-2 shadow-xl" role="status">
            {m()}
          </div>
        )}
      </Show>
    </AppContext>
  );
}

function Tabs() {
  const { editor } = useContext(AppContext);
  return (
    <div class="flex h-7 shrink-0 items-end gap-px overflow-x-auto bg-app" role="tablist">
      <For each={editor.sessions()}>
        {(s) => (
          <div
            role="tab"
            aria-selected={editor.active() === s ? "true" : "false"}
            data-testid="doc-tab"
            class={[
              "flex h-6 cursor-default items-center gap-2 rounded-t-sm pr-1 pl-3",
              editor.active() === s ? "bg-panel text-white" : "bg-panel-2/60 text-dim hover:text-fg",
            ]}
            onClick={() => editor.setActive(s.id)}
          >
            <span>
              {s.name()}
              {s.dirty() ? " *" : ""}
            </span>
            <button
              type="button"
              title="Close"
              class="grid size-4 place-items-center rounded-sm hover:bg-raised"
              onClick={(e) => {
                e.stopPropagation();
                if (!s.dirty() || confirm(`Close "${s.name()}" without saving?`)) editor.closeDocument(s.id);
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

function StartScreen() {
  const { shell } = useContext(AppContext);
  return (
    <div class="absolute inset-0 grid place-items-center bg-app" data-testid="start-screen">
      <div class="flex flex-col items-center gap-5 text-center">
        <h1 class="text-2xl font-light text-white">Picturestore</h1>
        <p class="max-w-sm text-dim">A fast, GPU-accelerated image editor. Open a PSD, image or .pstore file — or drop one anywhere.</p>
        <div class="flex gap-3">
          <Button primary onClick={shell.newDocument} testId="start-new">
            <span class="flex items-center gap-2">
              <Icon name="file" size={16} /> New Project
            </span>
          </Button>
          <Button onClick={shell.open} testId="start-open">
            <span class="flex items-center gap-2">
              <Icon name="folder" size={16} /> Open From Computer
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}
