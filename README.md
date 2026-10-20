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
- **Layers**: add, duplicate, delete, merge down, reorder (drag), rename, visibility, opacity and 20 blend modes.
- **History**: 50-step undo/redo, plus a clickable History panel.
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
tile with its predecessor; undo history is a list of snapshots costing roughly what each step changed.
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
that use them), adjustment layers and filters (GPU), text and shapes, crop/canvas size/image size, warp grids
beyond the single patch (splits, 3×3–5×5) and warp presets, snapping while transforming, more selection tools
(polygonal lasso, quick select, feather/modify), brush presets and smoothing, clipboard, and GPU painting for
very large brushes.
