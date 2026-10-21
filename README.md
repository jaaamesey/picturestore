# picturestore

A vibe coded slop version of Photoshop, that _might eventually_ have a bit more care put into it

# WARNING: AI SLOP DESCRIPTION BELOW

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

- **Documents**: tabs, new-document presets, open PSD / PNG / JPEG / WebP (or drop files anywhere). **PSD is the
  native format**: Ctrl+S saves back to the file you opened (File System Access API; elsewhere it downloads),
  Ctrl+Shift+S saves as PSD, and PNG / JPG / WebP export. Encoding and decoding run in a Web Worker.
- **Painting**: brush and eraser with size, hardness, opacity, flow, pen pressure, shift-click lines; paint
  bucket; fill/clear; eyedropper; foreground/background colours with an HSV picker.
- **Selecting**: rectangular and elliptical marquee, lasso, magic wand; replace/add/subtract/intersect
  (Shift/Alt like Photoshop), select all, deselect, inverse. Selections are antialiased 8-bit masks and clip
  painting, fills and transforms.
- **Transforming**, following Photoshop 2020+ (non-legacy) behaviour:
  - Move tool with **Show Transform Controls** (on by default): drag inside to move, drag a handle (or just
    outside a corner to rotate) to drop into Free Transform.
  - Free Transform (Alt+Ctrl+T): proportional scaling by default on every handle (Shift toggles, the options-bar
    link flips the default), Alt from the reference point, rotate outside the box (Shift: 15° steps),
    Ctrl+corner distort, Ctrl+side edge move, Ctrl+Shift+side skew (Alt: both sides), Ctrl+Alt+Shift+corner
    perspective.
  - Edit ▸ Transform / right-click: Scale, Rotate, Skew, Distort, Perspective and Warp modes; Rotate 180°/90°
    and Flip, which apply immediately outside a session.
  - Warp: a bicubic Bézier mesh — drag anchors (handles follow), handles, interior points, or the surface itself.
  - Options bar: reference point toggle and locator (Alt-click also places it), X/Y, W/H with link, angle,
    H/V skew, interpolation (bicubic / bilinear / nearest), Warp toggle, cancel/commit. Ctrl+Z steps back
    inside a session; Enter, double-click or ✓ commits; Esc cancels.
- **Smart objects**: File ▸ Place Embedded (or drop an image onto the canvas) places an image as an embedded
  smart object — centred, fitted to the canvas, in a Free Transform session (Esc discards it). Transforms
  re-render from the embedded source, so scaling down and back up loses nothing. Convert to Smart Object,
  Rasterize Layer, and Edit Contents (opens the contents as a document; saving it updates every instance). If
  the contents' canvas size changes, the layer keeps its transform — same scale, rotation, perspective and warp
  — with the new contents centred where the old ones were, as in Photoshop.
- **Image ▸ Canvas Size** (Alt+Ctrl+C): new width/height, Relative, and a 3×3 anchor.
  Pixel tools on a smart object or shape ask to rasterize it first, with Photoshop's prompts.
- **Shapes**: Rectangle (corner radius), Ellipse, Triangle, Polygon (sides, star ratio) and Line (weight) tools
  (U / Shift+U, toolbar flyout). Shift constrains, Alt draws from the centre. Shape mode makes live shape
  layers with fill and stroke (width, inside/centre/outside); with a shape selected the options bar edits it.
  Pixels mode fills into the active layer. Shapes transform exactly (vectors are re-rendered, strokes keep
  their width); while dragging, their pixels are carried through the transform on the GPU, as raster layers'
  are, so moving large shapes is as smooth.
- **Clipboard**: Cut, Copy, Copy Merged, Paste (centred on the selection or the visible canvas) and Paste in
  Place. Copies also go to the system clipboard as PNG; images pasted from other apps become new layers (or a
  new document when none is open). Layer via Copy / Cut (Ctrl+J / Ctrl+Shift+J).
- **Layers**: add, duplicate, delete, merge down, rename, visibility, opacity and 20 blend modes; right-click a
  layer (or the canvas) for a context menu. Reorder by dragging — the row lifts and follows the pointer while
  the others slide aside, the list auto-scrolls, Esc cancels — or with Layer ▸ Arrange (Ctrl+[ / Ctrl+],
  with Shift for back/front). Every reorder animates, whatever caused it (`ui/sortable.ts`: FLIP transforms
  over the real layout, so motion can't leave anything misplaced; respects reduced motion).
- **History**: undo/redo with a clickable History panel, limited by History States (default 50) and Memory Usage.
- **Preferences** (Ctrl+K, Edit ▸ Preferences), organised as Photoshop's: General (reset), File Handling (recovery
  interval) and Performance (Memory Usage, History States, display quality). Kept in the browser.
