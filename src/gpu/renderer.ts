import { lookup, type Program } from "../core/adjustments";
import { blendModeIndex, effectiveMode } from "../core/blend";
import { fillOf, programOf } from "../core/composite";
import { placementMapping, wholePixelMove } from "../core/content";
import type { Layer, LayerContent } from "../core/document";
import { hasPixels, isClipped, isGroup, walk } from "../core/layers";
import { shapeSegments, type ShapeGeometry, type ShapeStyle } from "../core/shape";
import { createVectorRasterizer } from "./vector";
import { EMPTY_RECT, intersect, isEmpty, rect, roundOut, union, type Rect, type Vec2 } from "../core/geometry";
import type { Filter } from "../core/rasterize";
import type { Mask } from "../core/selection";
import { NO_PIXELS, TILE_SIZE, downsample, downsampleTile, keyX, keyY, readRect, storedBounds, tileKey, tileRect, tileWriter, pixelsFromImage, tilesIn, writeRect, type Tile, type TileKey, type Pixels } from "../core/pixels";
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
  readonly stats: { shapesRasterized: number; shapesMoved: number };
  destroy(): void;
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

const ZERO: Vec2 = { x: 0, y: 0 };
const translateRect = (r: Rect, d: Vec2): Rect => (d.x || d.y ? rect(r.x + d.x, r.y + d.y, r.w, r.h) : r);
const contains = (outer: Rect, inner: Rect) =>
  isEmpty(inner) || (inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h);



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
  /** What's in the atlas for each on-canvas tile (tile is null for tiles the GPU rasterized). */
  readonly slots: Map<TileKey, { slot: number; tile: Tile | null; version: number }>;
  /** For shape layers: the content last rasterized, and what of it was rasterized (document space, within the canvas). */
  shape: ShapeContent | null;
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
  // Quality reduction under GPU memory pressure: tiles are stored at
  // slot² texels and the composite at 1/2^level of document resolution.
  let level = Math.min(MAX_LEVEL, options.level ?? 0);
  let slotSize = TILE_SIZE >> level;
  let slotsPerSide = ATLAS_PAGE / slotSize;
  let slotsPerPage = slotsPerSide * slotsPerSide;
  let tilesModule = module(tilesWgsl(slotSize));
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
  const tilePipelines = () => ({
    normal: tilePipeline("fs_normal", PREMULTIPLIED_OVER),
    atop: tilePipeline("fs_normal", PREMULTIPLIED_ATOP),
    mode: tilePipeline("fs_mode"),
    mask: tilePipeline("fs_mask", PREMULTIPLIED_OVER, MASK_FORMAT),
  });
  let tile = tilePipelines();

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
  const stats = { shapesRasterized: 0, shapesMoved: 0 };
  const trilinear = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
  const viewUniforms = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    if (nextSlot >= pages * slotsPerPage) {
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

  const uploadTile = (slot: number, tile: Tile) => {
    const local = slot % slotsPerPage;
    device.queue.writeTexture(
      { texture: atlas, origin: [(local % slotsPerSide) * slotSize, Math.floor(local / slotsPerSide) * slotSize, Math.floor(slot / slotsPerPage)] },
      level === 0 ? (tile.data as Uint8ClampedArray<ArrayBuffer>) : downsampleTile(tile, level),
      { bytesPerRow: slotSize * 4, rowsPerImage: slotSize },
      [slotSize, slotSize, 1],
    );
  };

  // --- Per-document resources ---------------------------------------------
  let size = { width: 0, height: 0 };
  /** The composite's resolution: the document at 1/2^level. */
  let px = { width: 0, height: 0 };
  /** A document-space rectangle in composite pixels (rounded outwards). */
  const toPx = (r: Rect): Rect => {
    if (level === 0) return r;
    const x0 = r.x >> level, y0 = r.y >> level;
    return intersect(rect(x0, y0, ((r.x + r.w + (1 << level) - 1) >> level) - x0, ((r.y + r.h + (1 << level) - 1) >> level) - y0), rect(0, 0, px.width, px.height));
  };
  let accum: GPUTexture | null = null;
  let scratch: GPUTexture | null = null;
  /** Layer mask coverage at composite resolution: a layer's own (A) and its clipping base's (B). */
  let masks: [GPUTexture, GPUTexture] | null = null;
  /** Intermediate surfaces for groups and clipping groups, one per nesting depth in use (allocated as needed). */
  const surfaces: GPUTexture[] = [];
  let selectionTexture: GPUTexture | null = null;
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
  let selectionBounds = EMPTY_RECT;

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
    accum?.destroy();
    scratch?.destroy();
    selectionTexture?.destroy();
    masks?.forEach((t) => t.destroy());
    for (const t of surfaces.splice(0)) t.destroy();
    size = { width, height };
    // A document beyond the device's texture size can only be shown reduced.
    const maxDim = device.limits.maxTextureDimension2D;
    while (level < MAX_LEVEL && Math.max(width, height) >> level > maxDim) setLevel(level + 1);
    px = { width: Math.max(1, Math.ceil(width / (1 << level))), height: Math.max(1, Math.ceil(height / (1 << level))) };
    mipCount = Math.floor(Math.log2(Math.max(px.width, px.height))) + 1;
    allocating(() => createDocumentTextures(width, height));
    rebuildBindGroups();
    lastStructure = "";
    lastFloating = null;
    lastSelection = undefined;
    selectionBounds = EMPTY_RECT;
  }

  function createDocumentTextures(width: number, height: number) {
    accum = device.createTexture({
      size: [px.width, px.height],
      format: ACCUM_FORMAT,
      mipLevelCount: mipCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    scratch = device.createTexture({
      size: [px.width, px.height],
      format: ACCUM_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const mask = () =>
      device.createTexture({ size: [px.width, px.height], format: MASK_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
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

  /** Switches the quality reduction, dropping every GPU copy so it's re-uploaded at the new scale. */
  function setLevel(next: number) {
    level = next;
    slotSize = TILE_SIZE >> level;
    slotsPerSide = ATLAS_PAGE / slotSize;
    slotsPerPage = slotsPerSide * slotsPerSide;
    tilesModule = module(tilesWgsl(slotSize));
    tile = tilePipelines();
    for (const entry of layers.values()) freeLayer(entry);
    layers.clear();
    freeSlots.length = 0;
    nextSlot = 0;
    atlas.destroy();
    pages = 1;
    atlas = createAtlas(pages);
    for (const f of Object.values(floats)) {
      f.texture?.texture.destroy();
      f.texture = null;
    }
    lastFloating = null;
    options.onLevelChange?.(level);
  }

  /** Rebuilds the document's GPU state at the next lower quality. */
  function degrade(): boolean {
    if (level >= MAX_LEVEL) return false;
    console.warn(`GPU memory is constrained; drawing at 1/${2 << level} resolution.`);
    setLevel(level + 1);
    const { width, height } = size;
    size = { width: 0, height: 0 };
    resetDocument(width, height);
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

  function syncLayer(entry: LayerEntry, tiles: Pixels): Rect {
    const canvasRect = rect(0, 0, size.width, size.height);
    // Was a shape (since rasterized): its GPU-rendered tiles are replaced by uploads below.
    let dirty = entry.shape ? translateRect(entry.shapeBounds, entry.offset) : EMPTY_RECT;
    entry.shape = null;
    entry.shapeBounds = EMPTY_RECT;
    entry.shapeExtent = EMPTY_RECT;
    entry.offset = ZERO;
    for (const [key, tile] of tiles) {
      const r = tileRect(keyX(key), keyY(key));
      if (isEmpty(intersect(r, canvasRect))) continue;
      const prev = entry.slots.get(key);
      if (prev && prev.tile === tile && prev.version === tile.version) continue;
      const slot = prev?.slot ?? allocSlot();
      uploadTile(slot, tile);
      entry.slots.set(key, { slot, tile, version: tile.version });
      if (!prev) entry.instancesDirty = true;
      dirty = union(dirty, r);
    }
    for (const [key, { slot }] of entry.slots) {
      if (tiles.has(key)) continue;
      entry.slots.delete(key);
      freeSlots.push(slot);
      entry.instancesDirty = true;
      dirty = union(dirty, tileRect(keyX(key), keyY(key)));
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
   * the display's resolution. Only when its content changes (or the display
   * level does); CPU tiles of shape layers are never uploaded.
   */
  function syncShape(entry: LayerEntry, content: ShapeContent): Rect {
    const canvasRect = rect(0, 0, size.width, size.height);
    const drawn = translateRect(entry.shapeBounds, entry.offset);
    // Moved by whole pixels, with nothing previously off the canvas coming into view: draw what's
    // already rasterized, offset, instead of rasterizing again.
    const d = entry.shape && wholePixelMove(entry.shape, content, 1 << level);
    if (d && entry.shape) {
      const visible = intersect(translateRect(entry.shapeExtent, d), canvasRect);
      if (contains(translateRect(entry.shapeBounds, d), visible)) {
        if (d.x === entry.offset.x && d.y === entry.offset.y) return EMPTY_RECT;
        entry.offset = d;
        stats.shapesMoved++;
        return union(drawn, translateRect(entry.shapeBounds, d));
      }
    }
    entry.offset = ZERO;
    stats.shapesRasterized++;
    const seg = shapeSegments(content.geometry, content.style, placementMapping(content.placement), 1 / (1 << level));
    const extent = roundOut(seg.bounds);
    const bounds = intersect(extent, canvasRect);
    entry.shapeExtent = extent;
    const dirty = union(drawn, bounds);
    const keep = new Set<TileKey>();
    for (const [tx, ty] of tilesIn(bounds)) keep.add(tileKey(tx, ty));
    for (const [key, { slot }] of entry.slots) {
      if (keep.has(key)) continue;
      entry.slots.delete(key);
      freeSlots.push(slot);
      entry.instancesDirty = true;
    }
    entry.shape = content;
    entry.shapeBounds = bounds;
    if (!isEmpty(bounds)) {
      const tx0 = Math.floor(bounds.x / TILE_SIZE), ty0 = Math.floor(bounds.y / TILE_SIZE);
      const cols = Math.floor((bounds.x + bounds.w - 1) / TILE_SIZE) - tx0 + 1;
      const rows = Math.floor((bounds.y + bounds.h - 1) / TILE_SIZE) - ty0 + 1;
      const slots = new Int32Array(cols * rows);
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const key = tileKey(tx0 + i, ty0 + j);
          let s = entry.slots.get(key);
          if (!s) {
            s = { slot: allocSlot(), tile: null, version: 0 };
            entry.slots.set(key, s);
            entry.instancesDirty = true;
          }
          slots[j * cols + i] = s.slot;
        }
      // In composite pixels: tile (tx, ty) is a slotSize² block.
      const region = rect(tx0 * slotSize, ty0 * slotSize, cols * slotSize, rows * slotSize);
      const view = atlas.createView({ dimension: "2d-array" });
      shapeWork ??= { encoder: device.createCommandEncoder(), releases: [] };
      shapeWork.releases.push(
        vectors.encode(shapeWork.encoder, seg, region, rect(0, 0, px.width, px.height), slotSize, { kind: "atlas", view, slotSize, slotsPerSide, slots }),
      );
    }
    writeInstances(entry);
    return dirty;
  }

  const entryFor = (key: string): LayerEntry => {
    let entry = layers.get(key);
    if (!entry) {
      entry = { slots: new Map(), instances: null, instanceCount: 0, instancesDirty: true, shape: null, shapeBounds: EMPTY_RECT, shapeExtent: EMPTY_RECT, offset: ZERO };
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
        let s = `${l.id}|${l.visible}|${l.opacity}|${l.fill}|${l.blendMode}|${l.clipped}|${l.isBackground}|${m ? `${m.enabled}${m.background}${m.density}` : ""}`;
        if (c.kind === "adjustment") {
          let n = adjustmentIds.get(c.adjustment);
          if (n === undefined) adjustmentIds.set(c.adjustment, (n = nextAdjustmentId++));
          s += `|a${n}`;
        }
        return c.kind === "group" ? `${s}[${structureOf(c.layers)}]` : s;
      })
      .join(",");

  /** Uploads what changed of every layer's pixels and mask; returns the area that changed. */
  function syncLayers(scene: Scene): Rect {
    const full = rect(0, 0, size.width, size.height);
    let dirty = EMPTY_RECT;
    const seen = new Set<string>();
    const programs = new Set<Program>();
    for (const layer of walk(scene.layers)) {
      if (hasPixels(layer)) {
        seen.add(layer.id);
        const entry = entryFor(layer.id);
        // Hidden layers keep no GPU copy; showing one uploads it again.
        if (!layer.visible) releaseSlots(entry);
        else dirty = union(dirty, layer.content.kind === "shape" ? syncShape(entry, layer.content) : syncLayer(entry, layer.pixels));
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

  function syncSelection(sel: Mask | null) {
    if (sel === lastSelection) return;
    lastSelection = sel;
    if (!isEmpty(selectionBounds)) {
      const b = selectionBounds;
      device.queue.writeTexture({ texture: selectionTexture!, origin: [b.x, b.y] }, new Uint8Array(b.w * b.h), { bytesPerRow: b.w }, [b.w, b.h]);
    }
    selectionBounds = sel ? sel.bounds : EMPTY_RECT;
    if (!sel) return;
    const b = sel.bounds;
    device.queue.writeTexture({ texture: selectionTexture!, origin: [b.x, b.y] }, sel.data as Uint8Array<ArrayBuffer>, { bytesPerRow: b.w }, [b.w, b.h]);
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
        size: [px.width, px.height],
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
    const viewport = rect(0, 0, size.width, size.height);
    const meshOp = (target: GPUTexture, pipeline: GPURenderPipeline, fl: Float, opacity: number, mode: number, flags: number) =>
      ops.push({ kind: "mesh", target, pipeline, float: fl, slot: slot((data, at) => writeMeshUniform(data, at, viewport, fl.texture!, opacity, mode, 0, flags)) });
    const [maskA, maskB] = masks!;
    let depth = 0;

    const shiftOf = (id: string) => (f?.shift?.ids.has(id) ? f.shift.by : ZERO);
    const tileSlot = (entry: LayerEntry, opacity: number, mode: number, flags: number, shift = ZERO) =>
      slot((data, at) => {
        new Float32Array(data, at, 1)[0] = opacity;
        new Uint32Array(data, at + 4, 1)[0] = mode;
        new Float32Array(data, at + 8, 2).set([px.width, px.height]);
        new Int32Array(data, at + 16, 2).set([(entry.offset.x + shift.x) >> level, (entry.offset.y + shift.y) >> level]);
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
      else pixels(base, s, fillOf(base), 0, 0);
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
        return step(target, compose.adjust, stepSlot(l.opacity * fillOf(l), mode, flags, r.kind, r.params), dummy.color, r);
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
      pixels(l, target, l.opacity * fillOf(l), mode, flags);
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
      const w = Math.max(1, px.width >> m);
      const h = Math.max(1, px.height >> m);
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
    // A screen pixel spans 1/zoom document pixels, i.e. 1/(zoom·2^level) composite pixels.
    const lod = Math.max(0, Math.min(mipCount - 1, -Math.log2(zoom) - level));
    if (lod > 0 && !isEmpty(mipsDirty)) generateMips();
    const u = new ArrayBuffer(64);
    new Float32Array(u, 0, 6).set([size.width, size.height, view.panX * dpr, view.panY * dpr, zoom, time]);
    new Uint32Array(u, 24, 1)[0] = hasSelection ? 1 : 0;
    new Float32Array(u, 28, 1)[0] = lod;
    new Float32Array(u, 32, 4).set(WORKSPACE);
    const rot = view.rotation ?? 0;
    new Float32Array(u, 56, 2).set([Math.cos(rot), Math.sin(rot)]);
    new Uint32Array(u, 48, 1)[0] = level > 0 ? 1 : 0;
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

  async function rasterizeShape(geometry: ShapeGeometry, style: ShapeStyle, mapping: Mapping, clip: Rect): Promise<Pixels> {
    const seg = shapeSegments(geometry, style, mapping);
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

  function draw(scene: Scene, view: View, time: number) {
    if (scene.width !== size.width || scene.height !== size.height) resetDocument(scene.width, scene.height);
    const dirty = union(syncLayers(scene), syncFloating(scene.floating));
    syncSelection(scene.selection);
    const area = intersect(dirty, rect(0, 0, size.width, size.height));
    if (!isEmpty(area)) composite(scene, area);
    present(view, time, scene.selection !== null);
  }

  return {
    render(scene, view, time) {
      // Out of GPU memory last frame (or the atlas can't grow): rebuild at lower quality and try again.
      if (oomReported) {
        oomReported = false;
        degrade();
      }
      for (;;) {
        try {
          return draw(scene, view, time);
        } catch (err) {
          if (!(err instanceof AtlasFull) || !degrade()) throw err;
        }
      }
    },

    level: () => level,
    stats,

    resetLevel() {
      if (level === 0) return;
      setLevel(0);
      const { width, height } = size;
      size = { width: 0, height: 0 };
      if (width) resetDocument(width, height);
    },

    resample,
    rasterizeShape,
    adjust,

    async readComposite() {
      // At reduced quality the composite is smaller; it's scaled back up (nearest) to document size.
      const { width, height } = px;
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
