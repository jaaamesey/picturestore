import { BLEND_MODES } from "../core/blend";
import { TILE_SIZE } from "../core/pixels";

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

/**
 * Premultiplied s onto premultiplied d with blend mode m: source-over, or
 * source-atop when \`atop\` (d keeps its alpha; how clipped layers blend).
 */
fn composite(m: u32, s: vec4<f32>, d: vec4<f32>, atop: bool) -> vec4<f32> {
  if (s.a <= 0.0) { return d; }
  if (d.a <= 0.0) { return select(s, d, atop); }
  let cs = s.rgb / s.a;
  let cb = d.rgb / d.a;
  let mixed = select(blend(m, cb, cs), cs, m == 0u) * s.a * d.a + d.rgb * (1.0 - s.a);
  if (atop) { return vec4<f32>(mixed, d.a); }
  return vec4<f32>(cs * s.a * (1.0 - d.a) + mixed, s.a + d.a * (1.0 - s.a));
}
`;

/** Draw flags shared by the compositing shaders. */
export const ATOP = 1;
export const MASK_A = 2;
export const MASK_B = 4;

/**
 * Layer mask coverage: the product of up to two mask textures (the layer's
 * own and, for layers clipped to an adjustment layer, its base's), each
 * rendered at composite resolution.
 */
const coverageWgsl = (a: number, b: number) => /* wgsl */ `
@group(0) @binding(${a}) var maskA: texture_2d<f32>;
@group(0) @binding(${b}) var maskB: texture_2d<f32>;
fn coverage(p: vec2<i32>, flags: u32) -> f32 {
  var k = 1.0;
  if ((flags & ${MASK_A}u) != 0u) { k *= textureLoad(maskA, p, 0).r; }
  if ((flags & ${MASK_B}u) != 0u) { k *= textureLoad(maskB, p, 0).r; }
  return k;
}
`;

/** Fills the scissored area of a target with one value (clearing a surface; a mask's background). */
export const fillWgsl = (v: number) => /* wgsl */ `
${FULLSCREEN_VS}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(${v.toFixed(1)}); }
`;

/** Adjustment program kinds, as \`fs_adjust\` switches on them. */
export const ADJUST_KINDS = ["curves", "hue-saturation", "vibrance", "selective-color", "black-white", "channel-mixer", "lut3d"] as const;

/**
 * Whole-surface compositing steps, per pixel of the scissored area:
 *
 * - fs_layer_src / fs_layer: a surface (an isolated group, a clipping
 *   group) blended onto the target like a layer: fixed-function over/atop
 *   in Normal mode, else reading a copy of the target (\`dst\`).
 * - fs_lerp: a pass-through group's opacity and mask: from the backdrop
 *   before it (\`src\`) to after it (\`dst\`).
 * - fs_apply_mask: multiplies the target by mask coverage (blended dst × src.a).
 * - fs_adjust: an adjustment layer: \`dst\`'s colours through the program,
 *   blended back with the layer's mode, opacity and mask, keeping alpha.
 *   Mirrors \`applyProgram\` in \`core/adjustments.ts\`.
 */
export const COMPOSE_WGSL = /* wgsl */ `
struct Step { opacity: f32, mode: u32, flags: u32, kind: u32, p: array<vec4<f32>, 15> }
@group(0) @binding(0) var<uniform> U: Step;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_2d<f32>;
${coverageWgsl(3, 4)}
@group(0) @binding(5) var lut: texture_2d<f32>;
@group(0) @binding(6) var lut3: texture_3d<f32>;

${BLEND_WGSL}
${FULLSCREEN_VS}

fn P(i: u32) -> f32 { return U.p[i / 4u][i % 4u]; }
fn k(p: vec2<i32>) -> f32 { return U.opacity * coverage(p, U.flags); }

@fragment fn fs_layer_src(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  return textureLoad(src, p, 0) * k(p);
}

@fragment fn fs_layer(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  return composite(U.mode, textureLoad(src, p, 0) * k(p), textureLoad(dst, p, 0), (U.flags & ${ATOP}u) != 0u);
}

@fragment fn fs_lerp(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  return mix(textureLoad(src, p, 0), textureLoad(dst, p, 0), k(p));
}

