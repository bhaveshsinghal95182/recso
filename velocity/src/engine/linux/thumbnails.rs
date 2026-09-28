//! Timeline thumbnails are sampled during one sequential decode pass.
//!
//! Seeking once per cell repeats GOP decoding. Keeping only frames that cross
//! the next slot boundary fills cells densely while decoding the source once.
//! OpenH264 yields RGBA, whereas the shared sheet accepts BGRA and swizzles it
//! back to RGBA, so the resized cell is swapped before placement.

use std::io::Write;
use crate::engine::sheet::{Sheet, SheetBudget, SheetPlan};
use super::media::VideoSource;

/// Decode `input` once and write its planned filmstrip to `output` as PNG.
pub(super) fn generate(input: &str, output: &str, budget: SheetBudget)
  -> Result<(SheetPlan, f64), String> {
  let mut source = VideoSource::open(input)?;
  let info = source.info();
  let plan = SheetPlan::for_source(info.duration_ms, info.width, info.height, budget);
  let mut sheet = Sheet::new(plan);
  let mut captured = 0;
  while let Some(frame) = source.next_frame()? {
    let Some(slot) = plan.capture_slot(frame.pts_ms, captured) else { continue };
    let image = image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
      .ok_or_else(|| format!("decoded frame at {} ms has invalid RGBA size", frame.pts_ms))?;
    let resized = image::imageops::resize(&image, plan.cell_width, plan.cell_height,
      image::imageops::FilterType::Triangle);
    let mut bgra = resized.into_raw();
    for pixel in bgra.chunks_exact_mut(4) { pixel.swap(0, 2); }
    if !sheet.place(slot, &bgra) {
      return Err(format!("resized frame disagreed with the {}x{} sheet cell",
        plan.cell_width, plan.cell_height));
    }
    captured += 1;
  }
  write_png(output, &sheet)?;
  Ok((plan, info.duration_ms))
}

fn write_png(path: &str, sheet: &Sheet) -> Result<(), String> {
  let plan = sheet.plan();
  let width = plan.sheet_width();
  let height = plan.sheet_height();
  let image = image::RgbaImage::from_raw(width, height, sheet.pixels().to_vec())
    .ok_or_else(|| format!("a {width}x{height} sheet does not fit its buffer"))?;
  let file = std::fs::File::create(path)
    .map_err(|error| format!("could not create {path}: {error}"))?;
  let mut writer = std::io::BufWriter::new(file);
  image::DynamicImage::ImageRgba8(image)
    .write_to(&mut writer, image::ImageFormat::Png)
    .map_err(|error| format!("could not encode {path}: {error}"))?;
  writer.flush().map_err(|error| format!("could not finish writing {path}: {error}"))?;
  Ok(())
}

#[cfg(test)]
mod sampling_scenarios {
  use super::*;
  use crate::engine::linux::media::fixtures::{path, recording};
  #[test]
  fn sheet_has_planned_geometry_and_different_colours_after_one_second() {
    let fixture = recording(false);
    let output = path("sheet", "png");
    let (plan, duration) = generate(fixture.0.to_str().unwrap(), output.to_str().unwrap(),
      SheetBudget::default()).unwrap();
    assert!((duration - 3000.0).abs() < 100.0);
    assert_eq!(plan.frame_count, 3);
    let png = image::open(&output).unwrap().to_rgba8();
    let _ = std::fs::remove_file(output);
    assert_eq!(png.dimensions(), (plan.columns * plan.cell_width,
      plan.rows * plan.cell_height));
    let first = png.get_pixel(plan.cell_width / 2, plan.cell_height / 2);
    let second = png.get_pixel(plan.cell_width + plan.cell_width / 2,
      plan.cell_height / 2);
    assert_ne!(first.0[..3], second.0[..3]);
  }
}
