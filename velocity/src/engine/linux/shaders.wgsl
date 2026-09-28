// The Windows chain's fullscreen conversion and overlay passes, with I420 input.
struct VertexOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) local: vec2<f32> }
struct Overlay { rect_ndc: vec4<f32>, half_size_px: vec2<f32>, corner_radius_px: f32, shape: f32, opacity: f32, brightness: f32, contrast: f32, saturation: f32, uv_rect: vec4<f32>, tint: vec4<f32>, smear: vec2<f32>, shadow_half_px: vec2<f32>, shadow_softness_px: f32, _pad1: vec3<f32> }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var plane_y: texture_2d<f32>;
@group(0) @binding(2) var plane_u: texture_2d<f32>;
@group(0) @binding(3) var plane_v: texture_2d<f32>;
@group(1) @binding(0) var<uniform> overlay: Overlay;
@group(1) @binding(1) var overlay_source: texture_2d<f32>;
@vertex fn vs_fullscreen(@builtin(vertex_index) id: u32) -> VertexOut {
  let uv = vec2<f32>(f32((id << 1u) & 2u), f32(id & 2u));
  var o: VertexOut;
  o.uv = uv; o.local = vec2<f32>(0.0);
  o.pos = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  return o;
}
@fragment fn ps_i420_to_rgba(i: VertexOut) -> @location(0) vec4<f32> {
  let y = textureSample(plane_y, samp, i.uv).r;
  let u = textureSample(plane_u, samp, i.uv).r;
  let v = textureSample(plane_v, samp, i.uv).r;
  let yy = (y - 16.0 / 255.0) * (255.0 / 219.0);
  let cb = (u - 128.0 / 255.0) * (255.0 / 224.0);
  let cr = (v - 128.0 / 255.0) * (255.0 / 224.0);
  return vec4<f32>(clamp(vec3<f32>(yy + 1.5748 * cr, yy - 0.1873 * cb - 0.4681 * cr, yy + 1.8556 * cb), vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
@vertex fn vs_quad(@builtin(vertex_index) id: u32) -> VertexOut {
  let uv = vec2<f32>(f32(id & 1u), f32((id >> 1u) & 1u));
  var o: VertexOut;
  o.uv = uv * overlay.uv_rect.xy + overlay.uv_rect.zw;
  o.pos = vec4<f32>(mix(overlay.rect_ndc.x, overlay.rect_ndc.z, uv.x), mix(overlay.rect_ndc.y, overlay.rect_ndc.w, uv.y), 0.0, 1.0);
  o.local = (uv - vec2<f32>(0.5)) * 2.0 * overlay.half_size_px;
  return o;
}
fn shape_distance(local: vec2<f32>, half_px: vec2<f32>, radius: f32) -> f32 {
  if overlay.shape > 0.5 {
    let n = local / max(half_px, vec2<f32>(0.0001));
    return (length(n) - 1.0) * min(half_px.x, half_px.y);
  }
  let r = clamp(radius, 0.0, min(half_px.x, half_px.y));
  let q = abs(local) - (half_px - vec2<f32>(r));
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn overlay_distance(local: vec2<f32>) -> f32 { return shape_distance(local, overlay.half_size_px, overlay.corner_radius_px); }
fn apply_grade(source: vec3<f32>) -> vec3<f32> {
  let c = (source - vec3<f32>(0.5)) * overlay.contrast + vec3<f32>(0.5 + overlay.brightness);
  let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  return clamp(mix(vec3<f32>(l), c, overlay.saturation), vec3<f32>(0.0), vec3<f32>(1.0));
}
@fragment fn ps_overlay(i: VertexOut) -> @location(0) vec4<f32> {
  let c = apply_grade(textureSample(overlay_source, samp, i.uv).rgb);
  let a = overlay.opacity * clamp(0.5 - overlay_distance(i.local), 0.0, 1.0);
  return vec4<f32>(c, a);
}
@fragment fn ps_solid(i: VertexOut) -> @location(0) vec4<f32> {
  return vec4<f32>(overlay.tint.rgb, overlay.tint.a * overlay.opacity * clamp(0.5 - overlay_distance(i.local), 0.0, 1.0));
}
@fragment fn ps_shadow(i: VertexOut) -> @location(0) vec4<f32> {
  let d = shape_distance(i.local, overlay.shadow_half_px, overlay.corner_radius_px);
  let w = max(overlay.shadow_softness_px, 0.5);
  return vec4<f32>(overlay.tint.rgb, overlay.tint.a * overlay.opacity * (1.0 - smoothstep(-w, w, d)));
}
@fragment fn ps_sprite(i: VertexOut) -> @location(0) vec4<f32> {
  let c = textureSample(overlay_source, samp, i.uv);
  return vec4<f32>(c.rgb, c.a * overlay.opacity);
}
@fragment fn ps_smear(i: VertexOut) -> @location(0) vec4<f32> {
  var colour = vec3<f32>(0.0);
  var weight = 0.0;
  var alpha = 0.0;
  {
    let t = 0.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 1.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 2.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 3.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 4.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 5.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 6.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 7.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 8.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 9.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 10.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 11.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 12.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 13.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 14.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 15.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 16.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 17.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 18.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 19.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 20.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 21.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 22.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 23.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 24.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 25.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 26.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 27.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 28.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 29.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 30.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  {
    let t = 31.0 / 31.0;
    let uv = i.uv + overlay.smear * t;
    let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    let w = (1.0 - t) * (1.0 - t);
    let s = textureSampleLevel(overlay_source, samp, uv, 0.0);
    let a = s.a * inside * w;
    colour += s.rgb * a;
    weight += a;
    alpha = max(alpha, a);
  }
  if weight > 0.0 { colour /= weight; }
  return vec4<f32>(colour, alpha * overlay.opacity);
}
