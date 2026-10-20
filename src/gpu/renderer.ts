import { blendModeIndex, type BlendMode } from "../core/blend";
import type { Layer } from "../core/document";
import { EMPTY_RECT, IDENTITY, intersect, invert, isEmpty, rect, union, type Mat, type Rect } from "../core/geometry";
import type { Mask } from "../core/selection";
import { TILE_SIZE, parseTileKey, tileRect, type Tile, type TileMap } from "../core/tiles";
import { COMPOSITE_WGSL, MIP_WGSL, PRESENT_WGSL } from "./shaders";

/** Pixels drawn through a transform above a given layer (Free Transform / Move preview). */
export interface FloatingLayer {
  readonly tiles: TileMap;
  readonly bounds: Rect;
  readonly matrix: Mat;
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
  /** Reads back the composite as straight RGBA8 (for tests and debugging). */
  readComposite(): Promise<Uint8ClampedArray>;
  destroy(): void;
}

const COMPOSITE_FORMAT: GPUTextureFormat = "rgba16float";
const UNIFORM_STRIDE = 256; // minUniformBufferOffsetAlignment
const PARAMS_SIZE = 64; // sizeof(Params) in COMPOSITE_WGSL
const WORKSPACE = [0.16, 0.16, 0.17, 1];

interface LayerTexture {
  texture: GPUTexture;
  bindGroup: GPUBindGroup;
  /** What was last uploaded per tile key. */
  uploaded: Map<string, { tile: Tile; version: number }>;
  props: string;
}

export async function requestDevice(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error("WebGPU is not supported in this browser.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter is available.");
  return adapter.requestDevice({
    requiredLimits: {
      maxTextureDimension2D: Math.min(16384, adapter.limits.maxTextureDimension2D),
    },
  });
}

