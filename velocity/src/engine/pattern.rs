//! CPU-side test pattern. Only used to seed Test 1's texture.
//!
//! The point is that the image is unmistakably ours: if this exact thing shows
//! up in a renderer canvas, the D3D11 -> shared handle -> VideoFrame path works.

/// 5x7 glyphs, one bit per pixel, MSB-first within each 5-bit row.
const GLYPH_T: [u8; 7] = [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100];
const GLYPH_E: [u8; 7] = [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111];
const GLYPH_S: [u8; 7] = [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110];

/// Build a BGRA test pattern: dark field, thick orange border, "TEST" in the
/// middle, and a magenta marker in the top-left so orientation flips are obvious.
pub fn test_pattern_bgra(width: u32, height: u32, frame: u32) -> Vec<u8> {
  let (w, h) = (width as usize, height as usize);
  let mut buf = vec![0u8; w * h * 4];

  let put = |buf: &mut Vec<u8>, x: usize, y: usize, b: u8, g: u8, r: u8| {
    if x < w && y < h {
      let i = (y * w + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = 255;
    }
  };

  // Background: a gradient, so we'd notice if only a solid colour made it across.
  for y in 0..h {
    for x in 0..w {
      let v = ((x * 40 / w.max(1)) + (y * 40 / h.max(1))) as u8;
      put(&mut buf, x, y, v + 10, v + 8, v + 14);
    }
  }

  // Border, thickness scaled to the smaller dimension.
  let t = (w.min(h) / 24).max(4);
  for y in 0..h {
    for x in 0..w {
      let edge = x < t || y < t || x + t >= w || y + t >= h;
      let inner = (x >= t * 2 && x < t * 3) || (y >= t * 2 && y < t * 3)
        || (x + t * 3 >= w && x + t * 2 < w)
        || (y + t * 3 >= h && y + t * 2 < h);
      if edge {
        put(&mut buf, x, y, 0x3c, 0x81, 0xf0); // BGRA of #f0813c
      } else if inner && (x > t && y > t && x + t < w && y + t < h) {
        put(&mut buf, x, y, 0x28, 0x50, 0x90);
      }
    }
  }

  // "TEST", centred, scaled to fit roughly half the width.
  let glyphs = [&GLYPH_T, &GLYPH_E, &GLYPH_S, &GLYPH_T];
  let scale = ((w / 2) / (glyphs.len() * 6)).max(2);
  let text_w = glyphs.len() * 6 * scale - scale;
  let text_h = 7 * scale;
  let ox = (w - text_w) / 2;
  let oy = (h - text_h) / 2;

  for (gi, glyph) in glyphs.iter().enumerate() {
    for (row, bits) in glyph.iter().enumerate() {
      for col in 0..5 {
        if bits & (1 << (4 - col)) != 0 {
          for dy in 0..scale {
            for dx in 0..scale {
              put(
                &mut buf,
                ox + (gi * 6 + col) * scale + dx,
                oy + row * scale + dy,
                255,
                255,
                255,
              );
            }
          }
        }
      }
    }
  }

  // Frame counter as a moving block, so an animated source is visibly animating
  // rather than a single stuck frame.
  let bx = (frame as usize * 7) % w.saturating_sub(t * 2).max(1);
  for y in 0..t {
    for x in 0..t {
      put(&mut buf, t + bx + x, h - t * 2 + y, 0xff, 0x00, 0xff);
    }
  }

  buf
}

/// Build an NV12 test pattern: full-size Y plane followed by a half-height
/// interleaved UV plane, which is the layout D3D11 expects for a single NV12
/// subresource.
///
/// Encoders take NV12, so a BGRA pattern would need a conversion pass we would
/// then be testing instead of the encoder.
pub fn test_pattern_nv12(width: u32, height: u32, frame: u32) -> Vec<u8> {
  let (w, h) = (width as usize, height as usize);
  let mut buf = vec![0u8; w * h + w * (h / 2)];

  // Luma: gradient background, bright border, moving bar.
  let bar = (frame as usize * 11) % w;
  for y in 0..h {
    for x in 0..w {
      let border = x < 16 || y < 16 || x + 16 >= w || y + 16 >= h;
      let in_bar = x.abs_diff(bar) < 24;
      buf[y * w + x] = if border {
        235
      } else if in_bar {
        200
      } else {
        // 16..=235 is the studio-swing luma range; staying inside it avoids
        // clipping that would look like an encoder bug.
        (16 + ((x * 120 / w) + (y * 90 / h))) as u8
      };
    }
  }

  // Chroma: quadrants of distinct colour so a plane swap or half-height mistake
  // is immediately visible rather than subtly wrong.
  let uv = w * h;
  for cy in 0..h / 2 {
    for cx in 0..w / 2 {
      let right = cx >= w / 4;
      let bottom = cy >= h / 4;
      // Four clearly different (U,V) pairs. The exact hues do not matter; what
      // matters is that four distinct quadrants survive the round trip, which
      // catches plane swaps and half-height mistakes.
      let (u, v) = match (right, bottom) {
        (false, false) => (90, 130),
        (true, false) => (128, 200),
        (false, true) => (100, 90),
        (true, true) => (128, 128),
      };
      let i = uv + cy * w + cx * 2;
      buf[i] = u;
      buf[i + 1] = v;
    }
  }

  buf
}
