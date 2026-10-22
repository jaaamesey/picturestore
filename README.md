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
- **Image ▸ Image Size** (Alt+Ctrl+I), as Photoshop's: a live preview of the whole result fitted to the
  preview area, with a zoom (relative to the fit; drag to pan when zoomed in). It runs the real transform in a
  worker (tiles are sent there once, by identity), at no more than the area's device pixels, at most every
  200 ms. Size readout, Dimensions, Fit To presets,
  linked Width/Height in pixels, percent or physical units, Resolution (ppi or ppcm, saved in PSDs), and
  Resample (Automatic, Bicubic, Nearest Neighbor, Bilinear). Everything scales: pixel layers are resampled,
  smart objects and shapes scale exactly as vectors (smart objects re-render from their full-resolution
  contents), and with Scale Styles (on by default; proportional resizes only) stroke widths scale too. Without
  Resample only the resolution changes.
- **Image ▸ Canvas Size** (Alt+Ctrl+C): new width/height, Relative, and a 3×3 anchor.
- **Crop tool** (C), as Photoshop's: the box appears at once (the selection's bounds, else the whole canvas);
  drag inside an untouched box to draw a new one, drag handles or edges to resize (Shift keeps proportions,
  Alt from the centre, edges snap to the canvas), inside to move and outside to rotate. By default the image
  moves and turns under an upright box that re-centres itself (Auto Center Preview): the view itself rotates,
  so the preview costs nothing. Classic Mode (P) moves and turns the box instead. The options bar has the
  ratio/size menu (Ratio, W x H x Resolution, Original Ratio, Photoshop's presets, Front Image) with fields that
  take units ("4 in"), ⇄ (X) and Clear; Straighten (or hold Ctrl) levels a drawn line and shrinks the box so no
  empty corners show; overlays (Rule of Thirds, Grid, Diagonal, Triangle, Golden Ratio, Golden Spiral; O cycles,
  Shift+O flips; always/auto/never) and a grid while rotating; Show Cropped Area (H), crop shield colour and
  opacity; and Delete Cropped Pixels (unchecked, pixels outside are kept). Enter, ✓, a double-click or
  switching tools crops; Esc or Reset Crop restores the box and view. Cropping beyond the canvas extends it.
- **Perspective Crop tool** (Shift+C): click four corners (or drag a rectangle and move its corners), then
  commit to straighten the quad onto a rectangle — of its true proportions, recovered from the perspective
  (Zhang & He's rectangle estimation), unless W/H/Resolution are given. A perspective grid shows the mapping;
  folded quads are refused. **Image ▸ Crop** crops to the selection's bounds.
  Pixel tools on a smart object or shape ask to rasterize it first, with Photoshop's prompts; agreeing
  rasterizes and then carries on with the action (Fill, Clear, Cut, Paint Bucket), as Photoshop does.
- **Shapes**: Rectangle (corner radius), Ellipse, Triangle, Polygon (sides, star ratio) and Line (weight) tools
  (U / Shift+U, toolbar flyout). Shift constrains, Alt draws from the centre. Shape mode makes live shape
  layers with fill and stroke (width, inside/centre/outside); with a shape selected the options bar edits it.
  Pixels mode fills into the active layer. Shapes are drawn on the GPU from their vectors every frame
  they change — drawing, moving, transforming (warps included) and editing options are exact and live — and
  strokes keep their width under transforms.
- **Clipboard**: Cut, Copy, Copy Merged, Paste (centred on the selection or the visible canvas) and Paste in
  Place. Copies also go to the system clipboard as PNG; images pasted from other apps become new layers (or a
  new document when none is open). Layer via Copy / Cut (Ctrl+J / Ctrl+Shift+J).
- **Layers**: add, duplicate, delete, merge down, rename, visibility, opacity and 20 blend modes; right-click a
  layer (or the canvas) for a context menu. Reorder by dragging — the row lifts and follows the pointer while
  the others slide aside, the list auto-scrolls, Esc cancels — or with Layer ▸ Arrange (Ctrl+[ / Ctrl+],
  with Shift for back/front). Every reorder animates, whatever caused it (`ui/sortable.ts`: FLIP transforms
  over the real layout, so motion can't leave anything misplaced; respects reduced motion).
- **Groups** (layer folders), as in Photoshop: Ctrl+G groups the active layer (Shift+Ctrl+G ungroups), Layer ▸
  New ▸ Group, nested to any depth, collapsible, drag layers in and out (drop one on an open group's row to put
  it inside). Groups default to **Pass Through** — their layers blend straight into what's below, and the
  group's opacity and mask fade between before and after — or take any blend mode, which composites their
  contents on their own first (adjustment layers inside then only affect the group). Deleting a group asks
  "Group and Contents" or "Group Only". Moving or transforming a group moves everything in it (Warp needs a
  smart object, as in Photoshop). Ctrl+E on a group is Merge Group.
- **Clipping masks**: Alt+Ctrl+G or Alt-click a layer clips it to the layer below; on a clipped layer it
  releases it and the clipped layers above it. A clipping group (a base and the clipped layers above it) shows
  only where the base is: the clipped layers blend onto the base alone (Photoshop's default "Blend Clipped
  Layers as Group"), with their own modes, opacities and masks, and the result blends in with the base's mode
  and opacity. A hidden base hides its clipped layers; the bottom layer of a group can't be clipped; a layer
  dropped inside a clipping group joins it, one moved out leaves it. Groups and adjustment layers can be bases
  (a group's contents, or an adjustment layer's mask, is the shape). Ctrl+E on a base is Merge Clipping Mask.
  The panel indents clipped layers with ↳ and underlines bases.
- **Layer masks**: Add Layer Mask (Reveal All, or Reveal Selection with a selection; Alt for Hide All / Hide
  Selection), on any layer, group or adjustment layer. Click the mask thumbnail to target it: painting, fills,
  the paint bucket, Delete (fills with the background colour), pixel shapes, the Move tool and Free Transform
  then work on the mask, in grey (the foreground's luminosity; the eraser paints the background colour; D gives
  white on black). Masks are linked by default (the chain icon) and move and transform with their layer.
  Shift-click (or Layer Mask ▸ Disable) disables one; Apply and Delete. Image ▸ Adjustments work on a targeted
  mask too.
- **Adjustment layers**, all 16 of Photoshop's (Layer ▸ New Adjustment Layer, or the panel's ◐ button):
  Brightness/Contrast (and Use Legacy), Levels, Curves, Exposure, Vibrance, Hue/Saturation (ranges and
  Colorize), Color Balance, Black & White (and Tint), Photo Filter (Photoshop's 20 presets), Channel Mixer
  (and Monochrome), Color Lookup (.cube 3D LUTs), Invert, Posterize, Threshold, Gradient Map and Selective
  Color (relative/absolute). Each gets a mask (from the selection, if there is one), and edits in the
  **Properties** panel with Photoshop's controls: Levels' histogram and sliders, a Curves graph (click to add
  points, drag off to remove, Alt-click for a corner), per-range Hue/Saturation, and so on. They recolour
  everything below them in their group (only the base when clipped), keeping its transparency, through their
  opacity, blend mode and mask, and are rendered by the GPU compositor in WGSL. Merging one down applies it.
- **Image ▸ Adjustments**: the same 16 as destructive dialogs with live Preview (Ctrl+L Levels, Ctrl+M Curves,
  Ctrl+U Hue/Saturation, Ctrl+B Color Balance, Alt+Shift+Ctrl+B Black & White, Ctrl+I Invert), plus Desaturate
  (Shift+Ctrl+U) and Equalize; applied within the selection, on the GPU.
- **Type**, following Photoshop's manual:
  - Horizontal and Vertical Type tools and Type Mask tools (T, Shift+T cycles): click for point type, drag (or
    Alt-click for exact sizes) for paragraph type in a box; click inside the active shape layer for area type,
    on its outline for type on a path. New type starts as selected Lorem Ipsum (Preferences ▸ Type).
  - On-canvas editing through the browser's own text input (IME, dead keys, emoji, clipboard with styles):
    click/drag/double/triple-click selection, arrows (on screen, so bidi text moves as it reads), Ctrl+arrows,
    Home/End, undo within the edit, Ctrl to transform the frame, drag box handles to reflow, Esc or Ctrl+Enter
    to commit. Photoshop's formatting shortcuts (Ctrl+Shift+B/I/U/K/H, size and leading steps, Alt+arrows for
    kerning and tracking…).
  - Layout: HarfBuzz shaping (ligatures, kerning, all the Character panel's OpenType features, variable fonts),
    bidi (Arabic and Hebrew, right-to-left paragraphs), Knuth–Plass Every-line and Single-line composers,
    hyphenation in Photoshop's languages, justification with word/letter spacing and glyph scaling, indents,
    paragraph spacing, leading, hanging punctuation, faux bold/italic, caps, small caps, super/subscript,
    underline, strikethrough, baseline shift, scaling, tracking, metrics/optical/manual kerning, vertical type
    with upright and Tate-Chu-Yoko runs.
  - Character, Paragraph, Character Styles, Paragraph Styles and Glyphs panels (Window menu, or the options
    bar's panel button), with Photoshop's panel menus; the Type tools' options bar; Properties for type layers
    with a slider per variable-font axis; Justification and Hyphenation dialogs.
  - Type menu: anti-aliasing (None/Sharp/Crisp/Strong/Smooth), orientation, Convert to Shape, Rasterize Type
    Layer, Convert to Point/Paragraph Text, Warp Text (all 15 styles, live), Font Preview Size, Update All Text
    Layers, Replace All Missing Fonts, Paste Lorem Ipsum, Load/Save Default Type Styles, Add/Manage Fonts.
    Edit ▸ Find and Replace Text and Check Spelling.
  - Type stays type: it's drawn live as vector art on the GPU, so Image Size and Free Transform (scale, rotate,
    skew) keep it sharp and editable; Distort, Perspective and Warp ask to rasterize it, as Photoshop does.
  - Fonts: Source Sans 3, Source Serif 4 and Source Code Pro (variable) and Noto Sans Arabic are bundled; add
    TrueType/OpenType/WOFF files (kept in the browser's IndexedDB) or, where the browser allows, use the fonts
    installed on the device. Missing fonts show in brackets with a warning; characters a font lacks come from
    another (Missing Glyph Protection).
- **Paths**, following Photoshop's manual. The Pen group (P, Shift+P cycles): *Pen* (click for corner points, drag
  for smooth ones; Shift holds 45°, Alt while dragging breaks the direction lines; click the first point to
  close, an end of an open path to continue it, another path's end to join them; click the selected end point to
  drop its direction line, drag from it to pull one out; Auto Add/Delete; Rubber Band; Ctrl is Direct
  Selection and Alt Convert Point; Esc/Enter end the path), *Freeform Pen* (Curve Fit 0.5–10 px; drag back to the
  start to close; drag from an end to continue) with *Magnetic* (Width, Contrast, Frequency, Pen Pressure; click
  to fasten, Delete removes the last fastening point, Alt-click straight, Alt-drag freehand, `[` `]` change the
  width, Enter ends, double-click closes along the edge, Alt+double-click straight), *Curvature Pen* (click for
  a point the curve passes through, double-click for a corner and to toggle, drag to move, click a segment to add,
  Delete keeps the curve), *Add/Delete Anchor Point* and *Convert Point*. *Path Selection* and *Direct
  Selection* (A): click, Shift, marquee, drag points, segments (Shift 45°; Constrain Path Dragging) and direction
  points, Alt-click a component, Alt-drag copies components, arrows nudge 1/10 px, Delete removes points, then
  segments (twice). The options bar has Shape/Path modes, Fill and Stroke, the path operations (Combine, Subtract
  Front, Intersect, Exclude) for new and for selected components, Path Alignment, distribution, Arrangement,
  Combine (Merge Shape Components), path colour and thickness, and Make: Selection/Mask/Shape. The *Paths
  panel* lists saved paths, the work path (italic; replaced when another is drawn unless saved) and the
  active shape layer's or vector mask's path; double-click renames or saves; buttons fill, stroke, load as a
  selection, make a work path from the selection (Tolerance), add and delete, with Alt-click opening Make
  Selection (Feather Radius, Anti-aliased, operation), Fill Path, Stroke Path and Make Work Path dialogs and
  Panel Options for thumbnail size. *Vector masks* (Layer ▸ Vector Mask ▸ Reveal All / Hide All / Current Path,
  Delete, Disable, Rasterize) hide what's outside a path, are edited with the path tools and are drawn on the GPU
  and the CPU reference alike. The Type tool puts type on any selected path (open or closed) or inside a closed
  one; Ctrl-drag slides it along the path, across it flips it. Paths, the work path and vector masks are in the
  PSD (image resources and `vmsk`), and are undoable like everything else.
- **History**: undo/redo with a clickable History panel, limited by History States (default 50) and Memory Usage.
- **Panel dock**, as in Photoshop: panels in tabbed groups (Character with Paragraph…), opened and closed from the
  Window menu; drag the dock's edge to widen it and the divider between two groups to trade height between them
  (down to a minimum); click a tab to bring it to the front, double-click to minimize its group. The layout is
  remembered.
- **Preferences** (Ctrl+K, Edit ▸ Preferences), organised as Photoshop's: General (reset), File Handling (recovery
  interval), Performance (Memory Usage, History States, display quality), Units & Rulers (type units), Type and
  Guides, Grid & Slices. Kept in the browser.
- **Running out of memory** is handled rather than fatal:
  - *RAM*: open documents and their history share the Memory Usage budget; past it the oldest history states
    are freed. If an allocation fails anyway, the operation is abandoned, undo history is cleared to free memory
    and a message says so; documents are never discarded.
  - *GPU*: if the tile atlas can't grow or a GPU allocation fails, the canvas is redrawn at 1/2, 1/4… resolution
    (down to 1/16), and hidden layers keep no GPU copy. Commits are still full quality (GPU, or the CPU reference if the GPU can't). Repeated device loss
    also steps quality down.
  - A status-bar warning shows what's been given up, with "Retry full quality".
  - *Recovery*: unsaved documents are written to browser storage (OPFS) every 10 minutes by default and offered
    back on the next start, so a crashed or killed tab loses at most that long.
- **PSD**: groups (nested, pass-through, open/closed), clipping, layer masks (with their default colour and
  enabled state) and all 16 adjustment layers round-trip with Photoshop's own settings records; smart objects
  round-trip as placed layers with their embedded files (and custom warps); solid-colour shape layers
  round-trip as vector masks with fill and stroke; type layers round-trip as Photoshop type (see below).
- **View**: zoom (Ctrl +/−/0/1, Ctrl/Alt+wheel about the cursor), pan (wheel, Space-drag, Hand tool). Within a GPU
  memory budget the composite is kept at the finest resolution that fits (a whole 4K document at 100%), so zooming
  and panning only redraw; huge canvases composite what's in view at the screen's resolution.
- **Snapping, guides and grid**, following Photoshop's manual (and Photopea's behaviour for what it leaves
  open): with View ▸ Snap (Shift+Ctrl+;) on, dragged points and moving boxes are pulled, within 8 screen pixels,
  onto guides, the grid (its subdivisions), other layers' edges and centres, and the document's edges and centre
  (View ▸ Snap To ▸ Guides / Grid / Layers / Document Bounds / All / None; guides and the grid only while shown).
  Each axis snaps to its nearest target; layers only win when strictly nearest. What snaps: marquee corners,
  shape tool corners and line ends, the crop box (drawing, handles, moving, unrotated), Perspective Crop corners,
  the Move tool (the moved bounds' edges or centre; Ctrl suspends it; Shift keeps the axis), Free Transform
  (handles and the reference point where they land, and moves by the bounds) and guides being dragged.
  Smart guides (magenta) show the alignment with layers and the canvas while dragging. View ▸ Rulers (Ctrl+R):
  drag a guide out of a ruler (Alt flips it, Shift snaps to ruler ticks), move guides with the Move tool and drop
  them off the window to delete; New Guide…, Lock Guides (Alt+Ctrl+;), Clear Guides; Show ▸ Guides (Ctrl+;),
  Grid (Ctrl+'), Smart Guides; Extras (Ctrl+H) hides them all and selection edges. Guides belong to the document
  (undoable, saved in PSD, carried through Canvas/Image Size and crops); Preferences ▸ Guides, Grid & Slices sets
  colours, styles, Gridline Every (any unit) and Subdivisions.

## Where type differs from Photoshop

- **Warp Text**: Adobe doesn't publish its warp formulas; the 15 styles are designed to match their shapes and
  parameters, not pixel for pixel.
- **Fonts**: the default is Source Sans 3 (Myriad Pro's open sibling) rather than Myriad Pro. Adobe Fonts,
  Match Font and live font preview on hover aren't available. WOFF2 files can't be added (no decoder yet).
  Installed fonts need the Local Font Access API (Chromium browsers).
- **Anti-aliasing**: Windows and Windows LCD draw as Sharp.
- **Paths**: Create Work Path from type isn't available (Convert to Shape is).
- **Styles**: styles are made from formatted text and redefined by merging overrides; there's no
  attribute-by-attribute Style Options dialog.
- **Spelling**: English only (Hunspell's en-US dictionary); words in other languages are skipped.
- **World-Ready features**: East Asian composition (mojikumi, kinsoku sets, rubi, warichu) and Middle Eastern
  kashida and diacritic positioning aren't implemented; their panel controls are always shown rather than
  behind Text Engine Options.
- **PSD**: ag-psd can't write type-on-a-path data, so Photoshop sees path type as point type and area type as
  paragraph type in the shape's bounds; Photoshop's type data also lacks optical kerning, most OpenType features,
  digits and variable-font axes. Our exact type, and the named styles, are kept in the file's XMP and used while
  the layer still matches; type edited in Photoshop is read from Photoshop's data and shown with Photoshop's
  pixels until it's edited here.

## Where paths differ from Photoshop

- **Algorithms Adobe doesn't publish** are replaced by well-known ones, so results are close, not identical:
  the Freeform Pen fits curves by least squares (Schneider's algorithm); the Magnetic Pen traces edges with a
  live-wire (Dijkstra over gradient cost, within Width of the line to the pointer) and fastens a point when a
  stretch gets longer than Frequency allows (Contrast is the change in the image, as a percent of the full
  range, that counts as an edge; Pen Pressure scales Width); the Curvature Pen's automatic points have direction
  lines along the line between their neighbours, a third as long as each segment; dragging a curved segment bends it
  by moving its two direction points, the nearer more; Make Work Path traces the selection along pixel
  boundaries and fits curves within Tolerance.
- **Content-Aware Tracing** (a Technology Preview in Photoshop) isn't available.
- Closing a path by dragging, or Auto Add dragging, pulls out symmetric direction lines from the point; the
  Spacebar doesn't reposition a point being placed. The Magnetic Pen can't continue an existing path.
- **Merge Shape Components** replaces curves with their flattened outlines. Path Alignment and distribution act on
  the selected components' own bounds (not the selection or canvas).
- **Fill Path** has no blending mode or Preserve Transparency; **Stroke Path** is the Brush or Eraser at their
  current settings (no Simulate Pressure). Deleting a path asks no confirmation (it can be undone). Paths in the
  panel can't yet be reordered by dragging, and the vector mask has no density or feather.
- **PSD**: saved path names are written as UTF-8 in the resource's name field, so non-ASCII names look odd in
  Photoshop; coordinates are 8.24 fixed point, as Photoshop's, so round trips are accurate to ~1e-5 of the image size.
- A vector mask is drawn as part of the layer's mask (the path's anti-aliased area), and always follows its
  layer (there's no link toggle for it).

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
tile with its predecessor. The tiling stays inside `core/pixels.ts` (and the GPU renderer): everything else
sees a layer's `Pixels` as one image and works in regions — rectangles, row-span visitors, bounds, shifts,
clips — so no other code computes where a pixel is stored; undo history is a list of snapshots costing roughly what each step changed. Each
history entry records the bytes it newly retains (by object identity: new tiles, smart object sources), and
the oldest states are dropped past 50 steps or the memory budget. Asynchronous commits (GPU resampling) block
input until they land, and a result is discarded rather than applied if its base document changed.

**Document transforms** (`core/documentTransform.ts`): Canvas Size, Image Size, Crop and Perspective Crop
(and later Rotate/Flip Canvas) are one projective map of document space. Pixel layers are resampled (whole-pixel moves copied
exactly); non-raster content says how it follows the map in one table — placements compose the map onto
their quad, which is exact even for perspective and warps — and lengths that belong to content (stroke
widths, later effect sizes and type) scale by Scale Styles' factor.

**The layer tree** (`core/layers.ts`): a document's layers, and each group's, are stored bottom to top, with
groups nesting. Tree edits are pure functions sharing untouched branches. Clipping is a flag on the clipped
layer, so a clipping group is simply its base and the run of clipped layers above it. Layer masks are pixels
too: grey over a background value, so painting a mask is painting a layer, and the GPU draws them into a
coverage texture with the same tile pipeline.

**Compositing** (`core/composite.ts` is the reference, `gpu/renderer.ts` the GPU): the tree is walked once;
groups and clipping groups render into intermediate surfaces (one per nesting depth in use), pass-through
groups snapshot the backdrop and fade to the result, clipped layers composite source-atop, and adjustment
layers are a full-surface pass. Adjustments compile (`core/adjustments.ts`) to a few program kinds — per-channel
curves (most of them), a hue map, YUV vibrance, selective-colour tables, black & white weights, a 3×4 mixer
matrix, a 3D LUT — evaluated by one WGSL shader that mirrors the CPU code; their formulas follow Photopea's
reverse-engineering of Photoshop's. The CPU reference works in bounded bands. E2E tests compare the two on
scenes with every adjustment type, nested groups and clipping.

**Layer content** is pixels, a smart object (an embedded source plus a placement: quad, orientation, warp) or a
shape (vector geometry plus fill/stroke, also placed). A layer's `pixels` are always its rendered pixels, so the
compositor and GPU never care which kind it is; transforming a smart object or shape edits its placement and
re-renders. Shapes rasterize with the same exact-area coverage as selections, with adaptive Bézier
flattening after mapping and strokes built from edge quads with miter/bevel joins.
Selection masks store only their bounds.

**The CPU owns pixels; the GPU is a cache.** Tools edit tiles on the CPU (deterministic and testable). The
renderer composites only the **frame**: the part of the document in view (plus a slot of margin), at the
coarsest power-of-two reduction still at least as fine as the screen's pixels — as Photoshop draws from its
cache levels. So a 12000×12000 document costs about what the screen does: zoomed out it's composited at 1/8,
at 100% only what's visible. Tiles in the frame live in a shared **tile atlas** (a texture array grown on
demand) of 256² slots; at reduction 1/2^L a slot holds 2^L × 2^L tiles, box-filtered on upload (and cached),
so GPU memory scales with what's on screen rather than layers × canvas size. Each layer composites as one
instanced draw over its slots: Normal layers use fixed-function premultiplied blending in a single pass;
other blend modes read a scissored copy of the destination. The frame stays put until the view leaves it;
within it only dirty regions are recomposited and re-mipmapped. Because nothing lives
only on the GPU, a lost device is recovered by re-uploading.

**Transforms are exact projective maps plus an optional warp.** A transform is the quad the source's corners
land on (a homography, computed with Heckbert's square-to-quad), the box's orientation, a reference point and
an optional bicubic Bézier patch applied *before* the homography — so perspective stays exact even when
warped. Previews draw the floating pixels through a mesh whose vertices carry homogeneous `w`, letting the
GPU's perspective-correct interpolation reproduce the homography exactly. Commits resample on the GPU with
per-pixel LOD and Keys bicubic over a premultiplied mip chain, in bounded chunks. `core/rasterize.ts` is the CPU
reference (a perspective-correct triangle rasterizer with per-pixel mip selection) used for selection masks and
by a GPU-vs-CPU parity test.

**Shapes are rasterized on the GPU** (`gpu/vector.ts`), with the same exact-area coverage as the CPU
reference: the CPU only flattens the outline (adaptive Bézier subdivision after mapping, so perspective and
warps stay within 0.1 px) and builds stroke polygons; a compute shader deposits each segment's signed-area
contribution into a fixed-point accumulator with atomics, a two-level parallel prefix sum resolves winding
per row, and a resolve pass clips strokes against the fill and writes straight into the layer's atlas tiles,
a tile row at a time. Commits read the same rasterization back as the layer's pixels. An e2e test holds the
GPU to within 2 levels of the CPU reference, on screen and in readback.

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

Roughly in Photopea's order: filters (GPU: blurs, sharpen, noise…, and Smart Filters), fill layers, multiple
layer selection, mask density/feather, Blend If and Fill opacity, custom shapes, warp grids
beyond the single patch (splits, 3×3–5×5) and warp presets, snapping while transforming, more selection tools
(polygonal lasso, quick select, feather/modify), brush presets and smoothing, and GPU painting for very large
brushes.