@fragment fn fs_apply_mask(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(coverage(vec2<i32>(pos.xy), U.flags));
}

const PI = 3.14159265358979;

fn rgbToHsl(c: vec3<f32>) -> vec3<f32> {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let l = (mx + mn) * 0.5;
  if (mx == mn) { return vec3<f32>(0.0, 0.0, l); }
  let d = mx - mn;
  let s = select(d / (mx + mn), d / (2.0 - mx - mn), l > 0.5);
  var h: f32;
  if (mx == c.r) { h = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
  else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
  else { h = (c.r - c.g) / d + 4.0; }
  return vec3<f32>(h / 6.0, s, l);
}

fn hueToRgb(p: f32, q: f32, t0: f32) -> f32 {
  var t = t0;
  if (t < 0.0) { t += 1.0; }
  if (t > 1.0) { t -= 1.0; }
  if (t < 1.0 / 6.0) { return p + (q - p) * 6.0 * t; }
  if (t < 0.5) { return q; }
  if (t < 2.0 / 3.0) { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
  return p;
}

fn hslToRgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  if (s == 0.0) { return vec3<f32>(l); }
  let q = select(l + s - l * s, l * (1.0 + s), l < 0.5);
  let p = 2.0 * l - q;
  return vec3<f32>(hueToRgb(p, q, h + 1.0 / 3.0), hueToRgb(p, q, h), hueToRgb(p, q, h - 1.0 / 3.0));
}

fn hueWeight(h: f32, centre: f32) -> f32 {
  var d = centre - h;
  if (abs(d - 1.0) < abs(d)) { d -= 1.0; } else if (abs(d + 1.0) < abs(d)) { d += 1.0; }
  let e = d * 6.0;
  return clamp(select(1.0 - e, 1.0 + e, e < 0.0), 0.0, 1.0);
}

fn lutAt(i: i32) -> vec4<f32> { return textureLoad(lut, vec2<i32>(i, 0), 0); }

/** Linear lookup in the LUT texture's curves (one per channel). */
fn curve(v: vec3<f32>, n: f32) -> vec3<f32> {
  var o: vec3<f32>;
  for (var c = 0; c < 3; c++) {
    let p = clamp(v[c], 0.0, 1.0) * (n - 1.0);
    let i = min(n - 2.0, floor(p));
    o[c] = mix(lutAt(i32(i))[c], lutAt(i32(i) + 1)[c], p - i);
  }
  return o;
}

fn satCurve(s: f32) -> f32 { return select(pow(tan(PI / 2.0 * min(s, 0.9999)), 1.3), s, s < 0.0); }

fn adjust(c: vec3<f32>) -> vec3<f32> {
  switch U.kind {
    case 0u: {
      var x = c;
      if (P(0u) != 0.0) { x = vec3<f32>(lum(c)); }
      var o = curve(x, P(2u));
      if (P(1u) != 0.0) {
        let before = lum(x);
        let after = lum(o);
        if (before > after) { o += (before - after) / (1.0 - after) * (1.0 - o); }
        else if (after == 0.0) { o = vec3<f32>(0.0); }
        else { o *= before / after; }
      }
      return o;
    }
    case 1u: {
      let n = P(3u) - 1.0;
      let pos = rgbToHsl(c).x * n;
      let i = min(n, floor(pos));
      let j = min(n, i + 1.0);
      let m = mix(lutAt(i32(i)), lutAt(i32(j)), pos - floor(pos));
      let kk = abs(m.z);
      let towards = select(min(c.r, min(c.g, c.b)), max(c.r, max(c.g, c.b)), m.z > 0.0);
      let x = (P(0u) + P(1u) * kk * towards) + P(1u) * (1.0 - kk) * c;
      let hsl = rgbToHsl(x);
      let colorize = P(2u) != 0.0;
      let s = select(min(hsl.y * (1.0 + satCurve(m.y)), 1.0), m.y, colorize);
      let h = select(hsl.x + m.x, m.x, colorize);
      return hslToRgb(fract(h), max(0.0, s), hsl.z);
    }
    case 2u: {
      let e = 2.4;
      let l = pow(c, vec3<f32>(e));
      let y = dot(l, vec3<f32>(0.299, 0.587, 0.114)) * P(0u);
      let u = dot(l, vec3<f32>(-0.147, -0.289, 0.436)) * P(1u);
      let v = dot(l, vec3<f32>(0.615, -0.515, -0.1)) * P(1u);
      let o = clamp(vec3<f32>(y + 1.13983 * v, y - 0.39465 * u - 0.5806 * v, y + 2.03211 * u), vec3<f32>(0.0), vec3<f32>(1.0));
      return pow(o, vec3<f32>(1.0 / e));
    }
    case 3u: {
      let hsl = rgbToHsl(c);
      let mx = max(c.r, max(c.g, c.b));
      let mn = min(c.r, min(c.g, c.b));
      let cmy = 1.0 - c;
      var delta = vec3<f32>(0.0);
      for (var r = 0u; r < 9u; r++) {
        var w: f32;
        if (r < 6u) { w = hueWeight(hsl.x, f32(r) / 6.0) * hsl.y * 2.0 * min(hsl.z, 1.0 - hsl.z); }
        else if (r == 6u) { w = max(0.0, mn - 0.5) * 2.0; }
        else if (r == 7u) { w = 1.0 - (abs(mx - 0.5) + abs(mn - 0.5)); }
        else { w = max(0.0, 0.5 - mx) * 2.0; }
        let o = r * 6u;
        let mul = vec3<f32>(P(o), P(o + 1u), P(o + 2u));
        let add = vec3<f32>(P(o + 3u), P(o + 4u), P(o + 5u));
        delta += (clamp(cmy * mul + add, vec3<f32>(0.0), vec3<f32>(1.0)) - cmy) * w;
      }
      return 1.0 - clamp(cmy + delta, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    case 4u: {
      let hsl = rgbToHsl(c);
      var n = 0.0;
      for (var r = 0u; r < 6u; r++) { n += min(1.0, 1.7 * (1.0 - hsl.z)) * hsl.y * P(r) * hueWeight(hsl.x, f32(r) / 6.0); }
      let gray = clamp(hsl.z * (1.0 + n), 0.0, 1.0);
      if (P(6u) == 0.0) { return vec3<f32>(gray); }
      let hueLuma = P(8u);
      let chroma = P(9u);
      var l: f32;
      if (gray < P(10u)) { l = gray * (0.5 / hueLuma); }
      else if (gray < P(11u)) { l = gray + chroma * (0.5 - hueLuma); }
      else { l = 1.0 - (1.0 - gray) * 0.5 / (1.0 - hueLuma); }
      let s = min(1.0, chroma + 3.0 * chroma * abs(gray - 0.5 * (P(10u) + P(11u))));
      return hslToRgb(P(7u), s, clamp(l, 0.0, 1.0));
    }
    case 5u: {
      let r = vec4<f32>(c, 1.0);
      return clamp(vec3<f32>(dot(r, U.p[0]), dot(r, U.p[1]), dot(r, U.p[2])), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    default: {
      let s = i32(P(0u));
      let f = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0)) * f32(s - 1);
      let b = min(vec3<i32>(s - 2), vec3<i32>(floor(f)));
      let t = f - vec3<f32>(b);
      var o = vec3<f32>(0.0);
      for (var z = 0; z < 2; z++) {
        for (var y = 0; y < 2; y++) {
          for (var x = 0; x < 2; x++) {
            let w = select(1.0 - t.x, t.x, x == 1) * select(1.0 - t.y, t.y, y == 1) * select(1.0 - t.z, t.z, z == 1);
            o += textureLoad(lut3, b + vec3<i32>(x, y, z), 0).rgb * w;
          }
        }
      }
      return o;
    }
  }
}

/** An adjustment applied to straight RGBA8 pixels (Image ▸ Adjustments), within coverage A (the selection). */
@fragment fn fs_adjust_pixels(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  let s = textureLoad(src, p, 0);
  if (s.a <= 0.0) { return s; }
  let a = adjust(s.rgb);
  return vec4<f32>(mix(s.rgb, a, k(p)), s.a);
}

@fragment fn fs_adjust(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(pos.xy);
  let d = textureLoad(dst, p, 0);
  if (d.a <= 0.0) { return d; }
  let c = d.rgb / d.a;
  let a = adjust(c);
  let r = select(blend(U.mode, c, a), a, U.mode == 0u);
  return vec4<f32>(mix(c, r, k(p)) * d.a, d.a);
}
`;

/**
 * Layer compositing: one instanced quad per non-empty tile, sampling the
 * tile atlas. Tiles occupy `slot`² texels (256, or less at reduced quality),
 * and the target is a composite surface at the same scale. Normal mode uses
 * fixed-function premultiplied "over" (or "atop") blending (fs_normal);
 * other modes read a copy of the destination (fs_mode). fs_mask draws a
 * layer mask's tiles (grey over the mask's background) into a coverage
 * texture. Layer pixels are straight RGBA8; surfaces are premultiplied rgba16f.
 */
export const tilesWgsl = (slot: number) => {
  const perSide = ATLAS_PAGE / slot;
  return /* wgsl */ `
// offset: where the layer's tiles are drawn relative to their grid, in composite pixels (a shape being moved).
struct Draw { opacity: f32, mode: u32, docSize: vec2<f32>, offset: vec2<i32>, flags: u32 }
@group(0) @binding(0) var<uniform> D: Draw;
@group(0) @binding(1) var atlas: texture_2d_array<f32>;
@group(0) @binding(2) var dst: texture_2d<f32>;
${coverageWgsl(3, 4)}
${BLEND_WGSL}

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) origin: vec2<i32>,
  @location(1) @interpolate(flat) base: vec3<i32>,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) tile: vec3<i32>) -> VOut {
  var corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0));
  let origin = tile.xy * ${slot} + D.offset;
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
  return vec4<f32>(c.rgb * c.a, c.a);
}