export function createRenderer(device: GPUDevice, canvas: HTMLCanvasElement): Renderer {
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const compositeModule = device.createShaderModule({ code: COMPOSITE_WGSL });
  // "auto" layouts can't use dynamic offsets, so declare this one explicitly.
  const compositeLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });
  const compositePipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [compositeLayout] }),
    vertex: { module: compositeModule, entryPoint: "vs" },
    fragment: { module: compositeModule, entryPoint: "fs", targets: [{ format: COMPOSITE_FORMAT }] },
  });

  const mipModule = device.createShaderModule({ code: MIP_WGSL });
  const mipPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: mipModule, entryPoint: "vs" },
    fragment: { module: mipModule, entryPoint: "fs", targets: [{ format: COMPOSITE_FORMAT }] },
  });

  const presentModule = device.createShaderModule({ code: PRESENT_WGSL });
  const presentPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: presentModule, entryPoint: "vs" },
    fragment: { module: presentModule, entryPoint: "fs", targets: [{ format }] },
  });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
  const viewUniforms = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let passUniforms = device.createBuffer({ size: UNIFORM_STRIDE * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const zeroTile = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  const emptyTexture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });

  // Per-document resources, rebuilt when the canvas size changes.
  let size = { width: 0, height: 0 };
  let accum: GPUTexture | null = null;
  let scratch: GPUTexture | null = null;
  let selectionTexture: GPUTexture | null = null;
  let presentBindGroup: GPUBindGroup | null = null;
  let clearBindGroup: GPUBindGroup | null = null;
  let mipCount = 1;
  let mipsDirty = true;
  const layers = new Map<string, LayerTexture>();
  let floatingCache: { source: TileMap; texture: GPUTexture; bindGroup: GPUBindGroup } | null = null;
  let lastOrder = "";
  let lastFloating: FloatingLayer | null = null;
  let lastSelection: Mask | null | undefined = undefined;

  const layerBindGroup = (texture: GPUTexture) =>
    device.createBindGroup({
      layout: compositeLayout,
      entries: [
        { binding: 0, resource: { buffer: passUniforms, size: PARAMS_SIZE } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: accum!.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    });

  function resetDocument(width: number, height: number) {
    for (const l of layers.values()) l.texture.destroy();
    layers.clear();
    floatingCache?.texture.destroy();
    floatingCache = null;
    accum?.destroy();
    scratch?.destroy();
    selectionTexture?.destroy();
    size = { width, height };
    mipCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
    accum = device.createTexture({
      size: [width, height],
      format: COMPOSITE_FORMAT,
      mipLevelCount: mipCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    scratch = device.createTexture({
      size: [width, height],
      format: COMPOSITE_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
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
        { binding: 2, resource: sampler },
        { binding: 3, resource: selectionTexture.createView() },
      ],
    });
    clearBindGroup = layerBindGroup(emptyTexture);
    lastOrder = "";
    lastFloating = null;
    lastSelection = undefined;
  }

  /** Uploads tiles that changed since last time; returns the area that changed. */
  function syncTiles(target: GPUTexture, uploaded: LayerTexture["uploaded"], tiles: TileMap, origin = { x: 0, y: 0 }): Rect {
    const bounds = rect(0, 0, target.width, target.height);
    let dirty = EMPTY_RECT;
    const write = (key: string, data: Uint8Array | Uint8ClampedArray) => {
      const r = tileRect(...parseTileKey(key));
      const part = intersect(rect(r.x - origin.x, r.y - origin.y, r.w, r.h), bounds);
      if (isEmpty(part)) return;
      const ox = part.x - (r.x - origin.x);
      const oy = part.y - (r.y - origin.y);
      device.queue.writeTexture(
        { texture: target, origin: [part.x, part.y] },
        data as Uint8Array<ArrayBuffer>,
        { offset: (oy * TILE_SIZE + ox) * 4, bytesPerRow: TILE_SIZE * 4, rowsPerImage: TILE_SIZE },
        [part.w, part.h],
      );
      dirty = union(dirty, rect(part.x + origin.x, part.y + origin.y, part.w, part.h));
    };
    for (const [key, tile] of tiles) {
      const prev = uploaded.get(key);
      if (prev && prev.tile === tile && prev.version === tile.version) continue;
      write(key, tile.data);
      uploaded.set(key, { tile, version: tile.version });
    }
    for (const key of uploaded.keys()) {
      if (tiles.has(key)) continue;
      write(key, zeroTile);
      uploaded.delete(key);
    }
    return dirty;
  }

  function syncLayers(scene: Scene): Rect {
    let dirty = EMPTY_RECT;
    const full = rect(0, 0, size.width, size.height);
    const seen = new Set<string>();
    for (const layer of scene.layers) {
      seen.add(layer.id);
      let entry = layers.get(layer.id);
      if (!entry) {
        const texture = device.createTexture({
          size: [size.width, size.height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        entry = { texture, bindGroup: layerBindGroup(texture), uploaded: new Map(), props: "" };
        layers.set(layer.id, entry);
      }
      const changed = syncTiles(entry.texture, entry.uploaded, layer.tiles);
      const props = `${layer.visible}|${layer.opacity}|${layer.blendMode}`;
      if (props !== entry.props) {
        entry.props = props;
        dirty = full;
      } else if (layer.visible) {
        dirty = union(dirty, changed);
      }
    }
    for (const [id, entry] of layers) {
      if (seen.has(id)) continue;
      entry.texture.destroy();
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

  function syncFloating(f: FloatingLayer | null): Rect {
    if (f === lastFloating) return EMPTY_RECT;
    lastFloating = f;
    if (!f || isEmpty(f.bounds)) return rect(0, 0, size.width, size.height);
    if (floatingCache?.source !== f.tiles) {
      floatingCache?.texture.destroy();
      const texture = device.createTexture({
        size: [f.bounds.w, f.bounds.h],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      syncTiles(texture, new Map(), f.tiles, f.bounds);
      floatingCache = { source: f.tiles, texture, bindGroup: layerBindGroup(texture) };
    }
    return rect(0, 0, size.width, size.height);
  }

  function syncSelection(sel: Mask | null) {
    if (sel === lastSelection) return;
    lastSelection = sel;
    if (!sel) return;
    device.queue.writeTexture(
      { texture: selectionTexture! },
      sel.data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: sel.width },
      [sel.width, sel.height],
    );
  }

  interface Pass {
    bindGroup: GPUBindGroup;
    matrix: Mat; // doc → source texel
    srcSize: [number, number];
    opacity: number;
    mode: number;
    hasDst: boolean;
  }

  function composite(scene: Scene, area: Rect) {
    const passes: Pass[] = [
      // The first pass just clears the area: zero opacity, no destination.
      { bindGroup: clearBindGroup!, matrix: IDENTITY, srcSize: [1, 1], opacity: 0, mode: 0, hasDst: false },
    ];
    const f = scene.floating;
    const pushFloating = () => {
      if (!f || !floatingCache || isEmpty(f.bounds)) return;
      // Source texel = inverse(matrix) · doc − bounds origin.
      const inv = invert(f.matrix);
      const m: Mat = [inv[0], inv[1], inv[2], inv[3], inv[4] - f.bounds.x, inv[5] - f.bounds.y];
      passes.push({
        bindGroup: floatingCache.bindGroup,
        matrix: m,
        srcSize: [f.bounds.w, f.bounds.h],
        opacity: f.opacity,
        mode: blendModeIndex(f.blendMode),
        hasDst: true,
      });
    };
    for (const layer of scene.layers) {
      const entry = layers.get(layer.id)!;
      if (layer.visible && layer.opacity > 0) {
        passes.push({
          bindGroup: entry.bindGroup,
          matrix: IDENTITY,
          srcSize: [size.width, size.height],
          opacity: layer.opacity,
          mode: blendModeIndex(layer.blendMode),
          hasDst: true,
        });
      }
      if (f && f.aboveLayerId === layer.id) pushFloating();
    }

    if (passUniforms.size < passes.length * UNIFORM_STRIDE) {
      passUniforms.destroy();
      passUniforms = device.createBuffer({
        size: Math.ceil(passes.length * 1.5) * UNIFORM_STRIDE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      // Bind groups reference the uniform buffer, so rebuild them.
      for (const e of layers.values()) e.bindGroup = layerBindGroup(e.texture);
      clearBindGroup = layerBindGroup(emptyTexture);
      if (floatingCache) floatingCache.bindGroup = layerBindGroup(floatingCache.texture);
      return composite(scene, area);
    }

    const data = new ArrayBuffer(passes.length * UNIFORM_STRIDE);
    passes.forEach((p, i) => {
      const [a, b, c, d, e, f] = p.matrix;
      new Float32Array(data, i * UNIFORM_STRIDE, 11).set([a, c, e, 0, b, d, f, 0, ...p.srcSize, p.opacity]);
      new Uint32Array(data, i * UNIFORM_STRIDE + 44, 2).set([p.mode, p.hasDst ? 1 : 0]);
    });
    device.queue.writeBuffer(passUniforms, 0, data);

    const encoder = device.createCommandEncoder();
    const target = scratch!.createView();
    passes.forEach((p, i) => {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }] });
      pass.setPipeline(compositePipeline);
      pass.setBindGroup(0, p.bindGroup, [i * UNIFORM_STRIDE]);
      pass.setScissorRect(area.x, area.y, area.w, area.h);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToTexture(
        { texture: scratch!, origin: [area.x, area.y] },
        { texture: accum!, origin: [area.x, area.y], mipLevel: 0 },
        [area.w, area.h],
      );
    });
    device.queue.submit([encoder.finish()]);
    mipsDirty = true;
  }

  function generateMips() {
    const encoder = device.createCommandEncoder();
    for (let level = 1; level < mipCount; level++) {
      const bindGroup = device.createBindGroup({
        layout: mipPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: accum!.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) }],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: accum!.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: "clear", storeOp: "store" },
        ],
      });
      pass.setPipeline(mipPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    mipsDirty = false;
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
    const lod = zoom >= 1 ? 0 : Math.min(mipCount - 1, Math.log2(1 / zoom));
    if (lod > 0 && mipsDirty) generateMips();
    const u = new ArrayBuffer(64);
    new Float32Array(u, 0, 6).set([size.width, size.height, view.panX * dpr, view.panY * dpr, zoom, time]);
    new Uint32Array(u, 24, 1)[0] = hasSelection ? 1 : 0;
    new Float32Array(u, 28, 1)[0] = lod;
    new Float32Array(u, 32, 4).set(WORKSPACE);
    device.queue.writeBuffer(viewUniforms, 0, u);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store" }],
    });
    pass.setPipeline(presentPipeline);
    pass.setBindGroup(0, presentBindGroup!);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  return {
    render(scene, view, time) {
      if (scene.width !== size.width || scene.height !== size.height) resetDocument(scene.width, scene.height);
      const dirty = union(syncLayers(scene), syncFloating(scene.floating));
      syncSelection(scene.selection);
      const area = intersect(dirty, rect(0, 0, size.width, size.height));
      if (!isEmpty(area)) composite(scene, area);
      present(view, time, scene.selection !== null);
    },

    async readComposite() {
      const { width, height } = size;
      const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
      const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: accum! }, { buffer, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const halves = new Uint16Array(buffer.getMappedRange().slice(0));
      buffer.destroy();
      const out = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const s = (y * bytesPerRow) / 2 + x * 4;
          const a = halfToFloat(halves[s + 3]);
          const o = (y * width + x) * 4;
          if (a <= 0) continue;
          out[o] = Math.round((halfToFloat(halves[s]) / a) * 255);
          out[o + 1] = Math.round((halfToFloat(halves[s + 1]) / a) * 255);
          out[o + 2] = Math.round((halfToFloat(halves[s + 2]) / a) * 255);
          out[o + 3] = Math.round(a * 255);
        }
      }
      return out;
    },

    destroy() {
      resetDocument(1, 1);
      accum?.destroy();
      scratch?.destroy();
      selectionTexture?.destroy();
      passUniforms.destroy();
      viewUniforms.destroy();
      emptyTexture.destroy();
      context.unconfigure();
    },
  };
}

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
