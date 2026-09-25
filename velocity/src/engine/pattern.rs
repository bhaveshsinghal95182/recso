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
  // Saturating: a surface narrower than the word leaves nowhere to centre it,
  // and `put` already clips, so the text runs off the edge rather than the
  // subtraction wrapping and taking the process with it.
  let ox = w.saturating_sub(text_w) / 2;
  let oy = h.saturating_sub(text_h) / 2;

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
      put(&mut buf, t + bx + x, h.saturating_sub(t * 2) + y, 0xff, 0x00, 0xff);
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
  // `.max(1)` so a zero-width surface is an empty buffer rather than a
  // divide by zero. The loops below do not run at that size anyway.
  let bar = (frame as usize * 11) % w.max(1);
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

#[cfg(test)]
mod bgra_pattern_scenarios {
  use super::*;

  /// BGRA of the border colour, #f0813c.
  const BORDER: [u8; 3] = [0x3c, 0x81, 0xf0];

  fn pixel(buf: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
    let i = (y * w + x) * 4;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
  }

  #[test]
  fn the_buffer_is_four_bytes_a_pixel() {
    for (w, h) in [(64u32, 64u32), (320, 240), (1920, 1080), (1, 1)] {
      let buf = test_pattern_bgra(w, h, 0);
      assert_eq!(buf.len(), w as usize * h as usize * 4, "{w}x{h}");
    }
  }

  #[test]
  fn a_surface_with_no_pixels_gives_an_empty_buffer() {
    assert!(test_pattern_bgra(0, 0, 0).is_empty());
    assert!(test_pattern_bgra(0, 100, 0).is_empty());
    assert!(test_pattern_bgra(100, 0, 0).is_empty());
  }

  #[test]
  fn a_surface_too_small_for_the_word_still_renders() {
    // `TestPatternSource::new` takes its size straight from JS, so a small one
    // has to clip rather than abort the process.
    for size in 1..48u32 {
      let buf = test_pattern_bgra(size, size, 0);
      assert_eq!(buf.len(), size as usize * size as usize * 4, "{size}");
    }
  }

  #[test]
  fn a_very_wide_thin_surface_renders() {
    let buf = test_pattern_bgra(2000, 3, 0);
    assert_eq!(buf.len(), 2000 * 3 * 4);
  }

  #[test]
  fn a_very_tall_thin_surface_renders() {
    let buf = test_pattern_bgra(3, 2000, 0);
    assert_eq!(buf.len(), 3 * 2000 * 4);
  }

  #[test]
  fn every_pixel_is_opaque() {
    // The gradient pass writes the whole surface, so nothing is left at the
    // zeroed alpha the buffer starts with -- a transparent pattern would look
    // like a failed upload rather than a failed pattern.
    let buf = test_pattern_bgra(128, 96, 0);
    for i in (3..buf.len()).step_by(4) {
      assert_eq!(buf[i], 255, "byte {i}");
    }
  }

  #[test]
  fn the_border_reaches_the_top_left_corner() {
    let buf = test_pattern_bgra(256, 256, 0);
    let p = pixel(&buf, 256, 0, 0);
    assert_eq!([p[0], p[1], p[2]], BORDER);
  }

