// Fullscreen passes for the render layer.
//
// No vertex buffer: the VS builds a triangle that covers the screen from
// SV_VertexID, so a pass is Draw(3, 0) with a null input layout.

struct VSOut {
  float4 pos : SV_POSITION;
  float2 uv  : TEXCOORD0;
};

VSOut vs_fullscreen(uint id : SV_VertexID) {
  VSOut o;
  // ids 0,1,2 -> uv (0,0), (2,0), (0,2): one oversized triangle, clipped to the
  // viewport. Cheaper than a quad and avoids the diagonal seam.
  float2 uv = float2((id << 1) & 2, id & 2);
  o.uv = uv;
  o.pos = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
  return o;
}

SamplerState samp : register(s0);

// ---------------------------------------------------------------------------
// NV12 -> BGRA
//
// The Y plane comes in as R8 and the UV plane as R8G8 at half resolution; the
// sampler handles the chroma upsampling. Values are studio swing (16-235 luma,
// 16-240 chroma) and BT.709 primaries, which is what H.264 from a screen
// recorder or a camera gives you.
// ---------------------------------------------------------------------------
Texture2D<float>  PlaneY  : register(t0);
Texture2D<float2> PlaneUV : register(t1);

float4 ps_nv12_to_bgra(VSOut i) : SV_Target {
  float  y  = PlaneY.Sample(samp, i.uv);
  float2 uv = PlaneUV.Sample(samp, i.uv);

  float yy = (y - 16.0 / 255.0) * (255.0 / 219.0);
  float cb = (uv.x - 128.0 / 255.0) * (255.0 / 224.0);
  float cr = (uv.y - 128.0 / 255.0) * (255.0 / 224.0);

  float3 rgb = float3(
    yy + 1.5748 * cr,
    yy - 0.1873 * cb - 0.4681 * cr,
    yy + 1.8556 * cb);

  return float4(saturate(rgb), 1.0);
}

// ---------------------------------------------------------------------------
// Constants for the fullscreen passes.
//
// Grading does not live here. It used to: one fullscreen pass over the finished
// frame, which is why it could only ever apply to one layer. It now rides in the
// overlay constant buffer instead, so every layer carries its own -- see
// `apply_grade` below.
// ---------------------------------------------------------------------------
cbuffer Params : register(b0) {
  float2 texel;        // 1/width, 1/height of the source
  float2 _pad0;
};

Texture2D<float4> Source : register(t0);

// ---------------------------------------------------------------------------
// BGRA -> NV12
//
// The encoder wants NV12, so the chain converts back on the way out rather than
// letting the sink writer insert its own video processor. Owning both
// directions means the round trip uses one matrix, and there is no hidden MFT
// in the export path.
//
// Two passes, because NV12 is planar: Y at full resolution into an R8 view of
// plane 0, and interleaved CbCr at half resolution into an R8G8 view of plane 1.
// ---------------------------------------------------------------------------

float3 rgb_to_ycbcr(float3 c) {
  float y  = dot(c, float3(0.2126, 0.7152, 0.0722));
  float cb = (c.b - y) / 1.8556;
  float cr = (c.r - y) / 1.5748;

  // Back to studio swing, matching what ps_nv12_to_bgra expanded.
  return float3(
    y  * (219.0 / 255.0) + 16.0 / 255.0,
    cb * (224.0 / 255.0) + 128.0 / 255.0,
    cr * (224.0 / 255.0) + 128.0 / 255.0);
}

float ps_bgra_to_y(VSOut i) : SV_Target {
  return rgb_to_ycbcr(Source.Sample(samp, i.uv).rgb).x;
}

float2 ps_bgra_to_uv(VSOut i) : SV_Target {
  // This pass runs at half resolution, so one output texel covers a 2x2 block.
  // Averaging those four explicitly beats relying on the sampler, which would
  // just pick a bilinear blend of whichever two it lands between.
  float2 o = texel * 0.5;
  float3 c = Source.Sample(samp, i.uv + float2(-o.x, -o.y)).rgb
           + Source.Sample(samp, i.uv + float2( o.x, -o.y)).rgb
           + Source.Sample(samp, i.uv + float2(-o.x,  o.y)).rgb
           + Source.Sample(samp, i.uv + float2( o.x,  o.y)).rgb;

  return rgb_to_ycbcr(c * 0.25).yz;
}

