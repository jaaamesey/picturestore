import type { Rect } from "../core/geometry";
import type { ShapeSegments } from "../core/shape";

/**
 * GPU vector rasterization: exact-area, non-zero coverage of polygons, the
 * same algorithm as `core/coverage.ts` (its CPU reference) and to within a
 * level per channel of it.
 *
 * Work happens in bands of one tile row:
 *  1. `edges`: one invocation per segment deposits its exact signed-area
 *     contribution into a per-pixel accumulator (fixed point, atomic adds).
 *  2. `sums` / `prefix`: a two-level parallel prefix sum along each row —
 *     per-chunk totals, then an exclusive scan over the chunks.
 *  3. `resolve_*`: each chunk re-scans its pixels from its prefix, turns
 *     winding into coverage, clips the stroke against the fill (inside /
 *     outside alignment), composites stroke over fill and writes straight
 *     RGBA8 — into the tile atlas for display, or a buffer for readback.
 *
 * Integer accumulation makes the row sums exact; the only rounding is each
 * contribution's (2⁻²⁰), far below 8-bit precision.
 */
const CHUNK = 64;
const UNIFORM_SLOT = 256;
const SCALE = 1 << 20;

const COMMON = /* wgsl */ `
const SCALE: f32 = ${SCALE}.0;
const CHUNK: u32 = ${CHUNK}u;
struct Band {
  origin: vec2<f32>,      // the band's top-left in target pixels (segment coordinates are absolute)
  width: u32,             // region width (a multiple of the tile size)
  height: u32,            // band rows
  stride: u32,            // accumulator row stride: width + 2
  mode: u32,              // stroke: 0 none, 1 centre, 2 inside, 3 outside
  slotSize: u32,
  slotsPerSide: u32,
  clip: vec4<i32>,        // band-local x0, y0, x1, y1: pixels outside are written transparent
  fillColor: vec4<f32>,
  strokeColor: vec4<f32>,
  tileRow: u32,           // offset of this band's row in the slot table
  chunks: u32,            // chunks per row
  outBase: u32,           // readback: first pixel of this band in the output buffer
}
@group(0) @binding(0) var<uniform> B: Band;
`;

const EDGES_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var<storage, read> segs: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> acc: array<atomic<i32>>;

fn add(row: i32, x: i32, v: f32) {
  atomicAdd(&acc[u32(row) * B.stride + u32(x)], i32(round(v * SCALE)));
}

// A port of the CPU reference's line(): coordinates are band-local, rows
// outside [0, height) are skipped, x has been clamped to [0, width].
fn line(a0: vec2<f32>, b0: vec2<f32>) {
  var a = a0;
  var b = b0;
  if (a.y == b.y) { return; }
  var dir = 1.0;
  if (a.y > b.y) {
    dir = -1.0;
    let t = a;
    a = b;
    b = t;
  }
  let h = f32(B.height);
  if (b.y <= 0.0 || a.y >= h) { return; }
  let dxdy = (b.x - a.x) / (b.y - a.y);
  var x = a.x;
  var y0 = floor(a.y);
  if (a.y < 0.0) {
    x -= a.y * dxdy;
    y0 = 0.0;
  }
  let yEnd = min(h, ceil(b.y));
  for (var yf = max(0.0, y0); yf < yEnd; yf += 1.0) {
    let row = i32(yf);
    let dy = min(yf + 1.0, b.y) - max(yf, a.y);
    let xnext = x + dxdy * dy;
    let d = dy * dir;
    let xa = min(x, xnext);
    let xb = max(x, xnext);
    let x0f = floor(xa);
    let x0i = i32(x0f);
    let x1i = i32(ceil(xb));
    if (x1i <= x0i + 1) {
      let xmf = 0.5 * (x + xnext) - x0f;
      add(row, x0i, d - d * xmf);
      add(row, x0i + 1, d * xmf);
    } else {
      let s = 1.0 / (xb - xa);
      let x0frac = xa - x0f;
      let a0 = 0.5 * s * (1.0 - x0frac) * (1.0 - x0frac);
      let x1frac = xb - f32(x1i) + 1.0;
      let am = 0.5 * s * x1frac * x1frac;
      add(row, x0i, d * a0);
      if (x1i == x0i + 2) {
        add(row, x0i + 1, d * (1.0 - a0 - am));
      } else {
        let a1 = s * (1.5 - x0frac);
        add(row, x0i + 1, d * (a1 - a0));
        for (var xi = x0i + 2; xi < x1i - 1; xi++) { add(row, xi, d * s); }
        let a2 = a1 + f32(x1i - x0i - 3) * s;
        add(row, x1i - 1, d * (1.0 - a2 - am));
      }
      add(row, x1i, d * am);
    }
    x = xnext;
  }
}