fn layerTexel(v: VOut) -> vec4<f32> { return texel(v) * (D.opacity * coverage(vec2<i32>(v.pos.xy), D.flags)); }

@fragment fn fs_normal(v: VOut) -> @location(0) vec4<f32> { return layerTexel(v); }

@fragment fn fs_mode(v: VOut) -> @location(0) vec4<f32> {
  return composite(D.mode, layerTexel(v), textureLoad(dst, vec2<i32>(v.pos.xy), 0), (D.flags & ${ATOP}u) != 0u);
}

@fragment fn fs_mask(v: VOut) -> @location(0) vec4<f32> { return texel(v); }
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
  flags: u32,
}
@group(0) @binding(0) var<uniform> M: Mesh;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var trilinear: sampler;
@group(0) @binding(3) var dst: texture_2d<f32>;
${coverageWgsl(4, 5)}
${BLEND_WGSL}

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }

@vertex fn vs(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>) -> VOut {
  let v = M.viewport;
  var o: VOut;
  o.pos = vec4<f32>((p.x - v.x * p.z) * 2.0 / v.z - p.z, p.z - (p.y - v.y * p.z) * 2.0 / v.w, 0.0, p.z);
  o.uv = uv;
  return o;
}

fn previewTexel(v: VOut) -> vec4<f32> {
  return textureSample(tex, trilinear, v.uv) * (M.opacity * coverage(vec2<i32>(v.pos.xy), M.flags));
}

@fragment fn fs_preview(v: VOut) -> @location(0) vec4<f32> { return previewTexel(v); }

@fragment fn fs_preview_mode(v: VOut) -> @location(0) vec4<f32> {
  return composite(M.mode, previewTexel(v), textureLoad(dst, vec2<i32>(v.pos.xy), 0), (M.flags & ${ATOP}u) != 0u);
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
  /** The view's rotation (cos, sin). */
  rot: vec2<f32>,
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
  let d = (pos.xy - V.pan) / V.zoom;
  let doc = vec2<f32>(V.rot.x * d.x + V.rot.y * d.y, -V.rot.y * d.x + V.rot.x * d.y);
  if (any(doc < vec2<f32>(0.0)) || any(doc >= V.docSize)) { return V.workspace; }

  var c: vec4<f32>;
  // Rotated views sample (bilinear) rather than pick a texel.
  if (V.lod <= 0.0 && V.reduced == 0u && V.rot.y == 0.0) {
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
