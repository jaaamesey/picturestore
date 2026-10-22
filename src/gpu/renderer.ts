import { lookup, type Program } from "../core/adjustments";
import { blendModeIndex, effectiveMode } from "../core/blend";
import { programOf } from "../core/composite";
import { placementMapping, wholePixelMove } from "../core/content";
import type { Layer, LayerContent } from "../core/document";
import { hasPixels, isClipped, isGroup, walk } from "../core/layers";
import { drawingSegments, shapeDrawing, shapeSegments, type ShapeGeometry, type ShapeStyle, type VectorDrawing } from "../core/shape";
import { createVectorRasterizer } from "./vector";
import { drawText, textVersion } from "../text/engine";
import { wholePixelTextMove, type TextContent } from "../text/model";
import { EMPTY_RECT, intersect, isEmpty, rect, roundOut, union, type Rect, type Vec2 } from "../core/geometry";
import type { Filter } from "../core/rasterize";
import type { Mask } from "../core/selection";
import { NO_PIXELS, TILE_SIZE, downsample, reducedTile, keyX, keyY, readRect, storedBounds, tileKey, tileRect, tileWriter, pixelsFromImage, tilesIn, writeRect, type Tile, type TileKey, type Pixels } from "../core/pixels";
import { tessellate, type Mapping } from "../core/warp";
import { ADJUST_KINDS, ATLAS_PAGE, ATOP, COMPOSE_WGSL, MASK_A, MASK_B, MESH_WGSL, MIP_WGSL, PREMULTIPLY_WGSL, PRESENT_WGSL, fillWgsl, tilesWgsl } from "./shaders";

/** Pixels drawn through a mapping. */
export interface FloatingPixels {
  readonly pixels: Pixels;
  /** Bounds of the pixels' content; also the mapping's source rectangle. */
  readonly bounds: Rect;
  readonly mapping: Mapping;
}

/**
 * Pixels being transformed as part of a layer (Free Transform / Move
 * preview): drawn over the layer's own pixels, so with its blend mode,
 * opacity, mask and clipping, and likewise over its mask's.
 */
export interface FloatingLayer {
  readonly layerId: string;
  readonly pixels: FloatingPixels | null;
  readonly mask: FloatingPixels | null;
  /** Layers drawn moved by whole document pixels, with their linked masks (a group being moved). */
  readonly shift?: { readonly ids: ReadonlySet<string>; readonly by: Vec2 };
}

export interface Scene {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly Layer[];
  readonly selection: Mask | null;
  readonly floating: FloatingLayer | null;
}

/** Screen = doc × zoom + pan, in CSS pixels. */
/** Screen = R(rotation) · doc × zoom + pan, in CSS pixels. */
export interface View {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
  /** Radians, clockwise on screen (the Crop tool rotates the image under its box this way). */
  readonly rotation?: number;
}

export interface Renderer {
  /** Syncs the scene to the GPU (uploading only changed tiles) and draws it. */
  render(scene: Scene, view: View, time: number): void;
  /**
   * Resamples floating pixels through a mapping on the GPU (the Free
   * Transform commit), returning straight RGBA8 covering `dest`.
   */
  resample(source: { pixels: Pixels; bounds: Rect }, mapping: Mapping, dest: Rect, filter: Filter): Promise<Uint8ClampedArray>;
  /**
   * Rasterizes a shape at full resolution on the GPU and reads it back as
   * tiles, clipped to `clip` (a committed shape layer's pixels).
   */
  rasterizeShape(geometry: ShapeGeometry, style: ShapeStyle, mapping: Mapping, clip: Rect): Promise<Pixels>;
  /** Rasterizes vector art (type) the same way. */
  rasterizeDrawing(drawing: VectorDrawing, clip: Rect): Promise<Pixels>;
  /**
   * Applies an adjustment program to pixels (Image ▸ Adjustments) within
   * the selection's coverage, on the GPU: the same shader as adjustment layers.
   */
  adjust(pixels: Pixels, program: Program, selection: Mask | null): Promise<Pixels>;
  /** Reads back the composite as straight RGBA8 (for tests and debugging). */
  readComposite(): Promise<Uint8ClampedArray>;
  /** Resolves once the most recently rendered frame is on screen. */
  settled(): Promise<void>;
  /** Current display quality reduction: the canvas is composited at 1/2^level resolution (0 = full). */
  level(): number;
  /** Tries full quality again (e.g. after closing documents). */
  resetLevel(): void;
  /** Work counters, for tests guarding the fast paths. */
  readonly stats: RenderStats;
  destroy(): void;
}

/** Work counters, for tests and profiling. */
export interface RenderStats {
  shapesRasterized: number;
  shapesMoved: number;
  /** Times the composited frame moved or changed level, and document pixels composited. */
  framesMoved: number;
  levelChanges: number;
  composited: number;
  tilesUploaded: number;
}

export interface RendererOptions {
  /**
   * Present by rendering offscreen and copying into a 2D canvas. Only for
   * headless test environments, whose GPU process can render but not present
   * WebGPU canvases.
   */
  readonly readback?: boolean;
  /** Starting quality reduction (kept across device loss). */
  readonly level?: number;
  /** Caps the tile atlas below the device's limit (to exercise memory pressure in tests). */
  readonly maxAtlasPages?: number;
  /** Called when GPU memory pressure changes the quality reduction. */
  readonly onLevelChange?: (level: number) => void;
}

type ShapeContent = Extract<LayerContent, { kind: "shape" }>;
/** Content drawn from vectors on the GPU, at the display's resolution: shapes, and type (unless it's another app's pixels). */
type VectorContent = ShapeContent | TextContent;
const isVector = (c: LayerContent): c is VectorContent => c.kind === "shape" || (c.kind === "text" && !c.stale);
const vectorMove = (prev: VectorContent, next: VectorContent, step: number) =>
  prev.kind === "shape" && next.kind === "shape" ? wholePixelMove(prev, next, step) : prev.kind === "text" && next.kind === "text" ? wholePixelTextMove(prev, next, step) : null;
const vectorSegments = (c: VectorContent, scale: number) =>
  c.kind === "shape" ? shapeSegments(c.geometry, c.style, placementMapping(c.placement), scale) : drawingSegments(drawText(c), scale);

const ZERO: Vec2 = { x: 0, y: 0 };
const translateRect = (r: Rect, d: Vec2): Rect => (d.x || d.y ? rect(r.x + d.x, r.y + d.y, r.w, r.h) : r);
const contains = (outer: Rect, inner: Rect) =>
  isEmpty(inner) || (inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h);



/**
 * GPU memory the composited frame may take, its textures and the layer
 * tiles under it together. The frame is composited at the finest level
 * within it — a 4K document whole at full resolution, so zooming and panning
 * it never re-uploads or recomposites — and only huge canvases drop to
 * coarser levels (see frameFor).
 */
const FRAME_BUDGET = 384 << 20;
/** Bytes per frame pixel: the accumulator with its mips, its scratch copy, two mask textures and the selection. */
const FRAME_BYTES_PER_PIXEL = 8 * (4 / 3) + 8 + 2 + 1;
/** Frame pixels per lazily composited cell (see `staleCells`). */
const CELL = 256;

/** The tile atlas can't grow (device limit, or out of GPU memory). */
class AtlasFull extends Error {}

/** Down to 1/16 resolution (16×16-texel tiles); past that, the display isn't useful. */
export const MAX_LEVEL = 4;

const ACCUM_FORMAT: GPUTextureFormat = "rgba16float";
const UNIFORM_SLOT = 256; // minUniformBufferOffsetAlignment
const TILE_UNIFORM_SIZE = 32; // sizeof(Draw), rounded up
const MESH_UNIFORM_SIZE = 48; // sizeof(Mesh)
const MASK_FORMAT: GPUTextureFormat = "r8unorm";
const LUT_FORMAT: GPUTextureFormat = "rgba32float";
/** The atlas key of a layer's mask tiles. */
const maskKey = (id: string) => `${id}#mask`;
const WORKSPACE = [0.16, 0.16, 0.17, 1];
/** The workspace around the canvas, for overlays that match it (the crop shield). */
export const WORKSPACE_CSS = `rgb(${WORKSPACE.slice(0, 3).map((v) => Math.round(v * 255)).join(" ")})`;
const CHUNK = 2048; // resample output is rendered and read back in chunks of at most this size
const SLOTS_PER_SIDE = ATLAS_PAGE / TILE_SIZE;
const SLOTS_PER_PAGE = SLOTS_PER_SIDE * SLOTS_PER_SIDE;
const ZEROS = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
const VIEW_UNIFORM_SIZE = 96; // sizeof(View)


export async function requestDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter is available.");
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D),
      maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers,
    },
  });
  device.addEventListener("uncapturederror", (e) => console.error("WebGPU:", (e as GPUUncapturedErrorEvent).error.message));
  return device;
}

const PREMULTIPLIED_OVER: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};
/** Source-atop: the destination keeps its alpha (Normal-mode clipped layers). */
const PREMULTIPLIED_ATOP: GPUBlendState = {
  color: { srcFactor: "dst-alpha", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "zero", dstFactor: "one" },
};
/** Destination-in by the source's alpha: multiplies the target by mask coverage. */
const DESTINATION_IN: GPUBlendState = {
  color: { srcFactor: "zero", dstFactor: "src-alpha" },
  alpha: { srcFactor: "zero", dstFactor: "src-alpha" },
};

/** An adjustment program on the GPU: its kind, parameters and lookup textures. */
interface AdjustResources {
  readonly kind: number;
  readonly params: Float32Array;
  readonly lut: GPUTexture | null;
  readonly lut3: GPUTexture | null;
}

interface LayerEntry {
  /** The atlas slots in use, keyed by slot-grid position (at level L a slot holds 2^L × 2^L tiles), with how many of `tiles` each holds. */
  readonly slots: Map<TileKey, { slot: number; count: number }>;
  /** The document tiles uploaded, as of which version. */
  readonly tiles: Map<TileKey, { tile: Tile; version: number }>;
  /** For shape layers: the content last rasterized, and what of it was rasterized (document space, within the canvas). */
  shape: VectorContent | null;
  shapeBounds: Rect;
  /** The shape's full extent when rasterized (document space, unclipped). */
  shapeExtent: Rect;
  /** Where the tiles are drawn relative to where they were rasterized: whole document pixels (a shape being moved). */
  offset: Vec2;
  instances: GPUBuffer | null;
  instanceCount: number;
  instancesDirty: boolean;
}

interface FloatingTexture {
  readonly source: Pixels;
  readonly bounds: Rect;
  readonly texture: GPUTexture;
  readonly mipCount: number;
  /** Stored at 1/2^level resolution. */
  readonly level: number;
}

interface MeshBuffers {
  readonly mapping: Mapping;
  readonly positions: GPUBuffer;
  readonly uvs: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly count: number;
}

