//! Timeline thumbnails: one PNG holding every thumbnail a lane will ever draw.
//!
//! The editor's timeline wants a picture of the recording at a hundred-odd
//! points along its length. Asking the decoder for those one at a time is the
//! obvious implementation and the wrong one: Media Foundation snaps a seek to
//! the preceding keyframe and then decodes forward to the frame asked for, so
//! an exact seek costs a whole GOP -- 170-280ms on recordings this recorder
//! makes. Three hundred of those is a minute of stall on project open.
//!
//! So the sheet is built in **one sequential pass**. Every frame in the file is
//! decoded; a frame is kept only when its timestamp has reached the next
//! unfilled slot's boundary, and the rest are dropped. Decoding a frame and
//! throwing it away is cheap -- it is the readback off the GPU that is not, and
//! that happens only on the frames that are kept.
//!
//! ```text
//!   decoded   0   33  66  100 133 ... 966 1000 1033 ...
//!   kept      ^                            ^
//!   slot      0                            1
//!   boundary  0ms                          1000ms
//! ```
//!
//! Two things in here are load-bearing and neither is obvious:
//!
//! **Slots fill densely, never sparsely.** If the stream jumps -- a gap in
//! timestamps, a file that starts late -- the next frame goes into the next
//! *unfilled* slot rather than the slot its timestamp points at. A filmstrip
//! with black holes in it reads as a broken decode; one whose thumbnails are a
//! little off in time reads as fine, because nobody checks a 160px thumbnail
//! against a stopwatch.
//!
//! **The buffer is RGBA, the frames arriving are BGRA.** The GPU reads back
//! BGRA and PNG wants RGBA, so the swizzle happens on the way in. Getting it
//! wrong is not a crash; it is a timeline where everyone looks sunburnt.

use std::io::Write;

use windows::core::Result;
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;

use crate::engine::d3d::{self, SharedTexture, Sharing};
use crate::engine::decode::Decoder;
use crate::engine::render::{create_rtv, RenderChain};

pub use crate::engine::sheet::*;

fn failed(message: impl AsRef<str>) -> windows::core::Error {
  windows::core::Error::new(E_FAIL, message)
}

