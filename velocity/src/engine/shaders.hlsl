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
  /// How far the pointer travels forward, in the sprite's own uv units, over
  /// the length of tail being drawn. Only `ps_smear` reads it.
  float2 smear;
  /// Half the *shadow's* shape, in pixels. Only `ps_shadow` reads it, and it is
  /// smaller than `half_size_px` because a shadow's quad is grown to hold the
  /// blur that spills outside the shape. Passed rather than derived from the
  /// growth, so the caller can grow the quad by whatever it likes and the
  /// silhouette stays where it was put.
  float2 shadow_half_px;
  /// Half-width of the shadow's edge falloff, in pixels. See `ps_shadow`.
  float  shadow_softness_px;
  float3 _pad1;
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

/// Signed distance to a shape of half-size `half_px`, in pixels. Negative inside.
///
/// Takes the half-size rather than reading `half_size_px` because the shadow
/// draws a shape that is smaller than its own quad.
float shape_distance(float2 local, float2 half_px, float radius) {
  if (shape > 0.5) {
    // Ellipse. Normalising by the half axes turns it into a unit circle, and
    // scaling the result back by the smaller axis keeps the gradient in
    // roughly-pixel units so the same smoothstep width works for both shapes.
    float2 n = local / max(half_px, 1e-4);
    return (length(n) - 1.0) * min(half_px.x, half_px.y);
  }

  // Rounded rectangle: shrink the box by the radius, take the distance to that
  // inner box, then subtract the radius back off.
  float r = clamp(radius, 0.0, min(half_px.x, half_px.y));
  float2 q = abs(local) - (half_px - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

/// Signed distance to the quad's own shape.
float overlay_distance(float2 local) {
  return shape_distance(local, half_size_px, corner_radius_px);
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

/// A drop shadow: the shape's silhouette, blurred, in a flat colour.
///
/// Analytic, not a blur pass. The alternative is the honest one -- draw the
/// silhouette to a scratch target, run a separable Gaussian over it, composite
/// -- which costs three passes and two render targets per shadow layer, and the
/// default webcam style carries three of them. Here the shape is already an
/// exact distance field, and blurring a hard edge is the same as softening the
/// step across it, so the whole thing collapses into one draw with no target.
///
/// The profile is right, not just plausible. A Gaussian-blurred half-plane has
/// alpha `phi(-d / sigma)`, and a smoothstep whose half-width is 1.88 sigma has
/// the same slope through the middle -- within a couple of percent everywhere,
/// which is well under a step of 8-bit alpha. Canvas defines `shadowBlur` as a
/// Gaussian with sigma = blur/2, so the caller passes 0.94 * blur and this
/// matches what the Canvas2D compositor draws.
///
/// The one real difference from a Gaussian is that a smoothstep reaches zero
/// rather than approaching it, which is a feature: the quad can be sized to the
/// exact reach of the falloff with nothing cut off, where a true Gaussian would
/// have to be truncated somewhere and show a faint edge where it was.
float4 ps_shadow(QuadOut i) : SV_Target {
  float d = shape_distance(i.local, shadow_half_px, corner_radius_px);

  // A shadow with no blur is a hard offset silhouette, and a step function
  // aliases. Half a pixel is the same feather the other masks use.
  float w = max(shadow_softness_px, 0.5);
  float a = 1.0 - smoothstep(-w, w, d);

  return float4(tint.rgb, tint.a * opacity * a);
}

/// Cursor sprite: alpha comes from the image, no mask.
float4 ps_sprite(QuadOut i) : SV_Target {
  float4 c = OverlaySource.Sample(samp, i.uv);
  return float4(c.rgb, c.a * opacity);
}

// ---------------------------------------------------------------------------
// Cursor smear
//
// The animator's smear, not a photographic blur: the pointer itself stretched
// along its direction of travel, sharp at the head and streaked out behind.
//
// One draw. The quad is the bounding box of the pointer and the pointer swept
// backwards, and `uv_rect` maps that box back onto the sprite -- so uv (0,0)
// to (1,1) still means the pointer, and everything outside that range is the
// space the tail occupies. Each pixel then marches *forward* along `smear`,
// accumulating what the pointer looked like as it passed through: a pixel
// behind the head sees the pointer that was there a moment ago, and the head
// itself sees only itself.
//
// The alternative is the compositor's approach, drawing the sprite N times
// along the path. That costs N draws and N constant buffer updates to produce
// a chain of discrete ghosts; this costs one draw and reads as a single
// stretched object, which is the look being asked for.
// ---------------------------------------------------------------------------

/// Enough taps that the cap on smear length works out to a couple of pixels
/// between them, which the linear sampler closes up on its own.
#define SMEAR_TAPS 32

float4 ps_smear(QuadOut i) : SV_Target {
  float3 colour = 0.0;
  float  weight = 0.0;
  float  alpha  = 0.0;

  [unroll]
  for (int k = 0; k < SMEAR_TAPS; k++) {
    float  t  = (float)k / (float)(SMEAR_TAPS - 1);
    float2 uv = i.uv + smear * t;

    // The sampler is set to clamp, which would smear the sprite's edge texels
    // down the entire tail as a set of coloured stripes. Outside the image
    // there is no pointer, so there is nothing to contribute.
    float2 in_range = step(0.0, uv) * step(uv, 1.0);
    float  inside   = in_range.x * in_range.y;

    // Quadratic falloff. Linear leaves the tail too solid to read as motion;
    // squaring keeps the head at full strength and thins the rest out fast,
    // which is the heavy blur at the back and the crisp pointer at the front.
    float w = (1.0 - t) * (1.0 - t);

    float4 s = OverlaySource.Sample(samp, uv);
    float  a = s.a * inside * w;

    colour += s.rgb * a;
    weight += a;
    // Max, not sum. The smear is the *union* of the shape as it swept, so
    // overlapping taps must not stack into something more opaque than the
    // pointer itself -- which is what a fast pointer, whose taps all land on
    // the same few texels, would otherwise become.
    alpha = max(alpha, a);
  }

  // Normalised by the weight actually collected, so the colour is the average
  // of what passed through rather than being dragged towards black by the taps
  // that found nothing.
  colour = weight > 0.0 ? colour / weight : 0.0;

  return float4(colour, alpha * opacity);
}
