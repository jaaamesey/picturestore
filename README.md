# picturestore

Legally distinct from Photoshop.

A browser image editor aiming at Photopea's feature set (and eventually a Photoshop replacement), built on
**SolidJS 2**, **WebGPU** and **Tailwind CSS 4**.

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # typecheck + unit tests
pnpm test:e2e     # Playwright (builds and serves the app itself)
```

## What works today

- **Documents**: tabs, new-document presets, open PSD / PNG / JPEG / WebP / `.pstore` (or drop files anywhere),
  save `.pstore`, export PSD / PNG / JPG / WebP.
- **Painting**: brush and eraser with size, hardness, opacity, flow, pen pressure, shift-click lines; paint
  bucket; fill/clear; eyedropper; foreground/background colours with an HSV picker.
- **Selecting**: rectangular and elliptical marquee, lasso, magic wand; replace/add/subtract/intersect
  (Shift/Alt like Photoshop), select all, deselect, inverse. Selections are antialiased 8-bit masks and clip
  painting, fills and transforms.
- **Transforming**: Move tool, and Free Transform (Alt+Ctrl+T) with scale/rotate handles, proportional and
  from-centre modifiers, 15° snapping, numeric entry, Enter/Esc.
- **Layers**: add, duplicate, delete, merge down, reorder (drag), rename, visibility, opacity and 20 blend modes.
- **History**: 50-step undo/redo, plus a clickable History panel.
- **View**: zoom (Ctrl +/−/0/1, Ctrl/Alt+wheel about the cursor), pan (wheel, Space-drag, Hand tool).

## Architecture

```
src/
  core/     Pure TypeScript: no DOM, no Solid, no GPU. Everything here is unit tested.
  io/       File formats (.pstore, PSD via ag-psd) and browser file glue.
  gpu/      WebGPU renderer and WGSL shaders.
  editor/   Editor state (Solid signals/stores), tools, commands and shortcuts.
  ui/       Solid components.
e2e/        Playwright tests.
```

**Immutable documents with structural sharing.** A `Doc` is a plain immutable value. Layer pixels live in a
sparse grid of 256×256 RGBA tiles in document space (so layers can extend past the canvas). Edits go through a
copy-on-write `TileWriter`, so a new `Doc` shares every untouched layer and tile with its predecessor. Undo
history is therefore just a list of snapshots, and each step costs roughly the size of what it changed.

**The CPU owns pixels; the GPU is a cache.** Tools edit tiles on the CPU (deterministic and testable). The
renderer diffs tiles by identity and version and uploads only what changed, then recomposites only the dirty
rectangle (scissored passes into an `rgba16float` accumulator), and finally presents with pan/zoom, a mip chain
for zoomed-out views, the transparency checkerboard and GPU-drawn marching ants for arbitrary selection shapes.
Because nothing lives only on the GPU, a lost device is recovered transparently.

**Tools are plain state machines.** A tool receives a `ToolContext` (current doc, view, settings, and
`preview`/`commit`/`overlay` callbacks) and never touches signals or the GPU. That keeps tools testable with a
plain object (`editor/tools/tools.test.ts`) and keeps reactivity at the edges. While a tool is mid-operation it
shows a *preview* doc (and optionally *floating* pixels drawn through a transform matrix by the compositor),
then commits a single history step.

**Blend modes are implemented twice** — `core/blend.ts` (reference) and WGSL (`gpu/shaders.ts`) — following the
W3C compositing spec with PSD's mode names. An e2e test checks GPU output against the CPU reference for every
mode.

**Commands** (menus and shortcuts) live in one registry (`editor/commands.ts`), so menus show the same bindings
the keyboard uses. Browsers reserve Ctrl+T/N/W, so as in Photopea the primary bindings add Alt.

### Rendering fallback

Some environments (VMs, remote desktops, headless CI) can create a WebGPU device but can't present to a WebGPU
canvas. The renderer has a readback presentation mode (render offscreen, copy into a 2D canvas) that the app
switches to automatically if the device is lost; `?present=readback` forces it, which the e2e tests use.

## The `.pstore` format

A small JSON manifest followed by deflate-compressed binary chunks — the same shape as glTF's `.glb`:

```
"PSTR" | u32 version | u32 manifestLength | manifest (UTF-8 JSON) | chunks…
```

The manifest lists the canvas size, layers (name, visibility, opacity, blend mode) and, for each layer, its
non-empty tiles as `{ x, y, chunk: { offset, length } }`; the selection mask is one more chunk. It maps 1:1 onto
the in-memory model, stays compact for sparse layers, and the JSON is trivially extensible. PSD remains the
interchange format.

## Roadmap

Roughly in Photopea's order: layer groups and masks, adjustment layers and filters (GPU), text and shapes,
crop/canvas size/image size, more selection tools (polygonal lasso, quick select, feather/modify), brush
presets and smoothing, clipboard, File System Access saving, and moving painting to the GPU for very large
brushes.
