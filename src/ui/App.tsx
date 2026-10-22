import { Errored, For, Loading, Show, createMemo, createSignal, onSettled, useContext } from "solid-js";
import { flatten, maskValues, sampleHistograms, type Histograms } from "../core/composite";
import { intersect, isEmpty, rect } from "../core/geometry";
import { transformFloatingCpu } from "../core/raster";
import { contentBounds, readRect, storedBounds } from "../core/pixels";
import { renderShape } from "../core/shape";
import { placementMapping } from "../core/content";
import { findCommand, runCommand, stepBrushSize, toolForKey, type Shell } from "../editor/commands";
import { createEditor, type DocumentSession } from "../editor/editor";
import { MAX_LEVEL, requestDevice } from "../gpu/renderer";
import {
  EXTENSIONS,
  download,
  encodeDocument,
  encodePng,
  isPsdName,
  pickFiles,
  pickSaveTarget,
  readDocument,
  readImageTiles,
  readSmartSource,
  smartSourceDocument,
  stripExtension,
  writeFile,
  type ExportFormat,
  type OpenedFile,
} from "../io/files";
import { activeLayer, editTarget, resolutionOf, type Doc } from "../core/document";
import type { PreferencesPane } from "../editor/preferences";
import { listRecovery, newRecoveryKey, removeRecovery, saveRecovery } from "../io/recovery";
import { PreferencesDialog } from "./PreferencesDialog";
import { CanvasSizeDialog } from "./CanvasSizeDialog";
import { NewGuideDialog } from "./NewGuideDialog";
import { ImageSizeDialog } from "./ImageSizeDialog";
import type { Floating } from "../core/raster";
import { AppContext, type App as AppValue } from "./context";
import { Button } from "./controls";
import { Icon } from "./icons";
import { MenuBar, MenuList, type MenuItem } from "./MenuBar";
import { Popover, dismissable } from "./Popover";
import { NewDocumentDialog } from "./NewDocumentDialog";
import { OptionsBar } from "./OptionsBar";
import { Dock } from "./Dock";
import { HistoryPanel } from "./panels/HistoryPanel";
import { LayersPanel } from "./panels/LayersPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { TEST_CORE } from "./testHooks";
import { AdjustmentDialog } from "./AdjustmentDialog";
import type { AdjustmentKind } from "../core/adjustments";
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
    if (editor.updateSmartObject(s.id)) return;
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
    // Saving a smart object's contents updates the smart object, as in Photoshop.
    if (editor.updateSmartObject(s.id)) return;
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

  async function placeFiles(files: readonly File[]) {
    for (const file of files) {
      try {
        editor.placeEmbedded(await readSmartSource(file));
      } catch (err) {
        console.error(err);
        notify(`Couldn't place ${file.name}: ${errorText(err)}`);
      }
    }
  }

  async function editContents() {
    const s = editor.active();
    const layer = s && activeLayer(s.doc());
    if (!s || layer?.content.kind !== "smart") return;
    const source = layer.content.source;
    try {
      editor.openDocument(await smartSourceDocument(source), source.name, "Open", { parentId: s.id, sourceId: source.id });
    } catch (err) {
      console.error(err);
      notify(`Couldn't open the Smart Object: ${errorText(err)}`);
    }
  }

  // --- Clipboard ---------------------------------------------------------------
  // Copies go to the system clipboard as a PNG plus a token naming our own
  // copy, so pasting it back here is lossless (and pastes from other apps
  // still work). Ctrl+V is left to the browser, which delivers a paste event.
  let copyToken = "";
  let tokenCounter = 0;

  function toSystemClipboard(f: Floating | null) {
    if (!f) return;
    copyToken = `picturestore-copy:${Date.now().toString(36)}:${tokenCounter++}`;
    const item = new ClipboardItem({ "image/png": encodePng(f), "text/plain": new Blob([copyToken], { type: "text/plain" }) });
    navigator.clipboard?.write([item]).catch(() => {
      // Denied or unsupported: our own copy still pastes within the app.
    });
  }

  async function pasteFrom(data: { text: string; image: Blob | null }, inPlace: boolean) {
    if (data.image && data.text !== copyToken) {
      try {
        const pixels = await readImageTiles(data.image);
        if (editor.active()) editor.pasteImage(pixels);
        else editor.openDocument(await readDocument(data.image), "Untitled", "Paste");
      } catch (err) {
        notify(`Couldn't paste: ${errorText(err)}`);
      }
      return;
    }
    if (!editor.paste(inPlace) && editor.active()) notify("Nothing to paste.");
  }

  /** Paste from a menu, where there is no paste event: read the clipboard if allowed. */
  async function pasteFromMenu(inPlace: boolean) {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        const text = item.types.includes("text/plain") ? await (await item.getType("text/plain")).text() : "";
        if (type || text) return pasteFrom({ text, image: type ? await item.getType(type) : null }, inPlace);
      }
    } catch {
      // No permission: fall back to our own copy.
    }
    await pasteFrom({ text: copyToken, image: null }, inPlace);
  }

  /** Set by Ctrl+Shift+V so the paste event that follows pastes in place. */
  let pasteInPlace = false;

  const [menu, setMenu] = createSignal<{ x: number; y: number; items: readonly MenuItem[]; up?: boolean } | null>(null);
  const [adjusting, setAdjusting] = createSignal<{ session: DocumentSession; kind: AdjustmentKind; histogram: Histograms | null } | null>(null);
  const [choice, setChoice] = createSignal<{ message: string; options: readonly string[]; resolve: (i: number | null) => void } | null>(null);
  const choose = (message: string, options: readonly string[]) => new Promise<number | null>((resolve) => setChoice({ message, options, resolve }));
  const [confirmation, setConfirmation] = createSignal<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  const confirmDialog = (message: string) => new Promise<boolean>((resolve) => setConfirmation({ message, resolve }));
  editor.onConfirm(confirmDialog);
  const [prefsPane, setPrefsPane] = createSignal<PreferencesPane | null>(null);
  const [canvasSize, setCanvasSize] = createSignal<DocumentSession | null>(null);
  const [imageSizeFor, setImageSizeFor] = createSignal<DocumentSession | null>(null);
  const [newGuideFor, setNewGuideFor] = createSignal<DocumentSession | null>(null);

  // --- Recovery information ------------------------------------------------------
  // Every so often (Preferences ▸ File Handling), each document with unsaved
  // changes is written to browser storage; saving or closing it removes the
  // copy. A crash, or the tab being killed for memory, loses at most that long.
  const recovery = new Map<DocumentSession, { key: string; doc: Doc | null; at: number }>();
  let recovering = false;

  async function recoveryTick(force = false) {
    if (recovering) return;
    recovering = true;
    try {
      const minutes = editor.preferences().recoveryMinutes;
      const open = new Set(editor.sessions());
      for (const [s, r] of recovery) {
        if (open.has(s)) continue;
        recovery.delete(s);
        await removeRecovery(r.key);
      }
      for (const s of open) {
        let r = recovery.get(s);
        if (!r) recovery.set(s, (r = { key: newRecoveryKey(), doc: null, at: Date.now() }));
        if (!s.dirty() || minutes === 0) {
          if (r.doc) await removeRecovery(r.key);
          r.doc = null;
          continue;
        }
        const doc = s.doc();
        if (doc === r.doc || (!force && Date.now() - r.at < minutes * 60_000)) continue;
        await saveRecovery(r.key, s.name(), await encodeDocument(doc, "psd"));
        r.doc = doc;
        r.at = Date.now();
      }
    } catch (err) {
      console.warn("Couldn't save recovery information:", err);
    } finally {
      recovering = false;
    }
  }

  /** On startup: offers back documents a previous session didn't save. */
  async function offerRecovery() {
    const entries = await listRecovery();
    if (entries.length === 0) return;
    const names = entries.map((e) => `"${e.name}"`).join(", ");
    const ok = await confirmDialog(
      `Picturestore has recovery information for ${entries.length === 1 ? "an unsaved document" : `${entries.length} unsaved documents`} (${names}) from a previous session. Recover ${entries.length === 1 ? "it" : "them"}?`,
    );
    for (const e of entries) {
      try {
        if (ok) {
          const s = editor.openDocument(await readDocument(e.file), e.name, "Recovered");
          editor.markSaved(s.id, null); // still unsaved
        }
        await removeRecovery(e.key);
      } catch (err) {
        notify(`Couldn't recover ${e.name}: ${errorText(err)}`);
      }
    }
  }
  const answer = (ok: boolean) => {
    confirmation()?.resolve(ok);
    setConfirmation(null);
  };

  const shell: Shell = {
    newDocument: () => setShowNew(true),
    open: () => void pickFiles().then(openFiles, (err) => notify(`Couldn't open: ${errorText(err)}`)),
    save: () => void save(),
    saveAs: () => void saveAs(),
    exportAs: (format) => void exportAs(format),
    placeEmbedded: () => void pickFiles().then((files) => placeFiles(files.map((f) => f.file))),
    editContents: () => void editContents(),
    copy: (merged) => toSystemClipboard(editor.copy(merged)),
    cut: () => toSystemClipboard(editor.cut()),
    paste: (inPlace) => void pasteFromMenu(inPlace),
    preferences: (pane = "general") => setPrefsPane(pane),
    canvasSize: () => setCanvasSize(editor.active() as DocumentSession | null),
    imageSize: () => setImageSizeFor(editor.active() as DocumentSession | null),
    newGuide: () => setNewGuideFor(editor.active() as DocumentSession | null),
    adjust(kind) {
      const s = editor.active();
      const d = s?.doc();
      const t = d && editTarget(d);
      if (!s || !d || !t) return;
      // The histogram of what's adjusted: the target's pixels (a mask's values), within the selection.
      const values = t.mask ? maskValues(t.layer.mask!, rect(0, 0, d.width, d.height)) : t.pixels;
      const area = d.selection ? intersect(d.selection.bounds, storedBounds(values)) : contentBounds(values);
      const histogram = isEmpty(area) ? null : sampleHistograms((r) => readRect(values, r), area);
      setAdjusting({ session: s as DocumentSession, kind, histogram });
    },
    async deleteLayer(fromPanel = false) {
      const d = editor.active()?.doc();
      const l = d && activeLayer(d);
      if (!l) return;
      // The panel's trash with the mask targeted removes the mask, asking first whether to apply it (as Photoshop).
      if (fromPanel && d.maskTargeted && l.mask) {
        const options = l.content.kind === "pixels" ? ["Apply", "Delete"] : ["Delete"];
        const i = await choose("Apply mask to layer before removing?", options);
        if (i === null) return;
        return options[i] === "Apply" ? editor.applyMask() : editor.deleteMask();
      }
      if (l.content.kind !== "group" || l.content.layers.length === 0) return editor.deleteLayer();
      // Photoshop asks what to delete.
      const i = await choose("Delete the group and its contents, or the group only?", ["Group and Contents", "Group Only"]);
      if (i !== null) editor.deleteLayer(l.id, i === 1);
    },
  };
  const app: AppValue = { editor, shell, notify, openMenu: (x, y, items, up) => setMenu({ x, y, items, up: !!up }) };

  onSettled(() => {
    window.__ps = {
      ...window.__ps,
      editor,
      pixel: (x, y) => [...flatten(editor.active()!.displayed(), rect(x, y, 1, 1))],
      reference: { transformFloatingCpu, readRect, renderShape, flatten, placementMapping },
      saveRecovery: () => recoveryTick(true),
      core: TEST_CORE,
    };
    void offerRecovery();
    const recoveryTimer = window.setInterval(() => void recoveryTick(), 15_000);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || showNew() || confirmation() || prefsPane() || canvasSize() || imageSizeFor() || newGuideFor()) return;
      const id = findCommand(e);
      if (id === "edit.paste" || id === "edit.pasteInPlace") {
        // Let the browser deliver a paste event with the clipboard's contents.
        pasteInPlace = id === "edit.pasteInPlace";
        return;
      }
      if (id) {
        e.preventDefault();
        runCommand(id, editor, shell);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (editor.toolKey({ key: e.key, shift: e.shiftKey })) return e.preventDefault();
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

    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || showNew() || confirmation() || !e.clipboardData) return;
      e.preventDefault();
      const image = [...e.clipboardData.files].find((f) => f.type.startsWith("image/")) ?? null;
      void pasteFrom({ text: e.clipboardData.getData("text/plain"), image }, pasteInPlace);
      pasteInPlace = false;
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    // Files dropped onto an open document are placed into it (as smart
    // objects); dropped anywhere else they open as documents.
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      const onCanvas = (e.target as Element | null)?.closest?.("[data-testid=viewport]");
      if (onCanvas && editor.active()) void placeFiles(files);
      else void openFiles(files.map((file) => ({ file, handle: null })));
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editor.sessions().some((s) => s.dirty())) e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      clearInterval(recoveryTimer);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  });

  // Documents live on the CPU and the GPU only caches them, so a lost device
  // (driver reset, GPU switch) is recovered by requesting a new one.
  const [deviceEpoch, setDeviceEpoch] = createSignal(0);
  let lastLoss = -Infinity;
  const readback = new URLSearchParams(location.search).get("present") === "readback";
  const device = createMemo(() => {
    const epoch = deviceEpoch();
    return requestDevice().then((d) => {
      void d.lost.then((info) => {
        if (info.reason === "destroyed" || epoch !== deviceEpoch()) return;
        console.warn("WebGPU device lost:", info.message);
        // Lost again soon after a reset: likely GPU memory, so come back at lower display quality.
        const now = performance.now();
        if (now - lastLoss < 120_000) editor.setGpuLevel(Math.min(MAX_LEVEL, editor.memory().gpuLevel + 1));
        lastLoss = now;
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
          <Dock panels={{ history: () => <HistoryPanel />, properties: () => <PropertiesPanel />, layers: () => <LayersPanel /> }} />
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
      <Popover
        open={menu() !== null}
        onClose={() => setMenu(null)}
        fixed
        style={{ left: `${menu()?.x ?? 0}px`, top: `${menu()?.y ?? 0}px`, transform: menu()?.up ? "translateY(-100%)" : undefined }}
        testId="context-menu"
      >
        <div onContextMenu={(e) => e.preventDefault()}>
          <MenuList items={menu()?.items ?? []} onDone={() => setMenu(null)} />
        </div>
      </Popover>
      <Show when={prefsPane()} keyed>
        {(pane) => <PreferencesDialog pane={pane} onClose={() => setPrefsPane(null)} />}
      </Show>
      <Show when={canvasSize()} keyed>
        {(s) => (
          <CanvasSizeDialog
            width={s.doc().width}
            height={s.doc().height}
            onApply={(w, h, anchor) => editor.active() === s && editor.canvasSize(w, h, anchor)}
            onClose={() => setCanvasSize(null)}
          />
        )}
      </Show>
      <Show when={newGuideFor()} keyed>
        {(s) => (
          <NewGuideDialog
            resolution={resolutionOf(s.doc())}
            onAdd={(o, p) => editor.active() === s && editor.addGuide(o, p)}
            onClose={() => setNewGuideFor(null)}
          />
        )}
      </Show>
      <Show when={imageSizeFor()} keyed>
        {(s) => (
          <ImageSizeDialog
            original={{ width: s.doc().width, height: s.doc().height, resolution: resolutionOf(s.doc()) }}
            renderPreview={(r, w, scale) => (editor.active() === s ? editor.imageSizePreview(r, w, scale) : Promise.resolve(null))}
            onApply={(r) => editor.active() === s && editor.imageSize(r)}
            onClose={() => {
              setImageSizeFor(null);
              editor.endImageSizePreview();
            }}
          />
        )}
      </Show>
      <Show when={adjusting()} keyed>
        {(a) => (
          <AdjustmentDialog
            kind={a.kind}
            foreground={editor.foreground()}
            background={editor.background()}
            histogram={a.histogram}
            onPreview={(adj) => editor.active() === a.session && editor.previewAdjustment(adj)}
            onApply={(adj) => editor.active() === a.session && editor.applyAdjustment(adj)}
            onClose={() => setAdjusting(null)}
          />
        )}
      </Show>
      <Show when={choice()}>
        {(c) => (
          <ChoiceDialog
            message={c().message}
            options={c().options}
            onAnswer={(i) => {
              c().resolve(i);
              setChoice(null);
            }}
          />
        )}
      </Show>
      <Show when={confirmation()}>{(c) => <ConfirmDialog message={c().message} onAnswer={answer} />}</Show>
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

/** A prompt with several answers and Cancel (Photoshop's Delete group prompt). Escape cancels. */
function ChoiceDialog(props: { message: string; options: readonly string[]; onAnswer: (i: number | null) => void }) {
  onSettled(() => dismissable(() => props.onAnswer(null)));
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/40" data-testid="choice-dialog">
      <div class="w-[28rem] rounded-sm border border-line bg-panel p-4 shadow-2xl" role="alertdialog" aria-modal="true">
        <p class="mb-4 leading-relaxed">{props.message}</p>
        <div class="flex justify-end gap-2">
          <For each={props.options}>
            {(o, i) => (
              <Button primary={i() === 0} onClick={() => props.onAnswer(i())} testId={`choice-${i()}`}>
                {o}
              </Button>
            )}
          </For>
          <Button onClick={() => props.onAnswer(null)} testId="choice-cancel">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Photoshop-style OK/Cancel prompt. Enter confirms, Escape cancels. */
function ConfirmDialog(props: { message: string; onAnswer: (ok: boolean) => void }) {
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      props.onAnswer(true);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const remove = dismissable(() => props.onAnswer(false));
    return () => {
      remove();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/40" data-testid="confirm-dialog">
      <div class="w-96 rounded-sm border border-line bg-panel p-4 shadow-2xl" role="alertdialog" aria-modal="true">
        <p class="mb-4 leading-relaxed">{props.message}</p>
        <div class="flex justify-end gap-2">
          <Button onClick={() => props.onAnswer(false)} testId="confirm-cancel">
            Cancel
          </Button>
          <Button primary onClick={() => props.onAnswer(true)} testId="confirm-ok">
            OK
          </Button>
        </div>
      </div>
    </div>
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