// ---------------------------------------------------------------------------
// Overlay quads: webcam and cursor.
//
// The passes above are fullscreen. These are not -- they draw into a rectangle
// of the destination, so they need a real quad and a blend state. Still no
// vertex buffer: the rect comes in through the cbuffer and the VS builds the
// corners from SV_VertexID as a triangle strip, so a draw is Draw(4, 0).
//
// `local` carries the pixel offset from the quad's centre, which is what the
// rounded-rect and circle masks are evaluated in. Doing the mask in pixels
// rather than UV keeps corners circular regardless of the quad's aspect ratio.
// ---------------------------------------------------------------------------
cbuffer Overlay : register(b1) {
  float4 rect_ndc;         // x0, y0, x1, y1 in clip space
  float2 half_size_px;     // half the quad's size, in destination pixels
  float  corner_radius_px; // 0 for a hard rectangle
  float  shape;            // 0 = rounded rect, 1 = ellipse
  float  opacity;          // 0..1, multiplied into alpha
  /// This quad's own grade. Per-layer rather than one pass over the finished
  /// frame: the screen recording and the camera are two different sensors with
  /// two different exposures, and a single grade can only trade one against the
  /// other. Identity is (0, 1, 1).
  float  brightness;
  float  contrast;
  float  saturation;
  /// Sub-rectangle of the source to draw: xy scales the quad's uv, zw offsets
  /// it. Identity is (1, 1, 0, 0). This is how the webcam is fitted to a box
  /// whose aspect ratio does not match the camera's -- the quad stays the size
  /// it was asked for and the *source* is cropped, so nothing is stretched.
  /// It is also how the video layer leaves its macroblock padding behind.
  float4 uv_rect;
  /// Fill colour for `ps_solid`, which draws borders. Ignored by the textured
  /// shaders.
  float4 tint;
};

struct QuadOut {
  float4 pos   : SV_POSITION;
  float2 uv    : TEXCOORD0;
  float2 local : TEXCOORD1;
};

QuadOut vs_quad(uint id : SV_VertexID) {
  QuadOut o;
  // Strip order: (0,0), (1,0), (0,1), (1,1).
  float2 uv = float2(id & 1, (id >> 1) & 1);
  o.uv = uv * uv_rect.xy + uv_rect.zw;
  o.pos = float4(lerp(rect_ndc.x, rect_ndc.z, uv.x),
                 lerp(rect_ndc.y, rect_ndc.w, uv.y), 0.0, 1.0);
  // -half..+half across the quad.
  o.local = (uv - 0.5) * 2.0 * half_size_px;
  return o;
}

Texture2D<float4> OverlaySource : register(t0);

/// Signed distance to the quad's shape, in pixels. Negative inside.
float overlay_distance(float2 local) {
  if (shape > 0.5) {
    // Ellipse. Normalising by the half axes turns it into a unit circle, and
    // scaling the result back by the smaller axis keeps the gradient in
    // roughly-pixel units so the same smoothstep width works for both shapes.
    float2 n = local / max(half_size_px, 1e-4);
    return (length(n) - 1.0) * min(half_size_px.x, half_size_px.y);
  }

  // Rounded rectangle: shrink the box by the radius, take the distance to that
  // inner box, then subtract the radius back off.
  float r = clamp(corner_radius_px, 0.0, min(half_size_px.x, half_size_px.y));
  float2 q = abs(local) - (half_size_px - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

/// Webcam overlay: opaque source, shape comes from the mask.
/// The grade, shared by every layer that has one.
float3 apply_grade(float3 c) {
  c = (c - 0.5) * contrast + 0.5 + brightness;

  // Rec.709 luma, so desaturating does not shift perceived brightness.
  float l = dot(c, float3(0.2126, 0.7152, 0.0722));
  return saturate(lerp(float3(l, l, l), c, saturation));
}

float4 ps_overlay(QuadOut i) : SV_Target {
  float3 c = apply_grade(OverlaySource.Sample(samp, i.uv).rgb);

  // One pixel of feather. Without it a circular webcam has visibly stepped
  // edges at any size the user would actually pick.
  float d = overlay_distance(i.local);
  float a = opacity * saturate(0.5 - d);

  return float4(c, a);
}

/// An untextured quad in a flat colour, masked to the same shape.
///
/// This is the border under the video and the webcam: the same rounded rect,
/// grown by the border width and filled, with the layer drawn over the top.
float4 ps_solid(QuadOut i) : SV_Target {
  float d = overlay_distance(i.local);
  return float4(tint.rgb, tint.a * opacity * saturate(0.5 - d));
}

/// Cursor sprite: alpha comes from the image, no mask.
float4 ps_sprite(QuadOut i) : SV_Target {
  float4 c = OverlaySource.Sample(samp, i.uv);
  return float4(c.rgb, c.a * opacity);
}