- **Running out of memory** is handled rather than fatal:
  - *RAM*: open documents and their history share the Memory Usage budget; past it the oldest history states
    are freed. If an allocation fails anyway, the operation is abandoned, undo history is cleared to free memory
    and a message says so; documents are never discarded.
  - *GPU*: if the tile atlas can't grow or a GPU allocation fails, the canvas is redrawn at 1/2, 1/4… resolution
    (down to 1/16), hidden layers keep no GPU copy, and documents larger than the GPU's texture limit open
    reduced. Commits are still full quality (GPU, or the CPU reference if the GPU can't). Repeated device loss
    also steps quality down.
  - A status-bar warning shows what's been given up, with "Retry full quality".
  - *Recovery*: unsaved documents are written to browser storage (OPFS) every 10 minutes by default and offered
    back on the next start, so a crashed or killed tab loses at most that long.
- **PSD**: smart objects round-trip as placed layers with their embedded files (and custom warps); solid-colour
  shape layers round-trip as vector masks with fill and stroke.
- **View**: zoom (Ctrl +/−/0/1, Ctrl/Alt+wheel about the cursor), pan (wheel, Space-drag, Hand tool).

## Architecture

```
src/
  core/     Pure TypeScript: no DOM, no Solid, no GPU. Everything here is unit tested.
  io/       PSD/image codecs (run in a Web Worker) and file access.
  gpu/      WebGPU renderer and WGSL shaders.
  editor/   Editor state (Solid signals/stores), tools, typed commands and shortcuts.
  ui/       Solid components.
e2e/        Playwright tests.
```

**Immutable documents with structural sharing.** A `Doc` is a plain immutable value. Layer pixels live in a
sparse grid of 256×256 RGBA tiles in document space (so layers can extend past the canvas), keyed by packed
integers. Edits go through a copy-on-write `TileWriter`, so each new `Doc` shares every untouched layer and
tile with its predecessor; undo history is a list of snapshots costing roughly what each step changed. Each
history entry records the bytes it newly retains (by object identity: new tiles, smart object sources), and
the oldest states are dropped past 50 steps or the memory budget. Asynchronous commits (GPU resampling) block
input until they land, and a result is discarded rather than applied if its base document changed.

**Layer content** is pixels, a smart object (an embedded source plus a placement: quad, orientation, warp) or a
shape (vector geometry plus fill/stroke, also placed). A layer's tiles are always its rendered pixels, so the
compositor and GPU never care which kind it is; transforming a smart object or shape edits its placement and
re-renders. Shapes rasterize with the same exact-area coverage as selections, with adaptive Bézier
flattening after mapping and strokes built from edge quads with miter/bevel joins.
Selection masks store only their bounds.

**The CPU owns pixels; the GPU is a cache.** Tools edit tiles on the CPU (deterministic and testable). The
renderer keeps on-canvas tiles in a shared **tile atlas** (a texture array grown on demand), so GPU memory
scales with content rather than layers × canvas size. Each layer composites as one instanced draw over its
tiles: Normal layers use fixed-function premultiplied blending in a single pass; other blend modes read a
scissored copy of the destination. Only dirty regions are recomposited and re-mipmapped. Because nothing lives
only on the GPU, a lost device is recovered by re-uploading.

**Transforms are exact projective maps plus an optional warp.** A transform is the quad the source's corners
land on (a homography, computed with Heckbert's square-to-quad), the box's orientation, a reference point and
an optional bicubic Bézier patch applied *before* the homography — so perspective stays exact even when
warped. Previews draw the floating pixels through a mesh whose vertices carry homogeneous `w`, letting the
GPU's perspective-correct interpolation reproduce the homography exactly. Commits resample on the GPU with
per-pixel LOD and Keys bicubic over a premultiplied mip chain, in bounded chunks. `core/rasterize.ts` is the CPU
reference (a perspective-correct triangle rasterizer with per-pixel mip selection) used for selection masks and
by a GPU-vs-CPU parity test.

**Algorithms chosen for the hot paths**: exact-area polygon coverage (font-rs style accumulation) for lasso and
ellipse selections; scanline span fill for the magic wand; a radial falloff LUT over squared distance with
per-row spans for brush dabs; allocation-free per-mode row kernels for CPU compositing; word-at-a-time tile
scans with cached per-tile bounds and area-averaged previews (for thumbnails).

**Tools are plain state machines.** A tool receives a `ToolContext` (current doc, view, settings, and
`preview`/`commit`/`commitAsync`/`resample`/`overlay`) and never touches signals or the GPU, which keeps tools
unit-testable with a plain object (`editor/tools/tools.test.ts`).

**Blend modes are implemented twice** — `core/blend.ts` (reference) and WGSL — following the W3C compositing
spec with PSD's mode names. An e2e test checks GPU output against the CPU reference for every mode.

**Commands** (menus, context menu and shortcuts) live in one typed registry (`editor/commands.ts`); `CommandId`
is derived from it, so a menu can't reference a command that doesn't exist. Browsers reserve Ctrl+T/N/W, so as
in Photopea the primary bindings add Alt.

Headless test browsers can render WebGPU but not present it to a canvas, so the renderer has a test-only
readback presentation path, enabled with `?present=readback`.

## Roadmap

Roughly in Photopea's order: layer groups and masks (also needed for lossless PSD round-trips of documents
that use them), adjustment layers and filters (GPU), text, custom shapes and path editing, crop/canvas size/image size, warp grids
beyond the single patch (splits, 3×3–5×5) and warp presets, snapping while transforming, more selection tools
(polygonal lasso, quick select, feather/modify), brush presets and smoothing, and GPU painting for very large
brushes.
