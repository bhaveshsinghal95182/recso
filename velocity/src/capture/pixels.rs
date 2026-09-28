//! Pixel-format conversion shared by the camera sources.

pub(crate) fn rgb_to_bgra_bottom_up(rgb: &[u8], width: usize, height: usize) -> Vec<u8> {
  let mut output = vec![0u8; width * height * 4];
  let row_bytes_rgb = width * 3;
  let row_bytes_bgra = width * 4;

  // Iterate over rows in reverse to flip the image bottom-up
  for (y, rgb_row) in rgb.chunks_exact(row_bytes_rgb).enumerate() {
    let dst_y = height - 1 - y;
    let dst_row = &mut output[dst_y * row_bytes_bgra..(dst_y + 1) * row_bytes_bgra];

    // Zip the chunks together to eliminate bounds checking entirely
    for (src_pixel, dst_pixel) in rgb_row.chunks_exact(3).zip(dst_row.chunks_exact_mut(4)) {
      dst_pixel[0] = src_pixel[2]; // B
      dst_pixel[1] = src_pixel[1]; // G
      dst_pixel[2] = src_pixel[0]; // R
      dst_pixel[3] = 255; // A
    }
  }

  output
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rgb_to_bgra_bottom_up_converts_channel_order_and_flips_rows() {
    let width = 1;
    let height = 2;
    // Row 0 (top, decoded order): R=10,G=20,B=30. Row 1 (bottom): R=40,G=50,B=60.
    let rgb = vec![10, 20, 30, 40, 50, 60];
    let bgra = rgb_to_bgra_bottom_up(&rgb, width, height);

    assert_eq!(bgra.len(), width * height * 4);
    // Bottom-up output: row 0 of the output holds the *last* source row.
    assert_eq!(&bgra[0..4], &[60, 50, 40, 255]);
    assert_eq!(&bgra[4..8], &[30, 20, 10, 255]);
  }

  #[test]
  fn rgb_to_bgra_bottom_up_sets_full_opacity_alpha_for_every_pixel() {
    let width = 2;
    let height = 1;
    let rgb = vec![1, 2, 3, 4, 5, 6];
    let bgra = rgb_to_bgra_bottom_up(&rgb, width, height);
    assert_eq!(bgra[3], 255);
    assert_eq!(bgra[7], 255);
  }

  #[test]
  fn rgb_to_bgra_bottom_up_produces_identity_flip_for_single_row() {
    let width = 2;
    let height = 1;
    let rgb = vec![9, 8, 7, 6, 5, 4];
    let bgra = rgb_to_bgra_bottom_up(&rgb, width, height);
    // A single-row image is its own vertical flip.
    assert_eq!(&bgra[0..4], &[7, 8, 9, 255]);
    assert_eq!(&bgra[4..8], &[4, 5, 6, 255]);
  }
}