/// Decode `input` end to end and write its filmstrip to `output` as a PNG.
///
/// One sequential pass, no seeking -- see the module header for why. The
/// returned plan is the geometry the PNG was written at, which is what the
/// caller needs to map a timeline position onto a cell.
///
/// **What this deliberately does not draw.** No background, no cursor, no
/// webcam, no zoom. These are thumbnails of the *source*, not of the edit: the
/// timeline shows what was recorded, and rebuilding the sheet every time
/// somebody nudges the padding slider would be absurd.
///
/// Errors, and what each one means:
///
/// * input missing, unreadable, or in a codec Media Foundation has no decoder
///   for -- `Decoder::open` fails and nothing is written.
/// * a decode error partway through -- propagated, and the PNG is *not*
///   written. A half-filled sheet returned as success would be a filmstrip
///   with holes in it that nobody would think to investigate. The frames
///   already captured are thrown away with it.
/// * the file ends before the plan's last slot is filled (Media Foundation
///   over-reports `MF_PD_DURATION` on some containers) -- **not** an error. The
///   trailing cells stay transparent and the plan still describes the full
///   grid, because the PNG was already allocated at that size.
/// * a readback that disagrees with the plan -- a hard error rather than a
///   silently blank sheet, since `Sheet::place` refuses the write and every
///   subsequent slot would refuse it too.
pub fn generate(input: &str, output: &str, budget: SheetBudget) -> Result<SheetPlan> {
  let mut decoder = Decoder::open(input)?;

  let duration_ms = decoder.duration_100ns as f64 / 10_000.0;
  let (display_width, display_height) = decoder.display_size();
  let plan = SheetPlan::for_source(duration_ms, display_width, display_height, budget);

  // The canvas *is* one thumbnail. The chain's NV12->BGRA pass renders at the
  // source's own resolution and then draws that as a quad into the canvas, so
  // asking for a 160px canvas gets the downscale for free off the linear
  // sampler -- no separate resize pass, no readback at full size.
  //
  // One slot: nothing here ever re-renders a frame it has already read back.
  let chain = RenderChain::new(
    decoder.coded_size(),
    decoder.display_size(),
    (plan.cell_width, plan.cell_height),
    1,
  )?;

  let gpu = d3d::gpu()?;
  // `d3d::create_texture` binds SHADER_RESOURCE only, so `create_rtv` on its
  // output fails with E_INVALIDARG. `SharedTexture` already binds
  // RENDER_TARGET alongside it for every non-NV12 format, so it is used here
  // instead of adding a near-duplicate helper to `d3d.rs` for one caller. The
  // cost is one NT handle that nobody imports, closed when this drops.
  let target = SharedTexture::new(
    gpu,
    plan.cell_width,
    plan.cell_height,
    DXGI_FORMAT_B8G8R8A8_UNORM,
    Sharing::Plain,
    None,
  )?;
  let rtv = create_rtv(gpu, &target.texture)?;

  // `RenderChain` rounds its canvas down to even dimensions, because its NV12
  // output path needs that. A plan whose cell is odd -- an unusual aspect ratio
  // or an odd `cell_width` -- therefore renders one row or column short of the
  // target, and that edge keeps the clear colour. The render target stays at
  // the plan's size regardless, because `Sheet::place` measures the buffer it
  // is handed and one stale pixel at the edge of a 160px thumbnail beats
  // refusing to build a sheet at all.
  let mut sheet = Sheet::new(plan);
  let mut captured = 0usize;

  while captured < plan.frame_count {
    let sample = decoder.read_sample()?;
    if sample.end_of_stream {
      break;
    }

    let pts_ms = sample.timestamp_100ns as f64 / 10_000.0;
    let Some(slot) = plan.capture_slot(pts_ms, captured) else {
      // Decoded and dropped. This is the common case and it is what makes the
      // sequential pass cheaper than seeking: no render, no GPU readback.
      continue;
    };

    // `read_sample` only returns `None` for the texture at end of stream, which
    // was handled above -- but skipping rather than unwrapping keeps a decoder
    // that surprises us from taking the whole worker thread down.
    let Some(source) = sample.texture.as_ref() else {
      continue;
    };

    chain.process(0, source, sample.subresource, &rtv)?;
    let pixels = d3d::read_bgra(&target.texture, plan.cell_width, plan.cell_height)?;

    if !sheet.place(slot, &pixels) {
      return Err(failed(format!(
        "readback disagreed with the plan: {} bytes for a {}x{} cell in slot {slot}",
        pixels.len(),
        plan.cell_width,
        plan.cell_height
      )));
    }
    captured += 1;
  }

  write_png(output, &sheet)?;
  Ok(plan)
}

/// Encode a finished sheet to `path` as an RGBA8 PNG.
///
/// Split out only so the buffered-write failure has one place to live: a
/// `BufWriter` swallows its flush error on drop, so a disk that fills up mid
/// encode would leave a truncated PNG and report success. The flush is
/// explicit for that reason.
fn write_png(path: &str, sheet: &Sheet) -> Result<()> {
  let plan = sheet.plan();
  let width = plan.sheet_width();
  let height = plan.sheet_height();

  let image = image::RgbaImage::from_raw(width, height, sheet.pixels().to_vec())
    .ok_or_else(|| failed(format!("a {width}x{height} sheet does not fit its buffer")))?;

  let file = std::fs::File::create(path)
    .map_err(|error| failed(format!("could not create {path}: {error}")))?;
  let mut writer = std::io::BufWriter::new(file);

  image::DynamicImage::ImageRgba8(image)
    .write_to(&mut writer, image::ImageFormat::Png)
    .map_err(|error| failed(format!("could not encode {path}: {error}")))?;

  writer
    .flush()
    .map_err(|error| failed(format!("could not finish writing {path}: {error}")))?;

  Ok(())
}