export function createRenderer(device: GPUDevice, canvas: HTMLCanvasElement, options: RendererOptions = {}): Renderer {
  const output = options.readback ? readbackOutput(device, canvas) : canvasOutput(device, canvas);
  const module = (code: string) => device.createShaderModule({ code });

  // --- Pipelines ----------------------------------------------------------
  const tileLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });
  // Quality reduction under GPU memory pressure: the composite is never finer than 1/2^bias.
  let bias = Math.min(MAX_LEVEL, options.level ?? 0);
  const tilesModule = module(tilesWgsl(TILE_SIZE));
  const tilePipeline = (entryPoint: string, blend?: GPUBlendState, format = ACCUM_FORMAT) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [tileLayout] }),
      vertex: {
        module: tilesModule,
        entryPoint: "vs",
        buffers: [{ arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "sint32x3" }] }],
      },
      fragment: { module: tilesModule, entryPoint, targets: [{ format, blend }] },
    });
  const tile = {
    normal: tilePipeline("fs_normal", PREMULTIPLIED_OVER),
    atop: tilePipeline("fs_normal", PREMULTIPLIED_ATOP),
    mode: tilePipeline("fs_mode"),
    mask: tilePipeline("fs_mask", PREMULTIPLIED_OVER, MASK_FORMAT),
  };

  const meshLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });
  const meshModule = module(MESH_WGSL);
  const meshPipeline = (entryPoint: string, format: GPUTextureFormat, blend?: GPUBlendState) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [meshLayout] }),
      vertex: {
        module: meshModule,
        entryPoint: "vs",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },
        ],
      },
      fragment: { module: meshModule, entryPoint, targets: [{ format, blend }] },
    });
  const meshPreview = meshPipeline("fs_preview", ACCUM_FORMAT, PREMULTIPLIED_OVER);
  const meshPreviewAtop = meshPipeline("fs_preview", ACCUM_FORMAT, PREMULTIPLIED_ATOP);
  const meshPreviewMode = meshPipeline("fs_preview_mode", ACCUM_FORMAT);
  const meshMask = meshPipeline("fs_preview", MASK_FORMAT, PREMULTIPLIED_OVER);

  const composeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      ...[1, 2, 3, 4].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" as const } })),
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } },
    ],
  });
  const composeModule = module(COMPOSE_WGSL);
  const composePipeline = (entryPoint: string, blend?: GPUBlendState) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [composeLayout] }),
      vertex: { module: composeModule, entryPoint: "vs" },
      fragment: { module: composeModule, entryPoint, targets: [{ format: ACCUM_FORMAT, blend }] },
    });
  const adjustPixelsPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [composeLayout] }),
    vertex: { module: composeModule, entryPoint: "vs" },
    fragment: { module: composeModule, entryPoint: "fs_adjust_pixels", targets: [{ format: "rgba8unorm" }] },
  });
  const compose = {
    over: composePipeline("fs_layer_src", PREMULTIPLIED_OVER),
    atop: composePipeline("fs_layer_src", PREMULTIPLIED_ATOP),
    mode: composePipeline("fs_layer"),
    lerp: composePipeline("fs_lerp"),
    applyMask: composePipeline("fs_apply_mask", DESTINATION_IN),
    adjust: composePipeline("fs_adjust"),
  };
  const meshCommit = meshPipeline("fs_commit", "rgba8unorm");

  const fullscreen = (code: string, format: GPUTextureFormat) => {
    const m = module(code);
    return device.createRenderPipeline({
      layout: "auto",
      vertex: { module: m, entryPoint: "vs" },
      fragment: { module: m, entryPoint: "fs", targets: [{ format }] },
    });
  };
  const clearPipeline = fullscreen(fillWgsl(0), ACCUM_FORMAT);
  const maskFill = [fullscreen(fillWgsl(0), MASK_FORMAT), fullscreen(fillWgsl(1), MASK_FORMAT)];
  // A mask's density: v ← d·v + (1 − d), as a constant blend (the blend constant is d).
  const densityModule = module(fillWgsl(1));
  const maskDensity = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: densityModule, entryPoint: "vs" },
    fragment: {
      module: densityModule,
      entryPoint: "fs",
      targets: [{ format: MASK_FORMAT, blend: { color: { srcFactor: "one-minus-constant", dstFactor: "constant" }, alpha: { srcFactor: "one-minus-constant", dstFactor: "constant" } } }],
    },
  });
  const texture = (format: GPUTextureFormat, size: number[], dimension: GPUTextureDimension = "2d") =>
    device.createTexture({ size, format, dimension, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  // Stand-ins for bindings a draw doesn't use.
  const dummy = { color: texture(ACCUM_FORMAT, [1, 1]), mask: texture(MASK_FORMAT, [1, 1]), lut: texture(LUT_FORMAT, [1, 1]), lut3: texture(LUT_FORMAT, [1, 1, 1], "3d") };
  const premultiplyPipeline = fullscreen(PREMULTIPLY_WGSL, ACCUM_FORMAT);
  const mipPipeline = fullscreen(MIP_WGSL, ACCUM_FORMAT);
  const presentPipeline = fullscreen(PRESENT_WGSL, output.format);

  const vectors = createVectorRasterizer(device);
  const stats: RenderStats = { shapesRasterized: 0, shapesMoved: 0, framesMoved: 0, levelChanges: 0, composited: 0, tilesUploaded: 0 };
  const trilinear = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
  const viewUniforms = device.createBuffer({ size: VIEW_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let drawUniforms = device.createBuffer({ size: UNIFORM_SLOT * 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // --- Tile atlas ---------------------------------------------------------
  let pages = 1;
  let atlas = createAtlas(pages);
  const freeSlots: number[] = [];
  let nextSlot = 0;

  function createAtlas(n: number) {
    return device.createTexture({
      size: [ATLAS_PAGE, ATLAS_PAGE, n],
      format: "rgba8unorm",
      // Shapes are rasterized straight into it by a compute shader.
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING,
    });
  }

  const maxPages = Math.min(device.limits.maxTextureArrayLayers, options.maxAtlasPages ?? Infinity);

  /**
   * Out-of-memory errors are reported asynchronously; a failed allocation
   * yields an invalid object, so the next frame rebuilds at lower quality.
   */
  let oomReported = false;
  function allocating<T>(fn: () => T): T {
    device.pushErrorScope("out-of-memory");
    const result = fn();
    void device.popErrorScope().then((e) => {
      if (e) {
        console.warn("WebGPU out of memory:", e.message);
        oomReported = true;
      }
    });
    return result;
  }

  function allocSlot(): number {
    if (freeSlots.length) return freeSlots.pop()!;
    if (nextSlot >= pages * SLOTS_PER_PAGE) {
      const grown = Math.min(maxPages, pages * 2);
      if (grown === pages) throw new AtlasFull();
      // Shapes already encoded this frame write into the current atlas: run them before it's copied.
      flushShapes();
      const next = allocating(() => createAtlas(grown));
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture: atlas }, { texture: next }, [ATLAS_PAGE, ATLAS_PAGE, pages]);
      device.queue.submit([encoder.finish()]);
      atlas.destroy();
      atlas = next;
      pages = grown;
      rebuildBindGroups();
    }
    return nextSlot++;
  }

  /** Where a slot's texels start in the atlas. */
  const slotOrigin = (slot: number) => {
    const local = slot % SLOTS_PER_PAGE;
    return [(local % SLOTS_PER_SIDE) * TILE_SIZE, Math.floor(local / SLOTS_PER_SIDE) * TILE_SIZE, Math.floor(slot / SLOTS_PER_PAGE)];
  };

  /**
   * Writes document tile (tx, ty) into its part of a slot: at level L a slot
   * holds 2^L × 2^L tiles, each reduced to (256 / 2^L)² texels (null clears it).
   */
  function uploadTile(slot: number, tx: number, ty: number, tile: Tile | null) {
    const L = frame.level, n = TILE_SIZE >> L, mask = (1 << L) - 1;
    const [x, y, page] = slotOrigin(slot);
    const data = tile ? (reducedTile(tile, L) as Uint8ClampedArray<ArrayBuffer>) : ZEROS;
    stats.tilesUploaded++;
    device.queue.writeTexture({ texture: atlas, origin: [x + (tx & mask) * n, y + (ty & mask) * n, page] }, data, { bytesPerRow: n * 4, rowsPerImage: n }, [n, n, 1]);
  }

  const clearSlot = (slot: number) =>
    device.queue.writeTexture({ texture: atlas, origin: slotOrigin(slot) }, ZEROS, { bytesPerRow: TILE_SIZE * 4, rowsPerImage: TILE_SIZE }, [TILE_SIZE, TILE_SIZE, 1]);

  // --- Frame ----------------------------------------------------------------
  let size = { width: 0, height: 0 };
  /**
   * What's composited: the part of the document in view, plus a margin, at
   * 1/2^level resolution — the coarsest level still at least as fine as the
   * screen's pixels. Its origin is on the grid of atlas slots, which at level
   * L each hold 2^L × 2^L document tiles reduced to fit. `w` × `h` is its
   * size in composite pixels.
   */
  interface Frame {
    readonly x: number;
    readonly y: number;
    readonly level: number;
    readonly w: number;
    readonly h: number;
  }
  /** No frame yet: the next render places one. */
  const NO_FRAME: Frame = { x: 0, y: 0, level: -1, w: 0, h: 0 };
  let frame = NO_FRAME;
  /** The frame in document space. */
  const frameRect = (f = frame) => intersect(rect(f.x, f.y, f.w << f.level, f.h << f.level), rect(0, 0, size.width, size.height));
  /** The document tiles the frame covers: [x0, x1) × [y0, y1). */
  let frameTiles = { x0: 0, y0: 0, x1: 0, y1: 0 };
  const inFrame = (key: TileKey) => {
    const tx = keyX(key), ty = keyY(key), t = frameTiles;
    return tx >= t.x0 && tx < t.x1 && ty >= t.y0 && ty < t.y1;
  };
  /** A document-space rectangle in frame pixels (rounded outwards). */
  const toPx = (r: Rect): Rect => {
    const L = frame.level, k = (1 << L) - 1;
    const x0 = (r.x - frame.x) >> L, y0 = (r.y - frame.y) >> L;
    return intersect(rect(x0, y0, ((r.x + r.w - frame.x + k) >> L) - x0, ((r.y + r.h - frame.y + k) >> L) - y0), rect(0, 0, frame.w, frame.h));
  };

  /** Where visible pixel tiles are, per scene: what a frame's atlas share is estimated from. */
  let tileCoords: { layers: readonly Layer[]; xs: Int32Array; ys: Int32Array; owner: Int32Array } | null = null;
  function sceneTiles(scene: Scene) {
    if (tileCoords?.layers === scene.layers) return tileCoords;
    const xs: number[] = [], ys: number[] = [], owner: number[] = [];
    let n = 0;
    const add = (p: Pixels) => {
      for (const key of p.keys()) xs.push(keyX(key)), ys.push(keyY(key)), owner.push(n);
      n++;
    };
    for (const l of walk(scene.layers)) {
      if (!l.visible) continue;
      if (hasPixels(l)) add(l.pixels);
      if (l.mask?.enabled) add(l.mask.pixels);
    }
    return (tileCoords = { layers: scene.layers, xs: Int32Array.from(xs), ys: Int32Array.from(ys), owner: Int32Array.from(owner) });
  }

  /** GPU memory a frame takes: its textures, and the atlas slots its layers' tiles fill at its level (Infinity past the atlas's limit). */
  function frameCost(f: Frame, scene: Scene): number {
    const { xs, ys, owner } = sceneTiles(scene);
    const r = frameRect(f);
    const x0 = Math.floor(r.x / TILE_SIZE), y0 = Math.floor(r.y / TILE_SIZE), x1 = Math.ceil((r.x + r.w) / TILE_SIZE), y1 = Math.ceil((r.y + r.h) / TILE_SIZE);
    const L = f.level, slots = new Set<number>();
    for (let i = 0; i < xs.length; i++) if (xs[i] >= x0 && xs[i] < x1 && ys[i] >= y0 && ys[i] < y1) slots.add(owner[i] * 2 ** 32 + tileKey(xs[i] >> L, ys[i] >> L));
    if (slots.size > maxPages * SLOTS_PER_PAGE) return Infinity;
    return f.w * f.h * FRAME_BYTES_PER_PIXEL + slots.size * TILE_SIZE * TILE_SIZE * 4;
  }

  /** The visible part of the document at a view. */
  function visibleArea(view: View): Rect {
    const c = Math.cos(view.rotation ?? 0), s = Math.sin(view.rotation ?? 0);
    // Screen = R·doc·zoom + pan, so doc = Rᵀ(screen − pan) / zoom.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[0, 0], [canvas.clientWidth, 0], [0, canvas.clientHeight], [canvas.clientWidth, canvas.clientHeight]]) {
      const dx = (sx - view.panX) / view.zoom, dy = (sy - view.panY) / view.zoom;
      const x = c * dx + s * dy, y = -s * dx + c * dy;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return intersect(roundOut({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), rect(0, 0, size.width, size.height));
  }

  /** The frame over `visible` at a level: on the grid of atlas slots, a slot's worth of margin all round (so panning a little stays within it). */
  function frameAt(visible: Rect, level: number): Frame {
    const unit = TILE_SIZE << level;
    const fx = Math.max(0, (Math.floor(visible.x / unit) - 1) * unit), fy = Math.max(0, (Math.floor(visible.y / unit) - 1) * unit);
    const fx1 = Math.min(size.width, (Math.ceil((visible.x + visible.w) / unit) + 1) * unit);
    const fy1 = Math.min(size.height, (Math.ceil((visible.y + visible.h) / unit) + 1) * unit);
    const w = isEmpty(visible) ? 0 : Math.ceil((fx1 - fx) / (1 << level)), h = isEmpty(visible) ? 0 : Math.ceil((fy1 - fy) / (1 << level));
    return { x: fx, y: fy, level, w, h };
  }

  const fitsDevice = (f: Frame) => f.w <= device.limits.maxTextureDimension2D && f.h <= device.limits.maxTextureDimension2D;

  /**
   * The frame for a view: the finest level (no coarser than the screen's
   * pixels need) whose frame fits the budget. Finer than needed is better
   * than just enough: zooming then needn't change level, re-upload tiles and
   * recomposite. A frame too big for the device or the budget at the needed
   * level goes coarser still.
   */
  function frameFor(view: View, scene: Scene): { frame: Frame; visible: Rect } {
    const dpr = window.devicePixelRatio || 1;
    const visible = visibleArea(view);
    const needed = Math.min(MAX_LEVEL, Math.max(bias, Math.floor(1e-6 - Math.log2(view.zoom * dpr))));
    for (let level = bias; level < needed; level++) {
      const f = frameAt(visible, level);
      if (fitsDevice(f) && frameCost(f, scene) <= FRAME_BUDGET) return { frame: f, visible };
    }
    for (let level = needed; ; level++) {
      const f = frameAt(visible, level);
      if (fitsDevice(f) || level >= MAX_LEVEL) return { frame: f, visible };
    }
  }

  /** The whole document at the finest level memory allows (for reading the composite back). */
  const wholeFrame = (): Frame => ({ x: 0, y: 0, level: bias, w: Math.ceil(size.width / (1 << bias)), h: Math.ceil(size.height / (1 << bias)) });

  /** What the last view showed of the document (composited before anything else). */
  let visibleNow = EMPTY_RECT;

  /**
   * Moves the frame if the view has left it, needs a finer level, or it's
   * grown past the budget; returns whether it moved. A frame finer than the
   * view needs is kept, so zooming out and back in again costs nothing.
   */
  function updateFrame(view: View, scene: Scene, whole: boolean): boolean {
    const want = whole ? { frame: wholeFrame(), visible: rect(0, 0, size.width, size.height) } : frameFor(view, scene);
    const next = want.frame, f = frame;
    visibleNow = want.visible;
    const keep = !whole && f.level >= bias && f.level <= next.level && contains(frameRect(f), want.visible) && (f.level === next.level ? f.w * f.h <= 2 * next.w * next.h || frameCost(f, scene) <= FRAME_BUDGET : frameCost(f, scene) <= FRAME_BUDGET);
    if (keep) return false;
    if (next.x === f.x && next.y === f.y && next.level === f.level && next.w === f.w && next.h === f.h) return false;
    if (next.level !== f.level) {
      dropResidency();
      stats.levelChanges++;
    }
    stats.framesMoved++;
    frame = next;
    const r = frameRect();
    frameTiles = { x0: Math.floor(r.x / TILE_SIZE), y0: Math.floor(r.y / TILE_SIZE), x1: Math.ceil((r.x + r.w) / TILE_SIZE), y1: Math.ceil((r.y + r.h) / TILE_SIZE) };
    ensureCapacity(next.w, next.h);
    lastSelection = undefined;
    selectionWritten = rect(0, 0, capacity.width, capacity.height);
    staleCells = new Uint8Array(Math.ceil(next.w / CELL) * Math.ceil(next.h / CELL)).fill(1);
    return true;
  }

  /**
   * Cells of the frame whose composite is out of date. Only those near the
   * view are composited each frame; the rest wait until they're scrolled
   * into it, so a change to the whole document costs what's on screen.
   */
  let staleCells = new Uint8Array(0);
  const cellsAcross = () => Math.ceil(frame.w / CELL);

  /** Marks a document-space area as needing compositing. */
  function markStale(r: Rect) {
    const px = toPx(r);
    if (isEmpty(px)) return;
    const n = cellsAcross();
    for (let cy = Math.floor(px.y / CELL); cy < Math.ceil((px.y + px.h) / CELL); cy++)
      for (let cx = Math.floor(px.x / CELL); cx < Math.ceil((px.x + px.w) / CELL); cx++) staleCells[cy * n + cx] = 1;
  }

  /** The stale cells over a document-space area, cleared, as one document-space rectangle (empty if none). */
  function takeStale(r: Rect): Rect {
    const px = toPx(r);
    if (isEmpty(px)) return EMPTY_RECT;
    const n = cellsAcross();
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const cx0 = Math.floor(px.x / CELL), cy0 = Math.floor(px.y / CELL), cx1 = Math.ceil((px.x + px.w) / CELL), cy1 = Math.ceil((px.y + px.h) / CELL);
    for (let cy = cy0; cy < cy1; cy++)
      for (let cx = cx0; cx < cx1; cx++)
        if (staleCells[cy * n + cx]) {
          x0 = Math.min(x0, cx);
          y0 = Math.min(y0, cy);
          x1 = Math.max(x1, cx);
          y1 = Math.max(y1, cy);
        }
    if (x1 < 0) return EMPTY_RECT;
    for (let cy = y0; cy <= y1; cy++) staleCells.fill(0, cy * n + x0, cy * n + x1 + 1);
    const L = frame.level, unit = CELL << L;
    return intersect(rect(frame.x + x0 * unit, frame.y + y0 * unit, (x1 - x0 + 1) * unit, (y1 - y0 + 1) * unit), frameRect());
  }

  // --- Frame textures ------------------------------------------------------------
  /** Their size: grown to fit the largest frame so far, never shrunk (except under memory pressure). */
  let capacity = { width: 0, height: 0 };
  let accum: GPUTexture | null = null;
  let scratch: GPUTexture | null = null;
  /** Layer mask coverage at composite resolution: a layer's own (A) and its clipping base's (B). */
  let masks: [GPUTexture, GPUTexture] | null = null;
  /** Intermediate surfaces for groups and clipping groups, one per nesting depth in use (allocated as needed). */
  const surfaces: GPUTexture[] = [];
  /** The selection over the frame, at its resolution. */
  let selectionTexture: GPUTexture | null = null;
  /** The part of the selection texture last written (frame pixels). */
  let selectionWritten = EMPTY_RECT;
  let mipCount = 1;
  let mipsDirty = EMPTY_RECT;
  let tileBindGroup: GPUBindGroup | null = null;
  /** For drawing mask tiles: the mask textures themselves are render targets then. */
  let maskTileBindGroup: GPUBindGroup | null = null;
  let presentBindGroup: GPUBindGroup | null = null;
  const layers = new Map<string, LayerEntry>();
  /** Floating pixels' textures and meshes, cached by identity: a layer's, and its mask's. */
  interface Float {
    texture: FloatingTexture | null;
    mesh: MeshBuffers | null;
    bindGroup: GPUBindGroup | null;
  }
  const floats: Record<"pixels" | "mask", Float> = {
    pixels: { texture: null, mesh: null, bindGroup: null },
    mask: { texture: null, mesh: null, bindGroup: null },
  };
  let lastFloating: FloatingLayer | null = null;
  let lastSelection: Mask | null | undefined = undefined;

  function rebuildBindGroups() {
    if (!accum) return;
    const tiles = (a: GPUTexture, b: GPUTexture) =>
      device.createBindGroup({
        layout: tileLayout,
        entries: [
          { binding: 0, resource: { buffer: drawUniforms, size: TILE_UNIFORM_SIZE } },
          { binding: 1, resource: atlas.createView({ dimension: "2d-array" }) },
          { binding: 2, resource: scratch!.createView() },
          { binding: 3, resource: a.createView() },
          { binding: 4, resource: b.createView() },
        ],
      });
    tileBindGroup = tiles(...masks!);
    maskTileBindGroup = tiles(dummy.mask, dummy.mask);
    for (const [k, f] of Object.entries(floats)) f.bindGroup = f.texture && floatBindGroup(k === "mask", f.texture.texture);
  }

  /** A floating texture's bind group; a mask's has no mask textures bound, as it draws into one. */
  const floatBindGroup = (mask: boolean, texture: GPUTexture) => meshBindGroup(texture, drawUniforms, mask);

  const meshBindGroup = (texture: GPUTexture, uniforms: GPUBuffer, forMask = false) =>
    device.createBindGroup({
      layout: meshLayout,
      entries: [
        { binding: 0, resource: { buffer: uniforms, size: MESH_UNIFORM_SIZE } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: trilinear },
        { binding: 3, resource: scratch!.createView() },
        { binding: 4, resource: (forMask ? dummy.mask : masks![0]).createView() },
        { binding: 5, resource: (forMask ? dummy.mask : masks![1]).createView() },
      ],
    });

  function releaseSlots(entry: LayerEntry) {
    for (const { slot } of entry.slots.values()) freeSlots.push(slot);
    if (entry.slots.size) entry.instancesDirty = true;
    entry.slots.clear();
    entry.tiles.clear();
    entry.instanceCount = 0;
    entry.shape = null;
    entry.shapeBounds = EMPTY_RECT;
    entry.shapeExtent = EMPTY_RECT;
    entry.offset = ZERO;
  }

  function freeLayer(entry: LayerEntry) {
    releaseSlots(entry);
    entry.instances?.destroy();
  }

  function resetDocument(width: number, height: number) {
    for (const entry of layers.values()) freeLayer(entry);
    layers.clear();
    size = { width, height };
    frame = NO_FRAME;
    lastStructure = "";
    lastFloating = null;
    lastSelection = undefined;
  }

  function destroyFrameTextures() {
    accum?.destroy();
    scratch?.destroy();
    selectionTexture?.destroy();
    masks?.forEach((t) => t.destroy());
    for (const t of surfaces.splice(0)) t.destroy();
    accum = scratch = selectionTexture = masks = null;
  }

  function ensureCapacity(w: number, h: number) {
    if (accum && w <= capacity.width && h <= capacity.height) return;
    const max = device.limits.maxTextureDimension2D;
    const fit = (n: number, had: number) => Math.min(max, Math.max(had, Math.ceil(Math.max(1, n) / TILE_SIZE) * TILE_SIZE));
    capacity = { width: fit(w, capacity.width), height: fit(h, capacity.height) };
    destroyFrameTextures();
    mipCount = Math.floor(Math.log2(Math.max(capacity.width, capacity.height))) + 1;
    allocating(createFrameTextures);
    rebuildBindGroups();
  }

  function createFrameTextures() {
    const { width, height } = capacity;
    accum = device.createTexture({
      size: [width, height],
      format: ACCUM_FORMAT,
      mipLevelCount: mipCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    scratch = device.createTexture({
      size: [width, height],
      format: ACCUM_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const mask = () =>
      device.createTexture({ size: [width, height], format: MASK_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    masks = [mask(), mask()];
    selectionTexture = device.createTexture({
      size: [width, height],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    presentBindGroup = device.createBindGroup({
      layout: presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: viewUniforms } },
        { binding: 1, resource: accum.createView() },
        { binding: 2, resource: trilinear },
        { binding: 3, resource: selectionTexture.createView() },
      ],
    });
  }

  /** Drops every layer's atlas contents, to be uploaded again at the frame's new level. */
  function dropResidency() {
    flushShapes();
    for (const entry of layers.values()) releaseSlots(entry);
    freeSlots.length = 0;
    nextSlot = 0;
    for (const f of Object.values(floats)) {
      f.texture?.texture.destroy();
      f.texture = null;
    }
    lastFloating = null;
  }

  /** Switches the quality reduction, releasing every GPU copy so it's rebuilt at the new scale. */
  function setBias(next: number) {
    bias = next;
    dropResidency();
    atlas.destroy();
    pages = 1;
    atlas = createAtlas(pages);
    destroyFrameTextures();
    capacity = { width: 0, height: 0 };
    frame = NO_FRAME;
    options.onLevelChange?.(bias);
  }

  /** Rebuilds the GPU state at the next lower quality. */
  function degrade(): boolean {
    const at = Math.max(bias, frame.level);
    if (at >= MAX_LEVEL) return false;
    console.warn(`GPU memory is constrained; drawing at 1/${2 << at} resolution.`);
    setBias(at + 1);
    return true;
  }

  // --- Scene sync ----------------------------------------------------------

  /** Uploads changed on-canvas tiles of one layer; returns the area that changed. */
  /** Shape rasterization encoded this frame, submitted together (and before the atlas is ever replaced). */
  let shapeWork: { encoder: GPUCommandEncoder; releases: (() => void)[] } | null = null;
  function flushShapes() {
    if (!shapeWork) return;
    const w = shapeWork;
    shapeWork = null;
    device.queue.submit([w.encoder.finish()]);
    for (const release of w.releases) release();
  }

  /** Uploads what changed of a layer's tiles within the frame, and drops those that left it; returns the area that changed. */
  function syncLayer(entry: LayerEntry, tiles: Pixels): Rect {
    // Was a shape (since rasterized): its GPU-rendered slots are replaced by uploads.
    let dirty = EMPTY_RECT;
    if (entry.shape) {
      dirty = translateRect(entry.shapeBounds, entry.offset);
      releaseSlots(entry);
    }
    const L = frame.level;
    for (const [key, tile] of tiles) {
      if (!inFrame(key)) continue;
      const prev = entry.tiles.get(key);
      if (prev && prev.tile === tile && prev.version === tile.version) continue;
      const tx = keyX(key), ty = keyY(key), at = tileKey(tx >> L, ty >> L);
      let s = entry.slots.get(at);
      if (!s) {
        s = { slot: allocSlot(), count: 0 };
        if (L > 0) clearSlot(s.slot);
        entry.slots.set(at, s);
        entry.instancesDirty = true;
      }
      if (!prev) s.count++;
      uploadTile(s.slot, tx, ty, tile);
      entry.tiles.set(key, { tile, version: tile.version });
      dirty = union(dirty, tileRect(tx, ty));
    }
    for (const key of entry.tiles.keys()) {
      if (tiles.has(key) && inFrame(key)) continue;
      entry.tiles.delete(key);
      const tx = keyX(key), ty = keyY(key), at = tileKey(tx >> L, ty >> L);
      const s = entry.slots.get(at)!;
      if (--s.count === 0) {
        entry.slots.delete(at);
        freeSlots.push(s.slot);
        entry.instancesDirty = true;
      } else uploadTile(s.slot, tx, ty, null);
      dirty = union(dirty, tileRect(tx, ty));
    }
    writeInstances(entry);
    return dirty;
  }

  function writeInstances(entry: LayerEntry) {
    if (entry.instancesDirty) {
      entry.instancesDirty = false;
      entry.instanceCount = entry.slots.size;
      const data = new Int32Array(Math.max(1, entry.slots.size) * 3);
      let i = 0;
      for (const [key, { slot }] of entry.slots) data.set([keyX(key), keyY(key), slot], (i++) * 3);
      if (!entry.instances || entry.instances.size < data.byteLength) {
        entry.instances?.destroy();
        entry.instances = device.createBuffer({ size: Math.max(48, data.byteLength * 2), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      device.queue.writeBuffer(entry.instances, 0, data);
    }
  }

  /**
   * Rasterizes a shape layer on the GPU, straight into its atlas slots, at
   * the frame's resolution and within it. Only when its content changes, or
   * the frame no longer holds what's rasterized; CPU tiles of shape layers
   * are never uploaded.
   */
  function syncShape(entry: LayerEntry, content: VectorContent): Rect {
    const L = frame.level;
    const area = frameRect();
    // Was pixels: start afresh.
    let drawn = translateRect(entry.shapeBounds, entry.offset);
    if (entry.tiles.size) {
      releaseSlots(entry);
      drawn = area;
    }
    // Moved by whole pixels, with nothing not yet rasterized coming into the frame: draw what's
    // already rasterized, offset, instead of rasterizing again.
    const d = entry.shape && vectorMove(entry.shape, content, 1 << L);
    if (d && entry.shape) {
      const visible = intersect(translateRect(entry.shapeExtent, d), area);
      if (contains(translateRect(entry.shapeBounds, d), visible)) {
        if (d.x === entry.offset.x && d.y === entry.offset.y) return EMPTY_RECT;
        entry.offset = d;
        stats.shapesMoved++;
        return union(drawn, translateRect(entry.shapeBounds, d));
      }
    }
    entry.offset = ZERO;
    stats.shapesRasterized++;
    const seg = vectorSegments(content, 1 / (1 << L));
    const extent = roundOut(seg.bounds);
    const bounds = intersect(extent, area);
    entry.shapeExtent = extent;
    const dirty = union(drawn, bounds);
    const keep = new Set<TileKey>();
    for (const [tx, ty] of tilesIn(bounds)) keep.add(tileKey(tx >> L, ty >> L));
    for (const [key, { slot }] of entry.slots) {
      if (keep.has(key)) continue;
      entry.slots.delete(key);
      freeSlots.push(slot);
      entry.instancesDirty = true;
    }
    entry.shape = content;
    entry.shapeBounds = bounds;
    if (!isEmpty(bounds)) {
      // Slot (sx, sy) is the 256² block of level-L pixels at (256·sx, 256·sy).
      const unit = TILE_SIZE << L;
      const sx0 = Math.floor(bounds.x / unit), sy0 = Math.floor(bounds.y / unit);
      const cols = Math.floor((bounds.x + bounds.w - 1) / unit) - sx0 + 1;
      const rows = Math.floor((bounds.y + bounds.h - 1) / unit) - sy0 + 1;
      const slots = new Int32Array(cols * rows);
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const key = tileKey(sx0 + i, sy0 + j);
          let s = entry.slots.get(key);
          if (!s) {
            s = { slot: allocSlot(), count: 0 };
            entry.slots.set(key, s);
            entry.instancesDirty = true;
          }
          slots[j * cols + i] = s.slot;
        }
      const region = rect(sx0 * TILE_SIZE, sy0 * TILE_SIZE, cols * TILE_SIZE, rows * TILE_SIZE);
      const clip = rect(0, 0, Math.ceil(size.width / (1 << L)), Math.ceil(size.height / (1 << L)));
      const view = atlas.createView({ dimension: "2d-array" });
      shapeWork ??= { encoder: device.createCommandEncoder(), releases: [] };
      shapeWork.releases.push(
        vectors.encode(shapeWork.encoder, seg, region, clip, TILE_SIZE, { kind: "atlas", view, slotSize: TILE_SIZE, slotsPerSide: SLOTS_PER_SIDE, slots }),
      );
    }
    writeInstances(entry);
    return dirty;
  }

  const entryFor = (key: string): LayerEntry => {
    let entry = layers.get(key);
    if (!entry) {
      entry = { slots: new Map(), tiles: new Map(), instances: null, instanceCount: 0, instancesDirty: true, shape: null, shapeBounds: EMPTY_RECT, shapeExtent: EMPTY_RECT, offset: ZERO };
      layers.set(key, entry);
    }
    return entry;
  };

  /** Everything about the layer tree that changes the composite beyond its pixels (any change redraws it all). */
  let lastStructure = "";
  const adjustmentIds = new WeakMap<object, number>();
  let nextAdjustmentId = 0;
  const structureOf = (ls: readonly Layer[]): string =>
    ls
      .map((l) => {
        const m = l.mask;
        const c = l.content;
        let s = `${l.id}|${l.visible}|${l.opacity}|${l.blendMode}|${l.clipped}|${m ? `${m.enabled}${m.background}${m.density ?? 1}` : ""}`;
        if (c.kind === "adjustment") {
          let n = adjustmentIds.get(c.adjustment);
          if (n === undefined) adjustmentIds.set(c.adjustment, (n = nextAdjustmentId++));
          s += `|a${n}`;
        }
        return c.kind === "group" ? `${s}[${structureOf(c.layers)}]` : s;
      })
      .join(",");

  /** Uploads what changed of every layer's pixels and mask; returns the area that changed. */
  let textSeen = textVersion();
  function syncLayers(scene: Scene): Rect {
    const full = rect(0, 0, size.width, size.height);
    let dirty = EMPTY_RECT;
    // Fonts changed: type is laid out afresh, so it's rasterized again.
    if (textSeen !== textVersion()) {
      textSeen = textVersion();
      for (const entry of layers.values()) if (entry.shape?.kind === "text") entry.shape = null;
      dirty = full;
    }
    const seen = new Set<string>();
    const programs = new Set<Program>();
    for (const layer of walk(scene.layers)) {
      if (hasPixels(layer)) {
        seen.add(layer.id);
        const entry = entryFor(layer.id);
        // Hidden layers keep no GPU copy; showing one uploads it again.
        if (!layer.visible) releaseSlots(entry);
        else dirty = union(dirty, isVector(layer.content) ? syncShape(entry, layer.content) : syncLayer(entry, layer.pixels));
      }
      if (layer.mask) {
        const key = maskKey(layer.id);
        seen.add(key);
        const entry = entryFor(key);
        if (!layer.visible || !layer.mask.enabled) releaseSlots(entry);
        else dirty = union(dirty, syncLayer(entry, layer.mask.pixels));
      }
      if (layer.content.kind === "adjustment") programs.add(programOf(layer));
    }
    for (const [id, entry] of layers) {
      if (seen.has(id)) continue;
      freeLayer(entry);
      layers.delete(id);
      dirty = full;
    }
    for (const [p, r] of adjustments) {
      if (programs.has(p)) continue;
      r.lut?.destroy();
      r.lut3?.destroy();
      adjustments.delete(p);
    }
    flushShapes();
    const structure = structureOf(scene.layers);
    if (structure !== lastStructure) {
      lastStructure = structure;
      dirty = full;
    }
    return dirty;
  }

  const adjustments = new Map<Program, AdjustResources>();

  /** An adjustment program's GPU form, cached while adjustment layers use it. */
  function adjustResources(p: Program): AdjustResources {
    let r = adjustments.get(p);
    if (!r) adjustments.set(p, (r = buildAdjust(p)));
    return r;
  }

  /** An adjustment program's GPU form: parameters, and curves or a 3D LUT as textures. */
  function buildAdjust(p: Program): AdjustResources {
    const kind = ADJUST_KINDS.indexOf(p.kind);
    let params: number[] = [];
    let lut: GPUTexture | null = null, lut3: GPUTexture | null = null;
    const lutTexture = (rgba: Float32Array, n: number) => {
      const t = texture(LUT_FORMAT, [n, 1]);
      device.queue.writeTexture({ texture: t }, rgba as Float32Array<ArrayBuffer>, { bytesPerRow: n * 16 }, [n, 1]);
      return t;
    };
    switch (p.kind) {
      case "curves": {
        const n = Math.max(p.r.length, p.g.length, p.b.length);
        const at = (c: Float32Array, i: number) => (c.length === n ? c[i] : lookup(c, i / (n - 1)));
        const rgba = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) rgba.set([at(p.r, i), at(p.g, i), at(p.b, i)], i * 4);
        lut = lutTexture(rgba, n);
        params = [+p.luma, +p.preserveLuminosity, n];
        break;
      }
      case "hue-saturation":
        lut = lutTexture(p.map, p.map.length / 4);
        params = [p.lift, p.keep, +p.colorize, p.map.length / 4];
        break;
      case "vibrance":
        params = [p.luma, p.chroma];
        break;
      case "selective-color":
        params = [...p.table];
        break;
      case "black-white":
        params = [...p.weights, +p.tint, p.hue, p.hueLuma, p.chroma, p.low, p.high];
        break;
      case "channel-mixer":
        params = [...p.matrix];
        break;
      case "lut3d": {
        const n = p.size;
        const rgba = new Float32Array(n * n * n * 4);
        for (let i = 0; i < n * n * n; i++) rgba.set(p.data.subarray(i * 3, i * 3 + 3), i * 4);
        lut3 = texture(LUT_FORMAT, [n, n, n], "3d");
        device.queue.writeTexture({ texture: lut3 }, rgba, { bytesPerRow: n * 16, rowsPerImage: n }, [n, n, n]);
        params = [n];
        break;
      }
    }
    return { kind, params: Float32Array.from(params), lut, lut3 };
  }

  /** The preview's premultiplied, mipmapped texture of floating pixels, at the display's quality (cached by tile-map identity). */
  function floatingTexture(slot: "pixels" | "mask", source: Pixels, bounds: Rect): FloatingTexture {
    const f = floats[slot];
    // Keyed by what was uploaded: the same tiles over a different region (a preview window, then the whole layer) are a different texture.
    // At the frame's level, or coarser if that won't fit in a texture (a preview of something huge, close up).
    let level = frame.level;
    while (Math.max(bounds.w, bounds.h) > device.limits.maxTextureDimension2D << level) level++;
    const t = f.texture;
    if (t && t.source === source && t.level === level && t.bounds.x === bounds.x && t.bounds.y === bounds.y && t.bounds.w === bounds.w && t.bounds.h === bounds.h) return t;
    t?.texture.destroy();
    f.texture = null;
    const built = allocating(() => buildFloating(source, bounds, level));
    f.texture = built;
    f.bindGroup = accum ? floatBindGroup(slot === "mask", built.texture) : null;
    return built;
  }

  /**
   * Uploads floating pixels at 1/2^lvl resolution and builds the mip chain.
   * Reduced levels are filtered on the CPU a strip at a time, so no
   * full-size intermediate is ever allocated.
   */
  function buildFloating(source: Pixels, bounds: Rect, lvl: number): FloatingTexture {
    const w = Math.ceil(bounds.w / (1 << lvl)), h = Math.ceil(bounds.h / (1 << lvl));
    const max = device.limits.maxTextureDimension2D;
    if (w > max || h > max) throw new Error(`Transforms are limited to ${max << lvl}px per side`);
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    const texture = device.createTexture({
      size: [w, h],
      format: ACCUM_FORMAT,
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const staging = device.createTexture({
      size: [w, h],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    if (lvl === 0) {
      for (const [key, tile] of source) {
        const r = tileRect(keyX(key), keyY(key));
        const part = intersect(r, bounds);
        if (isEmpty(part)) continue;
        device.queue.writeTexture(
          { texture: staging, origin: [part.x - bounds.x, part.y - bounds.y] },
          tile.data as Uint8ClampedArray<ArrayBuffer>,
          { offset: ((part.y - r.y) * TILE_SIZE + (part.x - r.x)) * 4, bytesPerRow: TILE_SIZE * 4, rowsPerImage: TILE_SIZE },
          [part.w, part.h],
        );
      }
    } else {
      const strip = 64 << lvl;
      for (let y = 0; y < bounds.h; y += strip) {
        const sh = Math.min(strip, bounds.h - y);
        const reduced = downsample(readRect(source, rect(bounds.x, bounds.y + y, bounds.w, sh)), bounds.w, sh, lvl);
        device.queue.writeTexture({ texture: staging, origin: [0, y >> lvl] }, reduced, { bytesPerRow: w * 4 }, [w, Math.ceil(sh / (1 << lvl))]);
      }
    }
    const encoder = device.createCommandEncoder();
    fullscreenPass(encoder, premultiplyPipeline, texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }), [staging.createView()]);
    for (let m = 1; m < levels; m++) {
      fullscreenPass(encoder, mipPipeline, texture.createView({ baseMipLevel: m, mipLevelCount: 1 }), [
        texture.createView({ baseMipLevel: m - 1, mipLevelCount: 1 }),
      ]);
    }
    device.queue.submit([encoder.finish()]);
    staging.destroy();
    return { source, bounds, texture, mipCount: levels, level: lvl };
  }

  function fullscreenPass(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, target: GPUTextureView, inputs: GPUTextureView[], scissor?: Rect) {
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: scissor ? "load" : "clear", storeOp: "store" }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: inputs.map((resource, binding) => ({ binding, resource })),
    }));
    if (scissor) pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
    pass.draw(3);
    pass.end();
  }

  function createMesh(mapping: Mapping): MeshBuffers {
    const m = tessellate(mapping);
    const buffer = (data: Float32Array | Uint32Array, usage: number) => {
      const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      return b;
    };
    return {
      mapping,
      positions: buffer(m.positions, GPUBufferUsage.VERTEX),
      uvs: buffer(m.uvs, GPUBufferUsage.VERTEX),
      indices: buffer(m.indices, GPUBufferUsage.INDEX),
      count: m.indices.length,
    };
  }

  const destroyMesh = (m: MeshBuffers | null) => {
    m?.positions.destroy();
    m?.uvs.destroy();
    m?.indices.destroy();
  };

  function syncFloating(f: FloatingLayer | null): Rect {
    if (f === lastFloating) return EMPTY_RECT;
    lastFloating = f;
    for (const slot of ["pixels", "mask"] as const) {
      const p = f?.[slot];
      if (!p || isEmpty(p.bounds)) continue;
      floatingTexture(slot, p.pixels, p.bounds);
      const fl = floats[slot];
      if (fl.mesh?.mapping !== p.mapping) {
        destroyMesh(fl.mesh);
        fl.mesh = createMesh(p.mapping);
      }
    }
    return rect(0, 0, size.width, size.height);
  }

  /** Writes the selection over the frame, at its resolution (point-sampled when reduced). */
  function syncSelection(sel: Mask | null) {
    if (sel === lastSelection) return;
    lastSelection = sel;
    const clear = selectionWritten;
    if (!isEmpty(clear)) device.queue.writeTexture({ texture: selectionTexture!, origin: [clear.x, clear.y] }, new Uint8Array(clear.w * clear.h), { bytesPerRow: clear.w }, [clear.w, clear.h]);
    selectionWritten = EMPTY_RECT;
    if (!sel) return;
    const r = toPx(sel.bounds);
    if (isEmpty(r)) return;
    const b = sel.bounds, L = frame.level, k = 1 << L, half = k >> 1;
    const data = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      const sy = frame.y + (r.y + y) * k + half - b.y;
      if (sy < 0 || sy >= b.h) continue;
      const row = sy * b.w, x0 = frame.x + r.x * k + half - b.x;
      if (L === 0) {
        data.set(sel.data.subarray(row + Math.max(0, x0), row + Math.min(b.w, x0 + r.w)), Math.max(0, -x0) + y * r.w);
        continue;
      }
      for (let x = 0, sx = x0; x < r.w; x++, sx += k) if (sx >= 0 && sx < b.w) data[y * r.w + x] = sel.data[row + sx];
    }
    device.queue.writeTexture({ texture: selectionTexture!, origin: [r.x, r.y] }, data, { bytesPerRow: r.w }, [r.w, r.h]);
    selectionWritten = r;
  }

  // --- Compositing -----------------------------------------------------------

  function writeMeshUniform(target: ArrayBuffer, offset: number, viewport: Rect, f: FloatingTexture, opacity: number, mode: number, filter: number, flags = 0) {
    new Float32Array(target, offset, 7).set([viewport.x, viewport.y, viewport.w, viewport.h, f.bounds.w, f.bounds.h, opacity]);
    new Uint32Array(target, offset + 28, 2).set([mode, filter]);
    new Float32Array(target, offset + 36, 1)[0] = f.mipCount - 1;
    new Uint32Array(target, offset + 40, 1)[0] = flags;
  }

  /** One GPU step of a composite, in order. Draws into `target` (a surface, or the composite's level 0). */
  type Op =
    | { kind: "fill"; target: GPUTexture; pipeline: GPURenderPipeline; constant?: number }
    | { kind: "copy"; from: GPUTexture; to: GPUTexture }
    | { kind: "tiles"; target: GPUTexture; pipeline: GPURenderPipeline; bindGroup: GPUBindGroup; entry: LayerEntry; slot: number }
    | { kind: "mesh"; target: GPUTexture; pipeline: GPURenderPipeline; slot: number; float: Float }
    | { kind: "step"; target: GPUTexture; pipeline: GPURenderPipeline; slot: number; src: GPUTexture; lut: GPUTexture | null; lut3: GPUTexture | null };

  const surface = (depth: number): GPUTexture =>
    (surfaces[depth] ??= allocating(() =>
      device.createTexture({
        size: [capacity.width, capacity.height],
        format: ACCUM_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      }),
    ));

  /**
   * Composites the layer tree over `area`, as `core/composite.ts` does on
   * the CPU (see there for the rules): planned as a list of GPU steps, then
   * encoded. Groups and clipping groups render into intermediate surfaces;
   * layer masks are drawn into coverage textures just before the draw that
   * uses them; blend modes other than Normal read a copy of the target.
   */
  function composite(scene: Scene, area: Rect) {
    const ops: Op[] = [];
    const uniforms: ((data: ArrayBuffer, at: number) => void)[] = [];
    const slot = (write: (data: ArrayBuffer, at: number) => void) => uniforms.push(write) - 1;
    const f = scene.floating;
    /** The floating layer or mask pixels drawn as part of layer `id`, if any. */
    const floatOf = (id: string, which: "pixels" | "mask") => {
      const p = f?.layerId === id ? f[which] : null;
      const fl = floats[which];
      return p && !isEmpty(p.bounds) && fl.texture && fl.mesh && fl.bindGroup ? fl : null;
    };
    const L = frame.level;
    // The targets in document space: the frame's origin, at its scale, over the textures' whole extent.
    const viewport = rect(frame.x, frame.y, capacity.width << L, capacity.height << L);
    const meshOp = (target: GPUTexture, pipeline: GPURenderPipeline, fl: Float, opacity: number, mode: number, flags: number) =>
      ops.push({ kind: "mesh", target, pipeline, float: fl, slot: slot((data, at) => writeMeshUniform(data, at, viewport, fl.texture!, opacity, mode, 0, flags)) });
    const [maskA, maskB] = masks!;
    let depth = 0;

    const shiftOf = (id: string) => (f?.shift?.ids.has(id) ? f.shift.by : ZERO);
    const tileSlot = (entry: LayerEntry, opacity: number, mode: number, flags: number, shift = ZERO) =>
      slot((data, at) => {
        new Float32Array(data, at, 1)[0] = opacity;
        new Uint32Array(data, at + 4, 1)[0] = mode;
        new Float32Array(data, at + 8, 2).set([capacity.width, capacity.height]);
        new Int32Array(data, at + 16, 2).set([((entry.offset.x + shift.x) >> L) - (frame.x >> L), ((entry.offset.y + shift.y) >> L) - (frame.y >> L)]);
        new Uint32Array(data, at + 24, 1)[0] = flags;
      });
    const stepSlot = (opacity: number, mode: number, flags: number, kind = 0, params?: Float32Array) =>
      slot((data, at) => {
        new Float32Array(data, at, 1)[0] = opacity;
        new Uint32Array(data, at + 4, 3).set([mode, flags, kind]);
        if (params) new Float32Array(data, at + 16, params.length).set(params);
      });
    const step = (target: GPUTexture, pipeline: GPURenderPipeline, slotIndex: number, src = dummy.color, r?: AdjustResources) =>
      ops.push({ kind: "step", target, pipeline, slot: slotIndex, src, lut: r?.lut ?? null, lut3: r?.lut3 ?? null });
    const copyToScratch = (target: GPUTexture) => ops.push({ kind: "copy", from: target, to: scratch! });

    /** Draws a layer's mask into coverage texture A (its own) or B (its clipping base's). */
    function drawMask(l: Layer, which: 0 | 1) {
      const target = which ? maskB : maskA;
      ops.push({ kind: "fill", target, pipeline: maskFill[l.mask!.background ? 1 : 0] });
      const entry = layers.get(maskKey(l.id));
      const shift = l.mask!.linked ? shiftOf(l.id) : ZERO;
      if (entry?.instanceCount) ops.push({ kind: "tiles", target, pipeline: tile.mask, bindGroup: maskTileBindGroup!, entry, slot: tileSlot(entry, 1, 0, 0, shift) });
      const fl = floatOf(l.id, "mask");
      if (fl) meshOp(target, meshMask, fl, 1, 0, 0);
      const density = l.mask!.density ?? 1;
      if (density < 1) ops.push({ kind: "fill", target, pipeline: maskDensity, constant: density });
    }

    function stack(ls: readonly Layer[], target: GPUTexture) {
      for (let i = 0; i < ls.length; i++) {
        if (isClipped(ls, i)) continue;
        let j = i + 1;
        while (j < ls.length && ls[j].clipped) j++;
        const base = ls[i];
        if (!base.visible) continue;
        const clipped = ls.slice(i + 1, j).filter((l) => l.visible);
        if (clipped.length) clipGroup(base, clipped, target);
        else layer(base, target);
      }
    }

    function clipGroup(base: Layer, clipped: readonly Layer[], target: GPUTexture) {
      const masked = !!base.mask?.enabled;
      if (base.content.kind === "adjustment") {
        layer(base, target);
        for (const c of clipped) layer(c, target, masked ? base : null);
        return;
      }
      const s = surface(depth++);
      ops.push({ kind: "fill", target: s, pipeline: clearPipeline });
      if (isGroup(base)) stack(base.content.layers, s);
      else pixels(base, s, 1, 0, 0);
      if (masked) {
        drawMask(base, 0);
        step(s, compose.applyMask, stepSlot(1, 0, MASK_A));
      }
      for (const c of clipped) layer(c, s, null, true);
      composeSurface(s, target, base.opacity, blendModeIndex(effectiveMode(base.blendMode)), 0);
      depth--;
    }

    function layer(l: Layer, target: GPUTexture, limit: Layer | null = null, atop = false) {
      const own = !!l.mask?.enabled;
      const flags = (atop ? ATOP : 0) | (own ? MASK_A : 0) | (limit ? MASK_B : 0);
      const masks = () => {
        if (own) drawMask(l, 0);
        if (limit) drawMask(limit, 1);
      };
      const mode = blendModeIndex(effectiveMode(l.blendMode));
      const c = l.content;
      if (c.kind === "adjustment") {
        const r = adjustResources(programOf(l));
        masks();
        copyToScratch(target);
        return step(target, compose.adjust, stepSlot(l.opacity, mode, flags, r.kind, r.params), dummy.color, r);
      }
      if (c.kind === "group") {
        if (l.blendMode === "pass through" && !atop) {
          if (l.opacity >= 1 && !own && !limit) return stack(c.layers, target);
          // Render through, then fade between the backdrop before and after.
          const before = surface(depth++);
          ops.push({ kind: "copy", from: target, to: before });
          stack(c.layers, target);
          masks();
          copyToScratch(target);
          step(target, compose.lerp, stepSlot(l.opacity, 0, flags), before);
          depth--;
          return;
        }
        const s = surface(depth++);
        ops.push({ kind: "fill", target: s, pipeline: clearPipeline });
        stack(c.layers, s);
        masks();
        composeSurface(s, target, l.opacity, mode, flags);
        depth--;
        return;
      }
      masks();
      pixels(l, target, l.opacity, mode, flags);
    }

    /** A layer's own pixels (and the floating pixels being transformed as part of it). */
    function pixels(l: Layer, target: GPUTexture, opacity: number, mode: number, flags: number) {
      const entry = layers.get(l.id);
      const fast = mode === 0;
      const atop = (flags & ATOP) !== 0;
      if (entry?.instanceCount) {
        if (!fast) copyToScratch(target);
        const pipeline = fast ? (atop ? tile.atop : tile.normal) : tile.mode;
        ops.push({ kind: "tiles", target, pipeline, bindGroup: tileBindGroup!, entry, slot: tileSlot(entry, opacity, mode, flags, shiftOf(l.id)) });
      }
      const fl = floatOf(l.id, "pixels");
      if (fl) {
        if (!fast) copyToScratch(target);
        meshOp(target, fast ? (atop ? meshPreviewAtop : meshPreview) : meshPreviewMode, fl, opacity, mode, flags);
      }
    }

    /** A rendered surface (group, clipping group) blended onto `target` like a layer. */
    function composeSurface(s: GPUTexture, target: GPUTexture, opacity: number, mode: number, flags: number) {
      if (mode !== 0) copyToScratch(target);
      const pipeline = mode !== 0 ? compose.mode : flags & ATOP ? compose.atop : compose.over;
      step(target, pipeline, stepSlot(opacity, mode, flags), s);
    }

    ops.push({ kind: "fill", target: accum!, pipeline: clearPipeline });
    stack(scene.layers, accum!);

    if (drawUniforms.size < uniforms.length * UNIFORM_SLOT) {
      drawUniforms.destroy();
      drawUniforms = device.createBuffer({ size: Math.ceil(uniforms.length * 1.5) * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      rebuildBindGroups();
    }
    const data = new ArrayBuffer(Math.max(1, uniforms.length) * UNIFORM_SLOT);
    uniforms.forEach((write, i) => write(data, i * UNIFORM_SLOT));
    device.queue.writeBuffer(drawUniforms, 0, data);

    const encoder = device.createCommandEncoder();
    const scissor = toPx(area);
    const views = new Map<GPUTexture, GPUTextureView>();
    const viewOf = (t: GPUTexture) => views.get(t) ?? (views.set(t, t.createView({ baseMipLevel: 0, mipLevelCount: 1 })), views.get(t)!);
    let pass = null as GPURenderPassEncoder | null;
    let passTarget = null as GPUTexture | null;
    const open = (target: GPUTexture) => {
      if (pass && passTarget === target) return pass;
      pass?.end();
      passTarget = target;
      pass = encoder.beginRenderPass({ colorAttachments: [{ view: viewOf(target), loadOp: "load", storeOp: "store" }] });
      pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
      return pass;
    };
    const stepGroup = (op: Extract<Op, { kind: "step" }>) =>
      device.createBindGroup({
        layout: composeLayout,
        entries: [
          { binding: 0, resource: { buffer: drawUniforms, size: UNIFORM_SLOT } },
          { binding: 1, resource: viewOf(op.src) },
          { binding: 2, resource: viewOf(scratch!) },
          { binding: 3, resource: viewOf(maskA) },
          { binding: 4, resource: viewOf(maskB) },
          { binding: 5, resource: (op.lut ?? dummy.lut).createView() },
          { binding: 6, resource: (op.lut3 ?? dummy.lut3).createView() },
        ],
      });
    for (const op of ops) {
      if (op.kind === "copy") {
        pass?.end();
        pass = passTarget = null;
        encoder.copyTextureToTexture({ texture: op.from, origin: [scissor.x, scissor.y] }, { texture: op.to, origin: [scissor.x, scissor.y] }, [scissor.w, scissor.h]);
        continue;
      }
      const p = open(op.target);
      p.setPipeline(op.pipeline);
      switch (op.kind) {
        case "fill":
          if (op.constant !== undefined) p.setBlendConstant([op.constant, op.constant, op.constant, op.constant]);
          p.draw(3);
          break;
        case "tiles":
          p.setBindGroup(0, op.bindGroup, [op.slot * UNIFORM_SLOT]);
          p.setVertexBuffer(0, op.entry.instances!);
          p.draw(6, op.entry.instanceCount);
          break;
        case "mesh":
          p.setBindGroup(0, op.float.bindGroup!, [op.slot * UNIFORM_SLOT]);
          p.setVertexBuffer(0, op.float.mesh!.positions);
          p.setVertexBuffer(1, op.float.mesh!.uvs);
          p.setIndexBuffer(op.float.mesh!.indices, "uint32");
          p.drawIndexed(op.float.mesh!.count);
          break;
        case "step":
          p.setBindGroup(0, stepGroup(op), [op.slot * UNIFORM_SLOT]);
          p.draw(3);
          break;
      }
    }
    pass?.end();
    device.queue.submit([encoder.finish()]);
    mipsDirty = union(mipsDirty, scissor);
  }

  /** Regenerates the composite's mip chain, but only over the region that changed. */
  function generateMips() {
    const encoder = device.createCommandEncoder();
    let r = mipsDirty;
    for (let m = 1; m < mipCount; m++) {
      const w = Math.max(1, frame.w >> m);
      const h = Math.max(1, frame.h >> m);
      const x0 = r.x >> 1, y0 = r.y >> 1;
      r = intersect(rect(x0, y0, ((r.x + r.w + 1) >> 1) - x0, ((r.y + r.h + 1) >> 1) - y0), rect(0, 0, w, h));
      if (isEmpty(r)) break;
      fullscreenPass(
        encoder,
        mipPipeline,
        accum!.createView({ baseMipLevel: m, mipLevelCount: 1 }),
        [accum!.createView({ baseMipLevel: m - 1, mipLevelCount: 1 })],
        r,
      );
    }
    device.queue.submit([encoder.finish()]);
    mipsDirty = EMPTY_RECT;
  }

  function present(view: View, time: number, hasSelection: boolean) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const zoom = view.zoom * dpr;
    const L = frame.level;
    // A screen pixel spans 1/zoom document pixels, i.e. 1/(zoom·2^L) frame pixels.
    const lod = Math.max(0, Math.min(mipCount - 1, -Math.log2(zoom) - L));
    if (lod > 0 && !isEmpty(mipsDirty)) generateMips();
    const rot = view.rotation ?? 0;
    const u = new ArrayBuffer(VIEW_UNIFORM_SIZE);
    new Float32Array(u, 0, 6).set([size.width, size.height, view.panX * dpr, view.panY * dpr, zoom, time]);
    new Uint32Array(u, 24, 1)[0] = hasSelection ? 1 : 0;
    new Float32Array(u, 28, 1)[0] = lod;
    new Float32Array(u, 32, 4).set(WORKSPACE);
    // Whole frame pixels at whole screen pixels: read them as they are.
    new Uint32Array(u, 48, 1)[0] = lod <= 0 && L === 0 && rot === 0 ? 1 : 0;
    new Float32Array(u, 52, 9).set([1 << L, Math.cos(rot), Math.sin(rot), frame.x, frame.y, capacity.width, capacity.height, frame.w, frame.h]);
    device.queue.writeBuffer(viewUniforms, 0, u);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: output.target(w, h), loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(presentPipeline);
    pass.setBindGroup(0, presentBindGroup!);
    pass.draw(3);
    pass.end();
    output.finish(encoder);
    device.queue.submit([encoder.finish()]);
    output.submitted();
  }

  // --- Commit-quality resampling ----------------------------------------------

  async function resample(source: { pixels: Pixels; bounds: Rect }, mapping: Mapping, dest: Rect, filter: Filter) {
    const out = new Uint8ClampedArray(dest.w * dest.h * 4);
    if (isEmpty(dest) || isEmpty(source.bounds)) return out;
    if (!accum) throw new Error("Renderer has no document");
    // Commits are always full quality: at a reduced display level the
    // source is uploaded again at full resolution, just for this.
    device.pushErrorScope("out-of-memory");
    let temporary: FloatingTexture | null = null;
    let temporaryMesh: MeshBuffers | null = null;
    const uniforms = device.createBuffer({ size: MESH_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    try {
      // The preview's texture and mesh when they match (they usually do: this commits it).
      const same = (t: FloatingTexture | null) =>
        t && t.source === source.pixels && t.level === 0 && t.bounds.x === source.bounds.x && t.bounds.y === source.bounds.y && t.bounds.w === source.bounds.w && t.bounds.h === source.bounds.h;
      const cached = Object.values(floats).find((x) => same(x.texture));
      const f = cached?.texture ?? (temporary = buildFloating(source.pixels, source.bounds, 0));
      const m = Object.values(floats).find((x) => x.mesh?.mapping === mapping)?.mesh ?? (temporaryMesh = createMesh(mapping));
      const bindGroup = meshBindGroup(f.texture, uniforms);
      const filterIndex = { nearest: 0, bilinear: 1, bicubic: 2 }[filter];
      for (let cy = dest.y; cy < dest.y + dest.h; cy += CHUNK) {
        for (let cx = dest.x; cx < dest.x + dest.w; cx += CHUNK) {
          const chunk = intersect(rect(cx, cy, CHUNK, CHUNK), dest);
          const u = new ArrayBuffer(MESH_UNIFORM_SIZE);
          writeMeshUniform(u, 0, chunk, f, 1, 0, filterIndex);
          device.queue.writeBuffer(uniforms, 0, u);
          const target = device.createTexture({
            size: [chunk.w, chunk.h],
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          const bytesPerRow = Math.ceil((chunk.w * 4) / 256) * 256;
          const buffer = device.createBuffer({ size: bytesPerRow * chunk.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store" }] });
          pass.setPipeline(meshCommit);
          pass.setBindGroup(0, bindGroup, [0]);
          pass.setVertexBuffer(0, m.positions);
          pass.setVertexBuffer(1, m.uvs);
          pass.setIndexBuffer(m.indices, "uint32");
          pass.drawIndexed(m.count);
          pass.end();
          encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [chunk.w, chunk.h]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const rows = new Uint8Array(buffer.getMappedRange());
          for (let y = 0; y < chunk.h; y++) {
            out.set(rows.subarray(y * bytesPerRow, y * bytesPerRow + chunk.w * 4), ((chunk.y - dest.y + y) * dest.w + (chunk.x - dest.x)) * 4);
          }
          buffer.unmap();
          buffer.destroy();
          target.destroy();
        }
      }
    } finally {
      uniforms.destroy();
      temporary?.texture.destroy();
      destroyMesh(temporaryMesh);
      // An allocation that failed leaves invalid objects whose output is garbage; the caller falls back to the CPU.
      const err = await device.popErrorScope();
      if (err) throw new Error(`GPU out of memory: ${err.message}`);
    }
    return out;
  }

  async function adjust(pixels: Pixels, program: Program, selection: Mask | null): Promise<Pixels> {
    const area = selection ? intersect(storedBounds(pixels), selection.bounds) : storedBounds(pixels);
    if (isEmpty(area)) return pixels;
    const r = buildAdjust(program);
    const uniforms = device.createBuffer({ size: UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const u = new ArrayBuffer(UNIFORM_SLOT);
    new Float32Array(u, 0, 1)[0] = 1;
    new Uint32Array(u, 4, 3).set([0, selection ? MASK_A : 0, r.kind]);
    new Float32Array(u, 16, r.params.length).set(r.params);
    device.queue.writeBuffer(uniforms, 0, u);
    const out = tileWriter(pixels);
    device.pushErrorScope("out-of-memory");
    try {
      for (let cy = area.y; cy < area.y + area.h; cy += CHUNK) {
        for (let cx = area.x; cx < area.x + area.w; cx += CHUNK) {
          const chunk = intersect(rect(cx, cy, CHUNK, CHUNK), area);
          const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
          const src = device.createTexture({ size: [chunk.w, chunk.h], format: "rgba8unorm", usage });
          device.queue.writeTexture({ texture: src }, readRect(pixels, chunk) as Uint8ClampedArray<ArrayBuffer>, { bytesPerRow: chunk.w * 4 }, [chunk.w, chunk.h]);
          let coverage = dummy.mask;
          if (selection) {
            const b = selection.bounds;
            const rows = new Uint8Array(chunk.w * chunk.h);
            for (let y = 0; y < chunk.h; y++) {
              const from = (chunk.y + y - b.y) * b.w + (chunk.x - b.x);
              rows.set(selection.data.subarray(from, from + chunk.w), y * chunk.w);
            }
            coverage = device.createTexture({ size: [chunk.w, chunk.h], format: MASK_FORMAT, usage });
            device.queue.writeTexture({ texture: coverage }, rows, { bytesPerRow: chunk.w }, [chunk.w, chunk.h]);
          }
          const target = device.createTexture({ size: [chunk.w, chunk.h], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
          const bytesPerRow = Math.ceil((chunk.w * 4) / 256) * 256;
          const buffer = device.createBuffer({ size: bytesPerRow * chunk.h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store" }] });
          pass.setPipeline(adjustPixelsPipeline);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: composeLayout,
              entries: [
                { binding: 0, resource: { buffer: uniforms, size: UNIFORM_SLOT } },
                { binding: 1, resource: src.createView() },
                { binding: 2, resource: dummy.color.createView() },
                { binding: 3, resource: coverage.createView() },
                { binding: 4, resource: dummy.mask.createView() },
                { binding: 5, resource: (r.lut ?? dummy.lut).createView() },
                { binding: 6, resource: (r.lut3 ?? dummy.lut3).createView({ dimension: "3d" }) },
              ],
            }),
            [0],
          );
          pass.draw(3);
          pass.end();
          encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [chunk.w, chunk.h]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const mapped = new Uint8Array(buffer.getMappedRange());
          const result = new Uint8ClampedArray(chunk.w * chunk.h * 4);
          for (let y = 0; y < chunk.h; y++) result.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + chunk.w * 4), y * chunk.w * 4);
          buffer.unmap();
          writeRect(out, chunk, result);
          for (const t of [src, target, buffer]) t.destroy();
          if (coverage !== dummy.mask) coverage.destroy();
        }
      }
    } finally {
      uniforms.destroy();
      r.lut?.destroy();
      r.lut3?.destroy();
      const err = await device.popErrorScope();
      if (err) throw new Error(`GPU out of memory: ${err.message}`);
    }
    return out.finish();
  }

  /** Bands read back per round trip, bounding the staging memory (≤ 64 MB at 16k px wide). */
  const READBACK_BANDS = 16;

  const rasterizeShape = (geometry: ShapeGeometry, style: ShapeStyle, mapping: Mapping, clip: Rect) => rasterizeDrawing(shapeDrawing(geometry, style, mapping), clip);

  async function rasterizeDrawing(drawing: VectorDrawing, clip: Rect): Promise<Pixels> {
    const seg = drawingSegments(drawing);
    const bounds = intersect(roundOut(seg.bounds), clip);
    if (isEmpty(bounds)) return NO_PIXELS;
    const tx0 = Math.floor(bounds.x / TILE_SIZE), ty0 = Math.floor(bounds.y / TILE_SIZE);
    const x0 = tx0 * TILE_SIZE, y0 = ty0 * TILE_SIZE;
    const w = (Math.floor((bounds.x + bounds.w - 1) / TILE_SIZE) - tx0 + 1) * TILE_SIZE;
    const h = (Math.floor((bounds.y + bounds.h - 1) / TILE_SIZE) - ty0 + 1) * TILE_SIZE;
    const out = new Map<TileKey, Tile>();
    device.pushErrorScope("out-of-memory");
    try {
      for (let y = y0; y < y0 + h; y += READBACK_BANDS * TILE_SIZE) {
        const rows = Math.min(READBACK_BANDS * TILE_SIZE, y0 + h - y);
        const bytes = w * rows * 4;
        const target = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const staging = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        const release = vectors.encode(encoder, seg, rect(x0, y, w, rows), clip, TILE_SIZE, { kind: "buffer", buffer: target });
        encoder.copyBufferToBuffer(target, 0, staging, 0, bytes);
        device.queue.submit([encoder.finish()]);
        release();
        target.destroy();
        await staging.mapAsync(GPUMapMode.READ);
        const pixels = new Uint8ClampedArray(staging.getMappedRange().slice(0));
        staging.destroy();
        for (const [k, t] of pixelsFromImage(w, rows, pixels, x0, y)) out.set(k, t);
      }
    } finally {
      const err = await device.popErrorScope();
      if (err) throw new Error(`GPU out of memory: ${err.message}`);
    }
    return out;
  }

  /** Draws the scene: over the view's frame, or (`whole`) the entire document. */
  function draw(scene: Scene, view: View, time: number, whole: boolean) {
    if (scene.width !== size.width || scene.height !== size.height) resetDocument(scene.width, scene.height);
    const moved = updateFrame(view, scene, whole);
    if (moved) {
      // Nothing of the last frame is kept; past the new one's edge stays clear (filtering reads up to it).
      const encoder = device.createCommandEncoder();
      encoder.beginRenderPass({ colorAttachments: [{ view: accum!.createView({ baseMipLevel: 0, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store" }] }).end();
      device.queue.submit([encoder.finish()]);
    }
    markStale(union(syncLayers(scene), syncFloating(scene.floating)));
    syncSelection(scene.selection);
    // What's in view (with a cell's margin, for filtering and small pans) is brought up to date; the rest waits.
    const L = frame.level, margin = CELL << L;
    const v = visibleNow;
    const area = takeStale(whole ? frameRect() : rect(v.x - margin, v.y - margin, v.w + 2 * margin, v.h + 2 * margin));
    if (!isEmpty(area)) {
      composite(scene, area);
      stats.composited += area.w * area.h;
    }
    present(view, time, scene.selection !== null);
  }

  let last: { scene: Scene; view: View; time: number } | null = null;
  function render(scene: Scene, view: View, time: number, whole = false) {
    last = { scene, view, time };
    // Out of GPU memory last frame (or the atlas can't grow): rebuild at lower quality and try again.
    if (oomReported) {
      oomReported = false;
      degrade();
    }
    for (;;) {
      try {
        return draw(scene, view, time, whole);
      } catch (err) {
        if (!(err instanceof AtlasFull) || !degrade()) throw err;
      }
    }
  }

  return {
    render: (scene, view, time) => render(scene, view, time),
    level: () => bias,
    stats,

    resetLevel() {
      if (bias > 0) setBias(0);
    },

    resample,
    rasterizeShape,
    rasterizeDrawing,
    adjust,

    async readComposite() {
      // Composited whole for this: at reduced quality it's smaller, and scaled back up (nearest) to document size.
      if (!last) throw new Error("Nothing has been rendered");
      render(last.scene, last.view, last.time, true);
      const { w: width, h: height, level } = frame;
      const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
      const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: accum! }, { buffer, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const halves = new Uint16Array(buffer.getMappedRange().slice(0));
      buffer.destroy();
      const out = new Uint8ClampedArray(size.width * size.height * 4);
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          const s = (((y >> level) * bytesPerRow) >> 1) + (x >> level) * 4;
          const a = HALF[halves[s + 3]];
          if (a <= 0) continue;
          const o = (y * size.width + x) * 4;
          out[o] = (HALF[halves[s]] / a) * 255;
          out[o + 1] = (HALF[halves[s + 1]] / a) * 255;
          out[o + 2] = (HALF[halves[s + 2]] / a) * 255;
          out[o + 3] = a * 255;
        }
      }
      return out;
    },

    settled: () => output.settled(),

    destroy() {
      for (const entry of layers.values()) freeLayer(entry);
      layers.clear();
      for (const f of Object.values(floats)) {
        f.texture?.texture.destroy();
        destroyMesh(f.mesh);
      }
      accum?.destroy();
      scratch?.destroy();
      selectionTexture?.destroy();
      masks?.forEach((t) => t.destroy());
      for (const t of surfaces) t.destroy();
      for (const r of adjustments.values()) {
        r.lut?.destroy();
        r.lut3?.destroy();
      }
      for (const t of Object.values(dummy)) t.destroy();
      atlas.destroy();
      vectors.destroy();
      drawUniforms.destroy();
      viewUniforms.destroy();
      output.destroy();
    },
  };
}

/** Every half-float bit pattern decoded once. */
const HALF = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) t[h] = halfToFloat(h);
  return t;
})();

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Where presented frames go. */
interface Output {
  readonly format: GPUTextureFormat;
  target(width: number, height: number): GPUTextureView;
  /** Records any extra commands after the present pass. */
  finish(encoder: GPUCommandEncoder): void;
  submitted(): void;
  settled(): Promise<void>;
  destroy(): void;
}

function canvasOutput(device: GPUDevice, canvas: HTMLCanvasElement): Output {
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  return {
    format,
    target: () => context.getCurrentTexture().createView(),
    finish() {},
    submitted() {},
    settled: () => device.queue.onSubmittedWorkDone(),
    destroy: () => context.unconfigure(),
  };
}

function readbackOutput(device: GPUDevice, canvas: HTMLCanvasElement): Output {
  const ctx = canvas.getContext("2d")!;
  let texture: GPUTexture | null = null;
  let buffer: GPUBuffer | null = null;
  let bytesPerRow = 0;
  let mapping = false; // a frame is being read back
  let stale = false; // a newer frame was rendered meanwhile
  let waiters: (() => void)[] = [];

  const copy = (encoder: GPUCommandEncoder) =>
    encoder.copyTextureToBuffer({ texture: texture! }, { buffer: buffer!, bytesPerRow }, [texture!.width, texture!.height]);

  async function readBack() {
    mapping = true;
    const t = texture!;
    const b = buffer!;
    try {
      await b.mapAsync(GPUMapMode.READ);
      const rows = new Uint8Array(b.getMappedRange());
      const img = new ImageData(t.width, t.height);
      for (let y = 0; y < t.height; y++) img.data.set(rows.subarray(y * bytesPerRow, y * bytesPerRow + t.width * 4), y * t.width * 4);
      b.unmap();
      ctx.putImageData(img, 0, 0);
    } catch {
      // The buffer was replaced by a resize; the next frame covers it.
    }
    mapping = false;
    if (stale && texture) {
      stale = false;
      const encoder = device.createCommandEncoder();
      copy(encoder);
      device.queue.submit([encoder.finish()]);
      void readBack();
      return;
    }
    waiters.forEach((w) => w());
    waiters = [];
  }

  return {
    format: "rgba8unorm",
    target(width, height) {
      if (!texture || texture.width !== width || texture.height !== height) {
        texture?.destroy();
        buffer?.destroy();
        texture = device.createTexture({
          size: [width, height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      }
      return texture.createView();
    },
    finish(encoder) {
      if (mapping) stale = true;
      else copy(encoder);
    },
    submitted() {
      if (!mapping) void readBack();
    },
    settled: () => (mapping ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()),
    destroy() {
      texture?.destroy();
      buffer?.destroy();
    },
  };
}