  #[test]
  fn the_border_reaches_every_corner() {
    let (w, h) = (256usize, 192usize);
    let buf = test_pattern_bgra(w as u32, h as u32, 0);
    for (x, y) in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)] {
      let p = pixel(&buf, w, x, y);
      assert_eq!([p[0], p[1], p[2]], BORDER, "({x},{y})");
    }
  }

  #[test]
  fn the_border_runs_along_every_edge() {
    let (w, h) = (256usize, 192usize);
    let buf = test_pattern_bgra(w as u32, h as u32, 0);
    for x in (0..w).step_by(7) {
      assert_eq!(&pixel(&buf, w, x, 0)[..3], BORDER, "top {x}");
      assert_eq!(&pixel(&buf, w, x, h - 1)[..3], BORDER, "bottom {x}");
    }
    for y in (0..h).step_by(7) {
      assert_eq!(&pixel(&buf, w, 0, y)[..3], BORDER, "left {y}");
      assert_eq!(&pixel(&buf, w, w - 1, y)[..3], BORDER, "right {y}");
    }
  }

  #[test]
  fn the_middle_is_not_the_border_colour() {
    let (w, h) = (256usize, 192usize);
    let buf = test_pattern_bgra(w as u32, h as u32, 0);
    let p = pixel(&buf, w, w / 2, h / 4);
    assert_ne!([p[0], p[1], p[2]], BORDER);
  }

  #[test]
  fn the_word_is_drawn_in_white() {
    // Somewhere in the middle band there has to be a fully white pixel, or the
    // glyph pass did nothing.
    let (w, h) = (512usize, 384usize);
    let buf = test_pattern_bgra(w as u32, h as u32, 0);
    let found = (h / 3..h * 2 / 3).any(|y| {
      (0..w).any(|x| {
        let p = pixel(&buf, w, x, y);
        p[0] == 255 && p[1] == 255 && p[2] == 255
      })
    });
    assert!(found);
  }

  #[test]
  fn the_background_is_a_gradient_rather_than_a_flat_fill() {
    // A solid colour surviving the upload would prove much less than a
    // gradient does.
    let (w, h) = (512usize, 384usize);
    let buf = test_pattern_bgra(w as u32, h as u32, 0);
    let near = pixel(&buf, w, w / 2, h / 4);
    let far = pixel(&buf, w, w / 2, h * 3 / 4);
    assert_ne!(near, far);
  }

  #[test]
  fn the_frame_counter_moves_the_marker() {
    let (w, h) = (256usize, 192usize);
    let a = test_pattern_bgra(w as u32, h as u32, 0);
    let b = test_pattern_bgra(w as u32, h as u32, 5);
    assert_ne!(a, b);
  }

  #[test]
  fn the_same_frame_always_renders_the_same_pattern() {
    let a = test_pattern_bgra(128, 96, 7);
    let b = test_pattern_bgra(128, 96, 7);
    assert_eq!(a, b);
  }

  #[test]
  fn a_magenta_marker_appears_somewhere() {
    let (w, h) = (256usize, 192usize);
    let buf = test_pattern_bgra(w as u32, h as u32, 3);
    let found = (0..h).any(|y| {
      (0..w).any(|x| {
        let p = pixel(&buf, w, x, y);
        p[0] == 0xff && p[1] == 0x00 && p[2] == 0xff
      })
    });
    assert!(found);
  }

  #[test]
  fn a_large_frame_number_does_not_run_off_the_surface() {
    for frame in [0u32, 1, 1000, 100_000, u32::MAX] {
      let buf = test_pattern_bgra(256, 192, frame);
      assert_eq!(buf.len(), 256 * 192 * 4, "{frame}");
    }
  }
}

#[cfg(test)]
mod nv12_pattern_scenarios {
  use super::*;

  #[test]
  fn the_buffer_holds_a_full_luma_plane_and_a_half_height_chroma_plane() {
    for (w, h) in [(64u32, 64u32), (320, 240), (1920, 1080)] {
      let buf = test_pattern_nv12(w, h, 0);
      let (w, h) = (w as usize, h as usize);
      assert_eq!(buf.len(), w * h + w * (h / 2), "{w}x{h}");
    }
  }

  #[test]
  fn a_surface_with_no_pixels_gives_an_empty_buffer() {
    assert!(test_pattern_nv12(0, 0, 0).is_empty());
    assert!(test_pattern_nv12(0, 480, 0).is_empty());
  }

  #[test]
  fn a_zero_width_surface_does_not_divide_by_zero() {
    // The moving bar's position is a modulo of the width.
    for frame in [0u32, 1, 999] {
      assert!(test_pattern_nv12(0, 480, frame).is_empty(), "{frame}");
    }
  }