@compute @workgroup_size(64) fn edges(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&segs)) { return; }
  let s = segs[id.x];
  let a = s.xy - B.origin;
  let b = s.zw - B.origin;
  // Skip segments entirely above or below the band.
  if (max(a.y, b.y) <= 0.0 || min(a.y, b.y) >= f32(B.height)) { return; }
  // Split at x = 0 and x = width so clamping never bends a sloped edge:
  // geometry left of the region still counts towards winding at column 0.
  let w = f32(B.width);
  var c0 = 2.0;
  var c1 = 2.0;
  if (a.x * b.x < 0.0) { c0 = -a.x / (b.x - a.x); }
  if ((a.x - w) * (b.x - w) < 0.0) { c1 = (w - a.x) / (b.x - a.x); }
  var ts = array<f32, 4>(0.0, min(min(c0, c1), 1.0), min(max(c0, c1), 1.0), 1.0);
  for (var k = 0; k < 3; k++) {
    let t0 = ts[k];
    let t1 = ts[k + 1];
    if (t1 <= t0) { continue; }
    let p = a + (b - a) * t0;
    let q = a + (b - a) * t1;
    line(vec2<f32>(clamp(p.x, 0.0, w), p.y), vec2<f32>(clamp(q.x, 0.0, w), q.y));
  }
}
`;

const SCAN_WGSL = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var<storage, read> accF: array<i32>;
@group(0) @binding(2) var<storage, read> accS: array<i32>;
@group(0) @binding(3) var<storage, read_write> chunkF: array<i32>;
@group(0) @binding(4) var<storage, read_write> chunkS: array<i32>;

@compute @workgroup_size(8, 8) fn sums(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x;
  let row = id.y;
  if (c >= B.chunks || row >= B.height) { return; }
  var f = 0;
  var s = 0;
  let start = row * B.stride + c * CHUNK;
  let end = row * B.stride + min(B.width, (c + 1u) * CHUNK);
  for (var i = start; i < end; i++) {
    f += accF[i];
    s += accS[i];
  }
  chunkF[row * B.chunks + c] = f;
  chunkS[row * B.chunks + c] = s;
}

@compute @workgroup_size(64) fn prefix(@builtin(global_invocation_id) id: vec3<u32>) {
  let row = id.x;
  if (row >= B.height) { return; }
  var f = 0;
  var s = 0;
  for (var c = 0u; c < B.chunks; c++) {
    let i = row * B.chunks + c;
    let tf = chunkF[i];
    let ts = chunkS[i];
    chunkF[i] = f;
    chunkS[i] = s;
    f += tf;
    s += ts;
  }
}
`;

