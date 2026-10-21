import { blendModeIndex, type BlendMode } from "../core/blend";
import type { Layer } from "../core/document";
import { EMPTY_RECT, intersect, isEmpty, rect, union, type Rect } from "../core/geometry";
import type { Filter } from "../core/rasterize";
import type { Mask } from "../core/selection";
import { TILE_SIZE, downsample, downsampleTile, keyX, keyY, readRect, tileRect, type Tile, type TileKey, type TileMap } from "../core/tiles";
import { tessellate, type Mapping } from "../core/warp";
import { ATLAS_PAGE, CLEAR_WGSL, MESH_WGSL, MIP_WGSL, PREMULTIPLY_WGSL, PRESENT_WGSL, tilesWgsl } from "./shaders";

/** Pixels drawn through a mapping above a given layer (Free Transform / Move preview). */
export interface FloatingLayer {
  readonly tiles: TileMap;
  /** Bounds of `tiles`' content; also the mapping's source rectangle. */
  readonly bounds: Rect;
  readonly mapping: Mapping;
  readonly aboveLayerId: string;
  readonly opacity: number;
  readonly blendMode: BlendMode;
}

export interface Scene {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly Layer[];
  readonly selection: Mask | null;
  readonly floating: FloatingLayer | null;
}

/** Screen = doc × zoom + pan, in CSS pixels. */
export interface View {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface Renderer {
  /** Syncs the scene to the GPU (uploading only changed tiles) and draws it. */
  render(scene: Scene, view: View, time: number): void;
  /**
   * Resamples floating pixels through a mapping on the GPU (the Free
   * Transform commit), returning straight RGBA8 covering `dest`.
   */
  resample(source: { tiles: TileMap; bounds: Rect }, mapping: Mapping, dest: Rect, filter: Filter): Promise<Uint8ClampedArray>;
  /** Reads back the composite as straight RGBA8 (for tests and debugging). */
  readComposite(): Promise<Uint8ClampedArray>;
  /** Resolves once the most recently rendered frame is on screen. */
  settled(): Promise<void>;
  /** Current display quality reduction: the canvas is composited at 1/2^level resolution (0 = full). */
  level(): number;
  /** Tries full quality again (e.g. after closing documents). */
  resetLevel(): void;
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

/** The tile atlas can't grow (device limit, or out of GPU memory). */
class AtlasFull extends Error {}

/** Down to 1/16 resolution (16×16-texel tiles); past that, the display isn't useful. */
export const MAX_LEVEL = 4;

const ACCUM_FORMAT: GPUTextureFormat = "rgba16float";
const UNIFORM_SLOT = 256; // minUniformBufferOffsetAlignment
const TILE_UNIFORM_SIZE = 16; // sizeof(Draw)
const MESH_UNIFORM_SIZE = 48; // sizeof(Mesh)
const WORKSPACE = [0.16, 0.16, 0.17, 1];
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

interface LayerEntry {
  /** What's in the atlas for each on-canvas tile. */
  readonly slots: Map<TileKey, { slot: number; tile: Tile; version: number }>;
  instances: GPUBuffer | null;
  instanceCount: number;
  instancesDirty: boolean;
  props: string;
}

interface FloatingTexture {
  readonly source: TileMap;
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
    ],
  });
  // Quality reduction under GPU memory pressure: tiles are stored at
  // slot² texels and the composite at 1/2^level of document resolution.
  let level = Math.min(MAX_LEVEL, options.level ?? 0);
  let slotSize = TILE_SIZE >> level;
  let slotsPerSide = ATLAS_PAGE / slotSize;
  let slotsPerPage = slotsPerSide * slotsPerSide;
  let tilesModule = module(tilesWgsl(slotSize));
  const tilePipeline = (entryPoint: string, blend?: GPUBlendState) =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [tileLayout] }),
      vertex: {
        module: tilesModule,
        entryPoint: "vs",
        buffers: [{ arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "sint32x3" }] }],
      },
      fragment: { module: tilesModule, entryPoint, targets: [{ format: ACCUM_FORMAT, blend }] },
    });
  let tileNormal = tilePipeline("fs_normal", PREMULTIPLIED_OVER);
  let tileMode = tilePipeline("fs_mode");

  const meshLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
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
  const meshPreviewMode = meshPipeline("fs_preview_mode", ACCUM_FORMAT);
  const meshCommit = meshPipeline("fs_commit", "rgba8unorm");

  const fullscreen = (code: string, format: GPUTextureFormat) => {
    const m = module(code);
    return device.createRenderPipeline({
      layout: "auto",
      vertex: { module: m, entryPoint: "vs" },
      fragment: { module: m, entryPoint: "fs", targets: [{ format }] },
    });
  };
  const clearPipeline = fullscreen(CLEAR_WGSL, ACCUM_FORMAT);
  const premultiplyPipeline = fullscreen(PREMULTIPLY_WGSL, ACCUM_FORMAT);
  const mipPipeline = fullscreen(MIP_WGSL, ACCUM_FORMAT);
  const presentPipeline = fullscreen(PRESENT_WGSL, output.format);

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
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
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
  let selectionTexture: GPUTexture | null = null;
  let mipCount = 1;
  let mipsDirty = EMPTY_RECT;
  let tileBindGroup: GPUBindGroup | null = null;
  let presentBindGroup: GPUBindGroup | null = null;
  const layers = new Map<string, LayerEntry>();
  let floating: FloatingTexture | null = null;
  let floatingBindGroup: GPUBindGroup | null = null;
  let mesh: MeshBuffers | null = null;
  let lastOrder = "";
  let lastFloating: FloatingLayer | null = null;
  let lastSelection: Mask | null | undefined = undefined;
  let selectionBounds = EMPTY_RECT;

  function rebuildBindGroups() {
    if (!accum) return;
    tileBindGroup = device.createBindGroup({
      layout: tileLayout,
      entries: [
        { binding: 0, resource: { buffer: drawUniforms, size: TILE_UNIFORM_SIZE } },
        { binding: 1, resource: atlas.createView({ dimension: "2d-array" }) },
        { binding: 2, resource: scratch!.createView() },
      ],
    });
    floatingBindGroup = floating ? meshBindGroup(floating.texture, drawUniforms) : null;
  }

  const meshBindGroup = (texture: GPUTexture, uniforms: GPUBuffer) =>
    device.createBindGroup({
      layout: meshLayout,
      entries: [
        { binding: 0, resource: { buffer: uniforms, size: MESH_UNIFORM_SIZE } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: trilinear },
        { binding: 3, resource: scratch!.createView() },
      ],
    });

  function releaseSlots(entry: LayerEntry) {
    for (const { slot } of entry.slots.values()) freeSlots.push(slot);
    if (entry.slots.size) entry.instancesDirty = true;
    entry.slots.clear();
    entry.instanceCount = 0;
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
    size = { width, height };
    // A document beyond the device's texture size can only be shown reduced.
    const maxDim = device.limits.maxTextureDimension2D;
    while (level < MAX_LEVEL && Math.max(width, height) >> level > maxDim) setLevel(level + 1);
    px = { width: Math.max(1, Math.ceil(width / (1 << level))), height: Math.max(1, Math.ceil(height / (1 << level))) };
    mipCount = Math.floor(Math.log2(Math.max(px.width, px.height))) + 1;
    allocating(() => createDocumentTextures(width, height));
    rebuildBindGroups();
    lastOrder = "";
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
    tileNormal = tilePipeline("fs_normal", PREMULTIPLIED_OVER);
    tileMode = tilePipeline("fs_mode");
    for (const entry of layers.values()) freeLayer(entry);
    layers.clear();
    freeSlots.length = 0;
    nextSlot = 0;
    atlas.destroy();
    pages = 1;
    atlas = createAtlas(pages);
    floating?.texture.destroy();
    floating = null;
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
  function syncLayer(entry: LayerEntry, tiles: TileMap): Rect {
    const canvasRect = rect(0, 0, size.width, size.height);
    let dirty = EMPTY_RECT;
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
    return dirty;
  }

  function syncLayers(scene: Scene): Rect {
    const full = rect(0, 0, size.width, size.height);
    let dirty = EMPTY_RECT;
    const seen = new Set<string>();
    for (const layer of scene.layers) {
      seen.add(layer.id);
      let entry = layers.get(layer.id);
      if (!entry) {
        entry = { slots: new Map(), instances: null, instanceCount: 0, instancesDirty: true, props: "" };
        layers.set(layer.id, entry);
      }
      // Hidden layers keep no GPU copy; showing one uploads it again.
      if (!layer.visible) releaseSlots(entry);
      const changed = layer.visible ? syncLayer(entry, layer.tiles) : EMPTY_RECT;
      const props = `${layer.visible}|${layer.opacity}|${layer.blendMode}`;
      if (props !== entry.props) {
        entry.props = props;
        dirty = full;
      } else {
        dirty = union(dirty, changed);
      }
    }
    for (const [id, entry] of layers) {
      if (seen.has(id)) continue;
      freeLayer(entry);
      layers.delete(id);
      dirty = full;
    }
    const order = scene.layers.map((l) => l.id).join("/");
    if (order !== lastOrder) {
      lastOrder = order;
      dirty = full;
    }
    return dirty;
  }

  /** The preview's premultiplied, mipmapped texture of floating pixels, at the display's quality (cached by tile-map identity). */
  function floatingTexture(source: TileMap, bounds: Rect): FloatingTexture {
    if (floating && floating.source === source && floating.level === level) return floating;
    floating?.texture.destroy();
    floating = null;
    const f = allocating(() => buildFloating(source, bounds, level));
    floating = f;
    floatingBindGroup = accum ? meshBindGroup(f.texture, drawUniforms) : null;
    return f;
  }

  /**
   * Uploads floating pixels at 1/2^lvl resolution and builds the mip chain.
   * Reduced levels are filtered on the CPU a strip at a time, so no
   * full-size intermediate is ever allocated.
   */
  function buildFloating(source: TileMap, bounds: Rect, lvl: number): FloatingTexture {
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

  function meshBuffers(mapping: Mapping): MeshBuffers {
    if (mesh && mesh.mapping === mapping) return mesh;
    mesh?.positions.destroy();
    mesh?.uvs.destroy();
    mesh?.indices.destroy();
    const m = tessellate(mapping);
    const buffer = (data: Float32Array | Uint32Array, usage: number) => {
      const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      return b;
    };
    mesh = {
      mapping,
      positions: buffer(m.positions, GPUBufferUsage.VERTEX),
      uvs: buffer(m.uvs, GPUBufferUsage.VERTEX),
      indices: buffer(m.indices, GPUBufferUsage.INDEX),
      count: m.indices.length,
    };
    return mesh;
  }

  function syncFloating(f: FloatingLayer | null): Rect {
    if (f === lastFloating) return EMPTY_RECT;
    lastFloating = f;
    if (f && !isEmpty(f.bounds)) {
      floatingTexture(f.tiles, f.bounds);
      meshBuffers(f.mapping);
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

  function writeMeshUniform(target: ArrayBuffer, offset: number, viewport: Rect, f: FloatingTexture, opacity: number, mode: number, filter: number) {
    new Float32Array(target, offset, 7).set([viewport.x, viewport.y, viewport.w, viewport.h, f.bounds.w, f.bounds.h, opacity]);
    new Uint32Array(target, offset + 28, 2).set([mode, filter]);
    new Float32Array(target, offset + 36, 1)[0] = f.mipCount - 1;
  }

  function composite(scene: Scene, area: Rect) {
    type Op =
      | { kind: "tiles"; entry: LayerEntry; opacity: number; mode: number }
      | { kind: "mesh"; opacity: number; mode: number };
    const ops: Op[] = [];
    const f = scene.floating;
    const hasFloating = !!(f && floating && mesh && !isEmpty(f.bounds));
    for (const layer of scene.layers) {
      const entry = layers.get(layer.id)!;
      if (layer.visible && layer.opacity > 0 && entry.instanceCount > 0) {
        ops.push({ kind: "tiles", entry, opacity: layer.opacity, mode: blendModeIndex(layer.blendMode) });
      }
      if (hasFloating && f!.aboveLayerId === layer.id) ops.push({ kind: "mesh", opacity: f!.opacity, mode: blendModeIndex(f!.blendMode) });
    }

    if (drawUniforms.size < ops.length * UNIFORM_SLOT) {
      drawUniforms.destroy();
      drawUniforms = device.createBuffer({ size: Math.ceil(ops.length * 1.5) * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      rebuildBindGroups();
    }
    const data = new ArrayBuffer(Math.max(1, ops.length) * UNIFORM_SLOT);
    const docViewport = rect(0, 0, size.width, size.height);
    ops.forEach((op, i) => {
      if (op.kind === "tiles") {
        new Float32Array(data, i * UNIFORM_SLOT, 1)[0] = op.opacity;
        new Uint32Array(data, i * UNIFORM_SLOT + 4, 1)[0] = op.mode;
        new Float32Array(data, i * UNIFORM_SLOT + 8, 2).set([px.width, px.height]);
      } else {
        writeMeshUniform(data, i * UNIFORM_SLOT, docViewport, floating!, op.opacity, op.mode, 0);
      }
    });
    device.queue.writeBuffer(drawUniforms, 0, data);

    const encoder = device.createCommandEncoder();
    const target = accum!.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    const scissor = toPx(area);
    let pass: GPURenderPassEncoder | null = null;
    const open = () => {
      if (pass) return pass;
      pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }] });
      pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
      return pass;
    };
    const close = () => {
      pass?.end();
      pass = null;
    };
    const p0 = open();
    p0.setPipeline(clearPipeline);
    p0.draw(3);

    ops.forEach((op, i) => {
      const normal = op.mode === 0;
      if (!normal) {
        // Blend modes read the destination: snapshot the area first.
        close();
        encoder.copyTextureToTexture({ texture: accum!, origin: [scissor.x, scissor.y] }, { texture: scratch!, origin: [scissor.x, scissor.y] }, [scissor.w, scissor.h]);
      }
      const p = open();
      if (op.kind === "tiles") {
        p.setPipeline(normal ? tileNormal : tileMode);
        p.setBindGroup(0, tileBindGroup!, [i * UNIFORM_SLOT]);
        p.setVertexBuffer(0, op.entry.instances!);
        p.draw(6, op.entry.instanceCount);
      } else {
        p.setPipeline(normal ? meshPreview : meshPreviewMode);
        p.setBindGroup(0, floatingBindGroup!, [i * UNIFORM_SLOT]);
        p.setVertexBuffer(0, mesh!.positions);
        p.setVertexBuffer(1, mesh!.uvs);
        p.setIndexBuffer(mesh!.indices, "uint32");
        p.drawIndexed(mesh!.count);
      }
    });
    close();
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

  async function resample(source: { tiles: TileMap; bounds: Rect }, mapping: Mapping, dest: Rect, filter: Filter) {
    const out = new Uint8ClampedArray(dest.w * dest.h * 4);
    if (isEmpty(dest) || isEmpty(source.bounds)) return out;
    if (!accum) throw new Error("Renderer has no document");
    // Commits are always full quality: at a reduced display level the
    // source is uploaded again at full resolution, just for this.
    device.pushErrorScope("out-of-memory");
    let temporary: FloatingTexture | null = null;
    const uniforms = device.createBuffer({ size: MESH_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    try {
      const f = level === 0 ? floatingTexture(source.tiles, source.bounds) : (temporary = buildFloating(source.tiles, source.bounds, 0));
      const m = meshBuffers(mapping);
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
      // An allocation that failed leaves invalid objects whose output is garbage; the caller falls back to the CPU.
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

    resetLevel() {
      if (level === 0) return;
      setLevel(0);
      const { width, height } = size;
      size = { width: 0, height: 0 };
      if (width) resetDocument(width, height);
    },

    resample,

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
      floating?.texture.destroy();
      mesh?.positions.destroy();
      mesh?.uvs.destroy();
      mesh?.indices.destroy();
      accum?.destroy();
      scratch?.destroy();
      selectionTexture?.destroy();
      atlas.destroy();
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
