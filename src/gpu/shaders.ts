import { BLEND_MODES } from "../core/blend";
import { TILE_SIZE } from "../core/tiles";

/** Atlas page side in texels: 8×8 full-resolution tiles, or more at reduced quality. */
export const ATLAS_PAGE = 8 * TILE_SIZE;

const FULLSCREEN_VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const mode = (name: (typeof BLEND_MODES)[number]) => `${BLEND_MODES.indexOf(name)}u`;

/**
 * Blend functions B(Cb, Cs). Mirrors `core/blend.ts` (the CPU reference) —
 * keep the two in sync; e2e tests compare them.
 */
const BLEND_WGSL = /* wgsl */ `
fn hardLight(b: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  let m = b * 2.0 * s;
  let sc = b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0);
  return select(sc, m, s <= vec3<f32>(0.5));
}

fn softLight(b: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  let d = select(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, b <= vec3<f32>(0.25));
  let lo = b - (1.0 - 2.0 * s) * b * (1.0 - b);
  let hi = b + (2.0 * s - 1.0) * (d - b);
  return select(hi, lo, s <= vec3<f32>(0.5));
}

fn lum(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.3, 0.59, 0.11)); }

fn clipColor(c: vec3<f32>) -> vec3<f32> {
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  var o = c;
  if (n < 0.0) { o = l + (o - l) * l / (l - n); }
  if (x > 1.0) { o = l + (o - l) * (1.0 - l) / (x - l); }
  return o;
}

fn setLum(c: vec3<f32>, l: f32) -> vec3<f32> { return clipColor(c + (l - lum(c))); }

fn sat(c: vec3<f32>) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

fn setSat(c: vec3<f32>, s: f32) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  if (mx <= mn) { return vec3<f32>(0.0); }
  return (c - mn) * s / (mx - mn);
}

fn blend(m: u32, b: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  let one = vec3<f32>(1.0);
  let zero = vec3<f32>(0.0);
  switch m {
    case ${mode("darken")}: { return min(b, s); }
    case ${mode("multiply")}: { return b * s; }
    case ${mode("color burn")}: {
      return select(select(one - min(one, (one - b) / s), zero, s <= zero), one, b >= one);
    }
    case ${mode("linear burn")}: { return max(zero, b + s - 1.0); }
    case ${mode("lighten")}: { return max(b, s); }
    case ${mode("screen")}: { return b + s - b * s; }
    case ${mode("color dodge")}: {
      return select(select(min(one, b / (one - s)), one, s >= one), zero, b <= zero);
    }
    case ${mode("linear dodge")}: { return min(one, b + s); }
    case ${mode("overlay")}: { return hardLight(s, b); }
    case ${mode("soft light")}: { return softLight(b, s); }
    case ${mode("hard light")}: { return hardLight(b, s); }
    case ${mode("difference")}: { return abs(b - s); }
    case ${mode("exclusion")}: { return b + s - 2.0 * b * s; }
    case ${mode("subtract")}: { return max(zero, b - s); }
    case ${mode("divide")}: { return select(min(one, b / s), select(one, zero, b <= zero), s <= zero); }
    case ${mode("hue")}: { return setLum(setSat(s, sat(b)), lum(b)); }
    case ${mode("saturation")}: { return setLum(setSat(b, sat(s)), lum(b)); }
    case ${mode("color")}: { return setLum(s, lum(b)); }
    case ${mode("luminosity")}: { return setLum(b, lum(s)); }
    default: { return s; }
  }
}

/** Source-over with blend mode m: premultiplied s onto premultiplied d. */
fn composite(m: u32, s: vec4<f32>, d: vec4<f32>) -> vec4<f32> {
  if (s.a <= 0.0) { return d; }
  if (m == 0u || d.a <= 0.0) { return s + d * (1.0 - s.a); }
  let cs = s.rgb / s.a;
  let cb = d.rgb / d.a;
  let rgb = cs * s.a * (1.0 - d.a) + blend(m, cb, cs) * s.a * d.a + d.rgb * (1.0 - s.a);
  return vec4<f32>(rgb, s.a + d.a * (1.0 - s.a));
}
`;

/** Clears the scissored area of the accumulator. */
export const CLEAR_WGSL = /* wgsl */ `
${FULLSCREEN_VS}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }
`;

/**
 * Layer compositing: one instanced quad per non-empty tile, sampling the
 * tile atlas. Tiles occupy `slot`² texels (256, or less at reduced quality),
 * and the target is the accumulator at the same scale. Normal-mode layers use fixed-function premultiplied "over"
 * blending (fs_normal); other modes read a copy of the destination (fs_mode).
 * Layer pixels are straight RGBA8; the accumulator is premultiplied rgba16f.
 */