const RESOLVE_COMMON = /* wgsl */ `
${COMMON}
@group(0) @binding(1) var<storage, read> accF: array<i32>;
@group(0) @binding(2) var<storage, read> accS: array<i32>;
@group(0) @binding(3) var<storage, read> chunkF: array<i32>;
@group(0) @binding(4) var<storage, read> chunkS: array<i32>;

// Stroke over fill, straight alpha: the same compositing as the CPU's paintCoverage.
fn shade(wf: i32, ws: i32) -> vec4<f32> {
  let f = min(1.0, abs(f32(wf)) / SCALE);
  var s = min(1.0, abs(f32(ws)) / SCALE);
  if (B.mode == 0u) { s = 0.0; }
  else if (B.mode == 2u) { s *= f; }
  else if (B.mode == 3u) { s *= 1.0 - f; }
  let fa = f * B.fillColor.a;
  let sa = s * B.strokeColor.a;
  let a = sa + fa * (1.0 - sa);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  return vec4<f32>((B.strokeColor.rgb * sa + B.fillColor.rgb * fa * (1.0 - sa)) / a, a);
}

fn inside(x: u32, row: u32) -> bool {
  let p = vec2<i32>(i32(x), i32(row));
  return all(p >= B.clip.xy) && all(p < B.clip.zw);
}
`;

const RESOLVE_ATLAS_WGSL = /* wgsl */ `
${RESOLVE_COMMON}
@group(1) @binding(0) var atlas: texture_storage_2d_array<rgba8unorm, write>;
@group(1) @binding(1) var<storage, read> slots: array<i32>;

@compute @workgroup_size(8, 8) fn resolve(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x;
  let row = id.y;
  if (c >= B.chunks || row >= B.height) { return; }
  var wf = chunkF[row * B.chunks + c];
  var ws = chunkS[row * B.chunks + c];
  let perPage = B.slotsPerSide * B.slotsPerSide;
  for (var x = c * CHUNK; x < min(B.width, (c + 1u) * CHUNK); x++) {
    wf += accF[row * B.stride + x];
    ws += accS[row * B.stride + x];
    let slot = slots[B.tileRow + x / B.slotSize];
    if (slot < 0) { continue; }
    let local = u32(slot) % perPage;
    let at = vec2<u32>((local % B.slotsPerSide) * B.slotSize + x % B.slotSize, (local / B.slotsPerSide) * B.slotSize + row);
    textureStore(atlas, at, u32(slot) / perPage, select(vec4<f32>(0.0), shade(wf, ws), inside(x, row)));
  }
}
`;

const RESOLVE_BUFFER_WGSL = /* wgsl */ `
${RESOLVE_COMMON}
@group(1) @binding(0) var<storage, read_write> out: array<u32>;

@compute @workgroup_size(8, 8) fn resolve(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x;
  let row = id.y;
  if (c >= B.chunks || row >= B.height) { return; }
  var wf = chunkF[row * B.chunks + c];
  var ws = chunkS[row * B.chunks + c];
  for (var x = c * CHUNK; x < min(B.width, (c + 1u) * CHUNK); x++) {
    wf += accF[row * B.stride + x];
    ws += accS[row * B.stride + x];
    out[B.outBase + row * B.width + x] = select(0u, pack4x8unorm(shade(wf, ws)), inside(x, row));
  }
}
`;

/** Where resolved pixels go. */
export type VectorTarget =
  | {
      readonly kind: "atlas";
      readonly view: GPUTextureView;
      readonly slotSize: number;
      readonly slotsPerSide: number;
      /** Atlas slot per region tile, row-major (−1 = skip). */
      readonly slots: Int32Array;
    }
  | {
      readonly kind: "buffer";
      /** region.w × (bands × band height) packed RGBA8, band by band. */
      readonly buffer: GPUBuffer;
    };

export interface VectorRasterizer {
  /**
   * Encodes the rasterization of `seg` over `region` (target pixels; x and
   * width multiples of `band`), in bands of `band` rows starting at
   * `region.y`. Pixels outside `clip` are written transparent. Call the
   * returned function once the encoder is submitted, to free per-shape buffers.
   */
  encode(encoder: GPUCommandEncoder, seg: ShapeSegments, region: Rect, clip: Rect, band: number, target: VectorTarget): () => void;
  destroy(): void;
}