  #[test]
  fn an_odd_height_rounds_the_chroma_plane_down() {
    let buf = test_pattern_nv12(64, 65, 0);
    assert_eq!(buf.len(), 64 * 65 + 64 * 32);
  }

  #[test]
  fn the_luma_stays_inside_the_studio_swing_range() {
    // Going outside 16..=235 would clip in a way that reads as an encoder bug.
    let buf = test_pattern_nv12(320, 240, 0);
    for (i, value) in buf[..320 * 240].iter().enumerate() {
      assert!((16..=235).contains(value), "luma {i}: {value}");
    }
  }

  #[test]
  fn the_luma_border_is_bright() {
    let (w, h) = (320usize, 240usize);
    let buf = test_pattern_nv12(w as u32, h as u32, 0);
    assert_eq!(buf[0], 235);
    assert_eq!(buf[w - 1], 235);
    assert_eq!(buf[(h - 1) * w], 235);
    assert_eq!(buf[h * w - 1], 235);
  }

  #[test]
  fn the_luma_border_runs_along_the_top_and_bottom() {
    let (w, h) = (320usize, 240usize);
    let buf = test_pattern_nv12(w as u32, h as u32, 0);
    for x in (0..w).step_by(11) {
      assert_eq!(buf[x], 235, "top {x}");
      assert_eq!(buf[(h - 1) * w + x], 235, "bottom {x}");
    }
  }

  #[test]
  fn the_chroma_plane_has_four_distinct_quadrants() {
    // A plane swap or a half-height mistake shows up here immediately.
    let (w, h) = (320usize, 240usize);
    let buf = test_pattern_nv12(w as u32, h as u32, 0);
    let uv = w * h;
    let at = |cx: usize, cy: usize| {
      let i = uv + cy * w + cx * 2;
      (buf[i], buf[i + 1])
    };
    let quadrants = [
      at(w / 8, h / 8),
      at(w * 3 / 8, h / 8),
      at(w / 8, h * 3 / 8),
      at(w * 3 / 8, h * 3 / 8),
    ];
    for (i, a) in quadrants.iter().enumerate() {
      for (j, b) in quadrants.iter().enumerate() {
        if i != j {
          assert_ne!(a, b, "quadrant {i} matches {j}");
        }
      }
    }
  }

  #[test]
  fn the_chroma_quadrants_are_the_documented_pairs() {
    let (w, h) = (320usize, 240usize);
    let buf = test_pattern_nv12(w as u32, h as u32, 0);
    let uv = w * h;
    let at = |cx: usize, cy: usize| {
      let i = uv + cy * w + cx * 2;
      (buf[i], buf[i + 1])
    };
    assert_eq!(at(w / 8, h / 8), (90, 130));
    assert_eq!(at(w * 3 / 8, h / 8), (128, 200));
    assert_eq!(at(w / 8, h * 3 / 8), (100, 90));
    assert_eq!(at(w * 3 / 8, h * 3 / 8), (128, 128));
  }

  #[test]
  fn the_frame_counter_moves_the_bar() {
    let a = test_pattern_nv12(320, 240, 0);
    let b = test_pattern_nv12(320, 240, 9);
    assert_ne!(a, b);
  }

  #[test]
  fn the_same_frame_always_renders_the_same_pattern() {
    assert_eq!(
      test_pattern_nv12(320, 240, 4),
      test_pattern_nv12(320, 240, 4)
    );
  }

  #[test]
  fn a_large_frame_number_does_not_run_off_the_surface() {
    for frame in [0u32, 1, 100_000, u32::MAX] {
      let buf = test_pattern_nv12(320, 240, frame);
      assert_eq!(buf.len(), 320 * 240 + 320 * 120, "{frame}");
    }
  }

  #[test]
  fn a_small_surface_still_renders() {
    for size in [2u32, 4, 8, 16, 32, 33] {
      let buf = test_pattern_nv12(size, size, 0);
      let s = size as usize;
      assert_eq!(buf.len(), s * s + s * (s / 2), "{size}");
    }
  }
}