export const tilesWgsl = (slot: number) => {
  const perSide = ATLAS_PAGE / slot;
  return /* wgsl */ `
struct Draw { opacity: f32, mode: u32, docSize: vec2<f32> }
@group(0) @binding(0) var<uniform> D: Draw;
@group(0) @binding(1) var atlas: texture_2d_array<f32>;
@group(0) @binding(2) var dst: texture_2d<f32>;

${BLEND_WGSL}

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) origin: vec2<i32>,
  @location(1) @interpolate(flat) base: vec3<i32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) tile: vec3<i32>) -> VOut {
  var corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let origin = tile.xy * ${slot};
  let local = tile.z % ${perSide * perSide};
  var o: VOut;
  o.origin = origin;
  o.base = vec3<i32>((local % ${perSide}) * ${slot}, (local / ${perSide}) * ${slot}, tile.z / ${perSide * perSide});
  let p = (vec2<f32>(origin) + corners[vi] * ${slot}.0) / D.docSize;
  o.pos = vec4<f32>(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  return o;
}

fn texel(v: VOut) -> vec4<f32> {
  let c = textureLoad(atlas, v.base.xy + vec2<i32>(v.pos.xy) - v.origin, v.base.z, 0);
  return vec4<f32>(c.rgb * c.a, c.a) * D.opacity;
}

@fragment fn fs_normal(v: VOut) -> @location(0) vec4<f32> { return texel(v); }

@fragment fn fs_mode(v: VOut) -> @location(0) vec4<f32> {
  return composite(D.mode, texel(v), textureLoad(dst, vec2<i32>(v.pos.xy), 0));
}
`;
};

/**
 * Floating pixels drawn through a mapping's mesh. Vertex positions are
 * homogeneous (x·w, y·w, w), so the rasterizer's perspective-correct
 * interpolation reproduces the homography exactly. The source is a
 * premultiplied rgba16f texture with a full mip chain.
 *
 * fs_preview*: hardware trilinear sampling for interactive feedback.
 * fs_commit: the final resample, matching `core/rasterize.ts` — per-pixel LOD
 * from derivatives, then nearest / bilinear / Keys bicubic within that level —
 * written out as straight RGBA8.
 */
export const MESH_WGSL = /* wgsl */ `
struct Mesh {
  viewport: vec4<f32>,  // x, y, width, height of the target in document space
  texSize: vec2<f32>,
  opacity: f32,
  mode: u32,
  interp: u32,          // 0 nearest, 1 bilinear, 2 bicubic
  maxLod: f32,
}
@group(0) @binding(0) var<uniform> M: Mesh;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var trilinear: sampler;
@group(0) @binding(3) var dst: texture_2d<f32>;

${BLEND_WGSL}

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex fn vs(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut {
  let v = M.viewport;
  var o: VOut;
  o.pos = vec4<f32>((p.x - v.x * p.z) * 2.0 / v.z - p.z, p.z - (p.y - v.y * p.z) * 2.0 / v.w, 0.0, p.z);
  o.uv = uv;
  return o;
}

@fragment fn fs_preview(v: VOut) -> @location(0) vec4<f32> {
  return textureSample(tex, trilinear, v.uv) * M.opacity;
}

@fragment fn fs_preview_mode(v: VOut) -> @location(0) vec4<f32> {
  let s = textureSample(tex, trilinear, v.uv) * M.opacity;
  return composite(M.mode, s, textureLoad(dst, vec2<i32>(v.pos.xy), 0));
}

fn tap(p: vec2<i32>, size: vec2<i32>, lod: i32) -> vec4<f32> {
  if (any(p < vec2<i32>(0)) || any(p >= size)) { return vec4<f32>(0.0); }
  return textureLoad(tex, p, lod);
}

fn cubic(t: f32) -> f32 {
  let x = abs(t);
  if (x < 1.0) { return (1.5 * x - 2.5) * x * x + 1.0; }
  if (x < 2.0) { return ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0; }
  return 0.0;
}

@fragment fn fs_commit(v: VOut) -> @location(0) vec4<f32> {
  let t = v.uv * M.texSize;
  let dx = dpdx(t);
  let dy = dpdy(t);
  let rho = max(dot(dx, dx), dot(dy, dy));
  var lod = 0;
  if (M.interp != 0u && rho > 1.0) { lod = i32(min(M.maxLod, floor(0.5 * log2(rho)))); }
  let size = vec2<i32>(textureDimensions(tex, lod));
  let f = v.uv * vec2<f32>(size) - 0.5;
  var c = vec4<f32>(0.0);
  if (M.interp == 0u) {
    c = tap(vec2<i32>(round(f)), size, 0);
  } else if (M.interp == 1u) {
    let b = vec2<i32>(floor(f));
    let w = f - floor(f);
    c = mix(mix(tap(b, size, lod), tap(b + vec2<i32>(1, 0), size, lod), w.x),
            mix(tap(b + vec2<i32>(0, 1), size, lod), tap(b + vec2<i32>(1, 1), size, lod), w.x), w.y);
  } else {
    let b = vec2<i32>(floor(f));
    let w = f - floor(f);
    for (var j = 0; j < 4; j++) {
      let wy = cubic(w.y - f32(j - 1));
      for (var i = 0; i < 4; i++) {
        c += tap(b + vec2<i32>(i - 1, j - 1), size, lod) * (cubic(w.x - f32(i - 1)) * wy);
      }
    }
  }
  // Un-premultiply; cubic overshoot is clamped here.
  let a = clamp(c.a, 0.0, 1.0);
  if (a * 255.0 < 0.5) { return vec4<f32>(0.0); }
  return vec4<f32>(clamp(c.rgb / c.a, vec3<f32>(0.0), vec3<f32>(1.0)), a);
}
`;