export function createVectorRasterizer(device: GPUDevice): VectorRasterizer {
  const uniformEntry: GPUBindGroupLayoutEntry = {
    binding: 0,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type: "uniform", hasDynamicOffset: true },
  };
  const buf = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });

  const edgesLayout = device.createBindGroupLayout({ entries: [uniformEntry, buf(1, "read-only-storage"), buf(2, "storage")] });
  const scanLayout = device.createBindGroupLayout({
    entries: [uniformEntry, buf(1, "read-only-storage"), buf(2, "read-only-storage"), buf(3, "storage"), buf(4, "storage")],
  });
  const resolveLayout = device.createBindGroupLayout({
    entries: [uniformEntry, buf(1, "read-only-storage"), buf(2, "read-only-storage"), buf(3, "read-only-storage"), buf(4, "read-only-storage")],
  });
  const atlasLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm", viewDimension: "2d-array" } },
      buf(1, "read-only-storage"),
    ],
  });
  const outLayout = device.createBindGroupLayout({ entries: [buf(0, "storage")] });

  const pipeline = (code: string, entryPoint: string, layouts: GPUBindGroupLayout[]) =>
    device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      compute: { module: device.createShaderModule({ code }), entryPoint },
    });
  const edges = pipeline(EDGES_WGSL, "edges", [edgesLayout]);
  const scanModule = device.createShaderModule({ code: SCAN_WGSL });
  const scanPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [scanLayout] });
  const sums = device.createComputePipeline({ layout: scanPipelineLayout, compute: { module: scanModule, entryPoint: "sums" } });
  const prefix = device.createComputePipeline({ layout: scanPipelineLayout, compute: { module: scanModule, entryPoint: "prefix" } });
  const resolveAtlas = pipeline(RESOLVE_ATLAS_WGSL, "resolve", [resolveLayout, atlasLayout]);
  const resolveBuffer = pipeline(RESOLVE_BUFFER_WGSL, "resolve", [resolveLayout, outLayout]);

  // Scratch, grown on demand and reused across shapes and bands.
  let accF: GPUBuffer | null = null, accS: GPUBuffer | null = null;
  let chunkF: GPUBuffer | null = null, chunkS: GPUBuffer | null = null;
  // Replaced scratch may still be referenced by work encoded but not yet submitted: freed on release.
  let retired: GPUBuffer[] = [];
  const ensure = (b: GPUBuffer | null, size: number) => {
    if (b && b.size >= size) return b;
    if (b) retired.push(b);
    return device.createBuffer({ size: Math.max(256, Math.ceil(size * 1.25 / 256) * 256), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  };

  /** Segments as a storage buffer; an empty path gets one degenerate (skipped) segment. */
  const segmentBuffer = (data: Float32Array) => {
    const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    if (data.byteLength) device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
    return b;
  };

  return {
    encode(encoder, seg, region, clip, band, target) {
      const bands = Math.ceil(region.h / band);
      if (bands <= 0 || region.w <= 0) return () => {};
      const stride = region.w + 2;
      const chunks = Math.ceil(region.w / CHUNK);
      accF = ensure(accF, stride * band * 4);
      accS = ensure(accS, stride * band * 4);
      chunkF = ensure(chunkF, chunks * band * 4);
      chunkS = ensure(chunkS, chunks * band * 4);
      const fill = segmentBuffer(seg.fill);
      const stroke = segmentBuffer(seg.stroke);
      const uniforms = device.createBuffer({ size: bands * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new ArrayBuffer(bands * UNIFORM_SLOT);
      const cols = region.w / (target.kind === "atlas" ? target.slotSize : band);
      for (let i = 0; i < bands; i++) {
        const o = i * UNIFORM_SLOT;
        const y = region.y + i * band;
        const h = Math.min(band, region.y + region.h - y);
        new Float32Array(data, o, 2).set([region.x, y]);
        new Uint32Array(data, o + 8, 6).set([
          region.w,
          h,
          stride,
          seg.strokeMode,
          target.kind === "atlas" ? target.slotSize : band,
          target.kind === "atlas" ? target.slotsPerSide : 0,
        ]);
        new Int32Array(data, o + 32, 4).set([clip.x - region.x, clip.y - y, clip.x + clip.w - region.x, clip.y + clip.h - y]);
        new Float32Array(data, o + 48, 8).set([...seg.fillColor, ...seg.strokeColor]);
        new Uint32Array(data, o + 80, 3).set([i * cols, chunks, i * band * region.w]);
      }
      device.queue.writeBuffer(uniforms, 0, data);

      const u = { buffer: uniforms, size: 96 };
      const fillGroup = device.createBindGroup({ layout: edgesLayout, entries: [{ binding: 0, resource: u }, { binding: 1, resource: { buffer: fill } }, { binding: 2, resource: { buffer: accF } }] });
      const strokeGroup = device.createBindGroup({ layout: edgesLayout, entries: [{ binding: 0, resource: u }, { binding: 1, resource: { buffer: stroke } }, { binding: 2, resource: { buffer: accS } }] });
      const scanGroup = device.createBindGroup({
        layout: scanLayout,
        entries: [{ binding: 0, resource: u }, ...[accF, accS, chunkF, chunkS].map((buffer, k) => ({ binding: k + 1, resource: { buffer } }))],
      });
      const resolveGroup = device.createBindGroup({
        layout: resolveLayout,
        entries: [{ binding: 0, resource: u }, ...[accF, accS, chunkF, chunkS].map((buffer, k) => ({ binding: k + 1, resource: { buffer } }))],
      });
      let outGroup: GPUBindGroup;
      let slotBuffer: GPUBuffer | null = null;
      if (target.kind === "atlas") {
        slotBuffer = device.createBuffer({ size: Math.max(16, target.slots.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(slotBuffer, 0, target.slots as Int32Array<ArrayBuffer>);
        outGroup = device.createBindGroup({ layout: atlasLayout, entries: [{ binding: 0, resource: target.view }, { binding: 1, resource: { buffer: slotBuffer } }] });
      } else {
        outGroup = device.createBindGroup({ layout: outLayout, entries: [{ binding: 0, resource: { buffer: target.buffer } }] });
      }

      const fillCount = Math.max(1, seg.fill.length / 4), strokeCount = Math.max(1, seg.stroke.length / 4);
      for (let i = 0; i < bands; i++) {
        const offset = [i * UNIFORM_SLOT];
        encoder.clearBuffer(accF);
        encoder.clearBuffer(accS);
        const pass = encoder.beginComputePass();
        pass.setPipeline(edges);
        pass.setBindGroup(0, fillGroup, offset);
        pass.dispatchWorkgroups(Math.ceil(fillCount / 64));
        pass.setBindGroup(0, strokeGroup, offset);
        pass.dispatchWorkgroups(Math.ceil(strokeCount / 64));
        pass.end();
        const scan = encoder.beginComputePass();
        scan.setBindGroup(0, scanGroup, offset);
        scan.setPipeline(sums);
        scan.dispatchWorkgroups(Math.ceil(chunks / 8), Math.ceil(band / 8));
        scan.setPipeline(prefix);
        scan.dispatchWorkgroups(Math.ceil(band / 64));
        scan.end();
        const resolve = encoder.beginComputePass();
        resolve.setPipeline(target.kind === "atlas" ? resolveAtlas : resolveBuffer);
        resolve.setBindGroup(0, resolveGroup, offset);
        resolve.setBindGroup(1, outGroup);
        resolve.dispatchWorkgroups(Math.ceil(chunks / 8), Math.ceil(band / 8));
        resolve.end();
      }
      const old = retired;
      retired = [];
      return () => {
        for (const b of old) b.destroy();
        fill.destroy();
        stroke.destroy();
        uniforms.destroy();
        slotBuffer?.destroy();
      };
    },
    destroy() {
      for (const b of [accF, accS, chunkF, chunkS]) b?.destroy();
    },
  };
}
