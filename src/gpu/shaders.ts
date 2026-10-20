import { BLEND_MODES } from "../core/blend";

const FULLSCREEN_VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const mode = (name: (typeof BLEND_MODES)[number]) => `${BLEND_MODES.indexOf(name)}u`;

/**
 * Composites one layer onto the accumulated result. Mirrors `core/blend.ts`
 * (the CPU reference) — keep the two in sync; e2e tests compare them.
 *
 * Layer textures hold straight RGBA8; the accumulator is premultiplied
 * rgba16float. The source is sampled through an inverse affine matrix with
 * bilinear filtering, which degenerates to an exact copy for the identity.
 */
export const COMPOSITE_WGSL = /* wgsl */ `
struct Params {
  m0: vec4<f32>,       // inverse matrix rows: doc pixel -> source texel
  m1: vec4<f32>,
  srcSize: vec2<f32>,
  opacity: f32,
  mode: u32,
  hasDst: u32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_2d<f32>;

${FULLSCREEN_VS}

fn loadSrc(p: vec2<i32>) -> vec4<f32> {
  if (any(p < vec2<i32>(0)) || any(p >= vec2<i32>(P.srcSize))) { return vec4<f32>(0.0); }
  let c = textureLoad(src, p, 0);
  return vec4<f32>(c.rgb * c.a, c.a);
}

fn sampleSrc(doc: vec2<f32>) -> vec4<f32> {
  let h = vec3<f32>(doc, 1.0);
  let s = vec2<f32>(dot(P.m0.xyz, h), dot(P.m1.xyz, h)) - 0.5;
  let f = floor(s);
  let t = s - f;
  let i = vec2<i32>(f);
  let top = mix(loadSrc(i), loadSrc(i + vec2<i32>(1, 0)), t.x);
  let bottom = mix(loadSrc(i + vec2<i32>(0, 1)), loadSrc(i + vec2<i32>(1, 1)), t.x);
  return mix(top, bottom, t.y);
}

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

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  var d = vec4<f32>(0.0);
  if (P.hasDst == 1u) { d = textureLoad(dst, vec2<i32>(pos.xy), 0); }
  let s = sampleSrc(pos.xy) * P.opacity;
  if (s.a <= 0.0) { return d; }
  if (P.mode == 0u || d.a <= 0.0) { return s + d * (1.0 - s.a); }
  let cs = s.rgb / s.a;
  let cb = d.rgb / d.a;
  let rgb = cs * s.a * (1.0 - d.a) + blend(P.mode, cb, cs) * s.a * d.a + d.rgb * (1.0 - s.a);
  return vec4<f32>(rgb, s.a + d.a * (1.0 - s.a));
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
  if (V.lod <= 0.0) {
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