/** Straight RGBA8 → premultiplied rgba16f (level 0 of a floating texture). */
export const PREMULTIPLY_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${FULLSCREEN_VS}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let c = textureLoad(src, vec2<i32>(pos.xy), 0);
  return vec4<f32>(c.rgb * c.a, c.a);
}
`;

/** Box-filters one mip level of the composite into the next. */
export const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
${FULLSCREEN_VS}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy) * 2;
  let size = vec2<i32>(textureDimensions(src)) - 1;
  return 0.25 * (textureLoad(src, min(p, size), 0) + textureLoad(src, min(p + vec2<i32>(1, 0), size), 0) +
                 textureLoad(src, min(p + vec2<i32>(0, 1), size), 0) + textureLoad(src, min(p + vec2<i32>(1, 1), size), 0));
}
`;

/**
 * Draws the composite into the viewport: pan/zoom, transparency checkerboard,
 * workspace background, and animated "marching ants" around the selection.
 * Ants are found by edge-detecting the selection mask in screen space, so
 * they work for any selection shape at any zoom.
 */
export const PRESENT_WGSL = /* wgsl */ `
struct View {
  docSize: vec2<f32>,
  pan: vec2<f32>,
  zoom: f32,
  time: f32,
  hasSel: u32,
  lod: f32,
  workspace: vec4<f32>,
  /** 1 when the composite is stored below document resolution (GPU memory pressure). */
  reduced: u32,
}
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var composite: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var sel: texture_2d<f32>;

${FULLSCREEN_VS}

fn selected(doc: vec2<f32>) -> bool {
  if (any(doc < vec2<f32>(0.0)) || any(doc >= V.docSize)) { return false; }
  return textureLoad(sel, vec2<i32>(doc), 0).r >= 0.5;
}

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let doc = (pos.xy - V.pan) / V.zoom;
  if (any(doc < vec2<f32>(0.0)) || any(doc >= V.docSize)) { return V.workspace; }

  var c: vec4<f32>;
  if (V.lod <= 0.0 && V.reduced == 0u) {
    c = textureLoad(composite, vec2<i32>(doc), 0);
  } else {
    c = textureSampleLevel(composite, samp, doc / V.docSize, V.lod);
  }
  let cell = vec2<i32>(floor(pos.xy / 8.0));
  let checker = select(1.0, 0.8, ((cell.x + cell.y) & 1) == 1);
  var rgb = c.rgb + checker * (1.0 - c.a);

  if (V.hasSel == 1u) {
    let px = 1.0 / V.zoom;
    let here = selected(doc);
    let edge = here != selected(doc + vec2<f32>(px, 0.0)) || here != selected(doc - vec2<f32>(px, 0.0)) ||
               here != selected(doc + vec2<f32>(0.0, px)) || here != selected(doc - vec2<f32>(0.0, px));
    if (edge) {
      let dash = fract((pos.x + pos.y) / 8.0 - V.time) < 0.5;
      rgb = select(vec3<f32>(1.0), vec3<f32>(0.0), dash);
    }
  }
  return vec4<f32>(rgb, 1.0);
}
`;
