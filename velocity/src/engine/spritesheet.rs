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

/// How much sheet a caller is willing to pay for.
///
/// The frame cap is what keeps a long recording from producing an enormous
/// PNG. At the default it tops out at 1600x2700, which no browser has trouble
/// decoding -- Chromium's limit is an order of magnitude away.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SheetBudget {
  /// Hard ceiling on frames in the sheet, however long the recording is.
  pub max_frames: usize,
  /// How wide one thumbnail is. Height follows the source's aspect ratio.
  pub cell_width: u32,
  /// How many cells sit side by side before the sheet wraps to a new row.
  pub max_columns: u32,
}

impl Default for SheetBudget {
  fn default() -> Self {
    Self {
      max_frames: 300,
      cell_width: 160,
      max_columns: 10,
    }
  }
}

/// One thumbnail a second, until the frame cap says otherwise.
const BASE_INTERVAL_MS: f64 = 1000.0;

/// The geometry of a sheet, worked out before a single frame is decoded.
///
/// Everything downstream -- how big the PNG is, which frame goes where, which
/// cell the timeline reads for a given instant -- comes from this, so it is
/// settled once and then only read.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SheetPlan {
  /// How many thumbnails the sheet holds. Never zero: a recording too short
  /// for a single interval still gets one frame, because a lane with no
  /// filmstrip at all looks like a failure rather than a very short clip.
  pub frame_count: usize,
  /// Milliseconds between one thumbnail and the next.
  pub interval_ms: f64,
  pub cell_width: u32,
  pub cell_height: u32,
  pub columns: u32,
  pub rows: u32,
}

impl SheetPlan {
  /// Work out a sheet's geometry from the recording it is describing.
  ///
  /// `duration_ms` may be zero and the source dimensions may be nonsense --
  /// both happen on a recording recovered after a crash -- and neither is
  /// allowed to produce a plan that cannot be allocated.
  pub fn for_source(
    duration_ms: f64,
    src_width: u32,
    src_height: u32,
    budget: SheetBudget,
  ) -> Self {
    let duration_ms = duration_ms.max(0.0);

    // How many thumbnails a bare one-a-second interval would want. Zero when
    // the recording is empty -- that case is handled separately below rather
    // than folded into the scaling math, since a zero-length recording has no
    // "raw" interval to scale.
    let raw_count = if duration_ms <= 0.0 {
      0
    } else {
      (duration_ms / BASE_INTERVAL_MS).ceil() as usize
    };

    let (frame_count, interval_ms) = if raw_count == 0 {
      (1, BASE_INTERVAL_MS)
    } else {
      // Stretch the interval just enough that the frame cap is respected --
      // never more, because a wider interval than necessary throws away
      // thumbnails the budget could have afforded.
      let factor = ((raw_count as f64) / (budget.max_frames as f64))
        .ceil()
        .max(1.0);
      let interval_ms = BASE_INTERVAL_MS * factor;
      let frame_count = (duration_ms / interval_ms).ceil().max(1.0) as usize;
      (frame_count, interval_ms)
    };

    // A recovered recording can report zero for either dimension. Fall back
    // to a 16:9 guess rather than producing a zero-sized (unallocatable) cell.
    let (aspect_width, aspect_height) = if src_width == 0 || src_height == 0 {
      (16, 9)
    } else {
      (src_width, src_height)
    };

    let cell_width = budget.cell_width.max(1);
    let cell_height = ((cell_width as f64 * aspect_height as f64 / aspect_width as f64).round()
      as u32)
      .max(1);

    // frame_count is at least 1, so this is always at least 1 too -- no
    // padding to a full row when the recording is short.
    let columns = frame_count.min(budget.max_columns as usize) as u32;
    let rows = (frame_count as u32 + columns - 1) / columns;

    SheetPlan {
      frame_count,
      interval_ms,
      cell_width,
      cell_height,
      columns,
      rows,
    }
  }

  /// Which slot this decoded frame should fill, if any.
  ///
  /// `captured` is how many slots are already full, so it is also the index of
  /// the next one. A frame qualifies once its timestamp has reached that
  /// slot's boundary; frames arriving before it are dropped, and so are all
  /// frames once the sheet is full.
  pub fn capture_slot(&self, timestamp_ms: f64, captured: usize) -> Option<usize> {
    if captured >= self.frame_count {
      return None;
    }
    let boundary_ms = captured as f64 * self.interval_ms;
    if timestamp_ms >= boundary_ms {
      Some(captured)
    } else {
      None
    }
  }

  /// Width of the finished PNG, in pixels.
  pub fn sheet_width(&self) -> u32 {
    self.columns * self.cell_width
  }

  /// Height of the finished PNG, in pixels.
  pub fn sheet_height(&self) -> u32 {
    self.rows * self.cell_height
  }
}

/// A sheet being filled in, one cell at a time.
///
/// Allocated up front at its full size and written into by slot, so a decode
/// that dies partway through still leaves a valid image -- the unfilled cells
/// are transparent rather than missing.
pub struct Sheet {
  plan: SheetPlan,
  pixels: Vec<u8>,
}

impl Sheet {
  /// Allocate a transparent sheet the plan's size.
  pub fn new(plan: SheetPlan) -> Self {
    let width = plan.sheet_width() as usize;
    let height = plan.sheet_height() as usize;
    let pixels = vec![0u8; width * height * 4];
    Self { plan, pixels }
  }

  pub fn plan(&self) -> SheetPlan {
    self.plan
  }

  /// Copy one decoded thumbnail into its cell, swizzling BGRA to RGBA.
  ///
  /// `cell_bgra` must be exactly `cell_width * cell_height * 4` bytes. Returns
  /// false and writes nothing if it is not, or if the slot is outside the
  /// plan -- a short buffer means the readback disagreed with the plan, and
  /// tiling it anyway would smear one row of pixels into the next cell.
  pub fn place(&mut self, slot: usize, cell_bgra: &[u8]) -> bool {
    if slot >= self.plan.frame_count {
      return false;
    }

    let cell_width = self.plan.cell_width as usize;
    let cell_height = self.plan.cell_height as usize;
    if cell_bgra.len() != cell_width * cell_height * 4 {
      return false;
    }

    let sheet_width = self.plan.sheet_width() as usize;
    let columns = self.plan.columns as usize;
    let dest_x0 = (slot % columns) * cell_width;
    let dest_y0 = (slot / columns) * cell_height;

    // A cell is contiguous in the source buffer but its rows land
    // `sheet_width * 4` bytes apart in the sheet, so each row is copied on
    // its own -- and byte-swapped per pixel, since the source is BGRA and the
    // sheet is RGBA.
    for y in 0..cell_height {
      let src_row = y * cell_width * 4;
      let dest_row = ((dest_y0 + y) * sheet_width + dest_x0) * 4;
      for x in 0..cell_width {
        let src_i = src_row + x * 4;
        let dest_i = dest_row + x * 4;
        self.pixels[dest_i] = cell_bgra[src_i + 2];
        self.pixels[dest_i + 1] = cell_bgra[src_i + 1];
        self.pixels[dest_i + 2] = cell_bgra[src_i];
        self.pixels[dest_i + 3] = cell_bgra[src_i + 3];
      }
    }

    true
  }

  /// The finished buffer, RGBA, `sheet_width * sheet_height * 4` bytes.
  pub fn pixels(&self) -> &[u8] {
    &self.pixels
  }
}

/// Everything above this line is arithmetic. Everything below it decodes a real
/// file on a real GPU and writes a real PNG.

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

#[cfg(test)]
mod plan_scenarios {
  use super::*;

  fn budget() -> SheetBudget {
    SheetBudget::default()
  }

  #[test]
  fn a_one_minute_recording_gets_a_thumbnail_a_second() {
    let plan = SheetPlan::for_source(60_000.0, 1920, 1080, budget());
    assert_eq!(plan.frame_count, 60);
    assert_eq!(plan.interval_ms, 1000.0);
  }

  #[test]
  fn a_sixteen_by_nine_source_gets_sixteen_by_nine_cells() {
    // 160 wide against 1920x1080 is exactly 90 tall. Anything else means the
    // aspect ratio was dropped somewhere.
    let plan = SheetPlan::for_source(60_000.0, 1920, 1080, budget());
    assert_eq!(plan.cell_width, 160);
    assert_eq!(plan.cell_height, 90);
  }

  #[test]
  fn a_portrait_webcam_gets_taller_cells_than_it_is_wide() {
    // The camera sidecar is portrait. A sheet that assumed 16:9 for both would
    // squash it, and the webcam lane is exactly where that shows.
    let plan = SheetPlan::for_source(60_000.0, 720, 1280, budget());
    assert!(
      plan.cell_height > plan.cell_width,
      "portrait source produced {}x{} cells",
      plan.cell_width,
      plan.cell_height
    );
  }

  #[test]
  fn a_long_recording_stretches_the_interval_rather_than_the_sheet() {
    // Ten minutes at one a second would be 600 frames, double the cap. The cap
    // wins and the interval doubles to cover the same ground.
    let plan = SheetPlan::for_source(600_000.0, 1920, 1080, budget());
    assert_eq!(plan.frame_count, 300);
    assert_eq!(plan.interval_ms, 2000.0);
  }

  #[test]
  fn the_frame_cap_is_never_exceeded_however_long_the_recording() {
    // An hour, and then some.
    for minutes in [10, 30, 60, 180] {
      let plan = SheetPlan::for_source(minutes as f64 * 60_000.0, 1920, 1080, budget());
      assert!(
        plan.frame_count <= budget().max_frames,
        "{minutes} minutes produced {} frames",
        plan.frame_count
      );
    }
  }

  #[test]
  fn the_frames_always_span_the_whole_recording() {
    // The last slot's boundary has to land inside the recording, or the tail
    // of the timeline has no thumbnail to draw.
    for seconds in [1, 7, 60, 301, 1800] {
      let duration = seconds as f64 * 1000.0;
      let plan = SheetPlan::for_source(duration, 1920, 1080, budget());
      let last_boundary = (plan.frame_count - 1) as f64 * plan.interval_ms;
      assert!(
        last_boundary <= duration,
        "{seconds}s: last boundary {last_boundary} past the end"
      );
    }
  }

  #[test]
  fn a_recording_shorter_than_one_interval_still_gets_a_frame() {
    let plan = SheetPlan::for_source(400.0, 1920, 1080, budget());
    assert_eq!(plan.frame_count, 1);
  }

  #[test]
  fn a_zero_length_recording_still_gets_a_frame() {
    // Happens on a recording recovered after a crash. A zero-frame plan means
    // a zero-sized PNG, which is an encode failure rather than an empty lane.
    let plan = SheetPlan::for_source(0.0, 1920, 1080, budget());
    assert_eq!(plan.frame_count, 1);
    assert!(plan.interval_ms > 0.0);
  }

  #[test]
  fn a_source_with_no_dimensions_still_gets_allocatable_cells() {
    let plan = SheetPlan::for_source(10_000.0, 0, 0, budget());
    assert!(plan.cell_width >= 1);
    assert!(plan.cell_height >= 1);
  }

  #[test]
  fn the_grid_wraps_at_the_column_limit() {
    // 60 frames, ten to a row.
    let plan = SheetPlan::for_source(60_000.0, 1920, 1080, budget());
    assert_eq!(plan.columns, 10);
    assert_eq!(plan.rows, 6);
  }

  #[test]
  fn a_sheet_with_fewer_frames_than_one_row_does_not_pad_the_row() {
    // Four frames should be 4 wide and 1 tall, not 10 wide with six empty
    // cells -- that is 60% of the PNG spent on nothing.
    let plan = SheetPlan::for_source(4_000.0, 1920, 1080, budget());
    assert_eq!(plan.frame_count, 4);
    assert_eq!(plan.columns, 4);
    assert_eq!(plan.rows, 1);
  }

  #[test]
  fn a_part_full_last_row_still_gets_a_row() {
    // 65 frames at ten a row is six full rows and a seventh holding five.
    let plan = SheetPlan::for_source(65_000.0, 1920, 1080, budget());
    assert_eq!(plan.frame_count, 65);
    assert_eq!(plan.rows, 7);
  }

  #[test]
  fn the_sheet_is_exactly_its_grid_of_cells() {
    let plan = SheetPlan::for_source(65_000.0, 1920, 1080, budget());
    assert_eq!(plan.sheet_width(), plan.columns * plan.cell_width);
    assert_eq!(plan.sheet_height(), plan.rows * plan.cell_height);
  }

  #[test]
  fn every_frame_has_a_cell_to_live_in() {
    // rows * columns has to cover frame_count for every shape, or the last
    // frames get placed outside the buffer.
    for seconds in [1, 4, 10, 65, 299, 300, 600, 3600] {
      let plan = SheetPlan::for_source(seconds as f64 * 1000.0, 1920, 1080, budget());
      assert!(
        (plan.rows * plan.columns) as usize >= plan.frame_count,
        "{seconds}s: {}x{} grid cannot hold {} frames",
        plan.columns,
        plan.rows,
        plan.frame_count
      );
    }
  }
}

#[cfg(test)]
mod sampling_scenarios {
  use super::*;

  /// A plan with round numbers, so the boundaries are obvious by eye.
  fn plan(frame_count: usize, interval_ms: f64) -> SheetPlan {
    SheetPlan {
      frame_count,
      interval_ms,
      cell_width: 160,
      cell_height: 90,
      columns: 10,
      rows: 1,
    }
  }

  #[test]
  fn the_very_first_frame_fills_the_very_first_slot() {
    let plan = plan(10, 1000.0);
    assert_eq!(plan.capture_slot(0.0, 0), Some(0));
  }

  #[test]
  fn a_frame_before_the_next_boundary_is_dropped() {
    // Slot 1's boundary is 1000ms. Everything decoded between 0 and there is
    // thrown away -- this is the case that makes the whole pass cheap.
    let plan = plan(10, 1000.0);
    assert_eq!(plan.capture_slot(500.0, 1), None);
    assert_eq!(plan.capture_slot(999.0, 1), None);
  }

  #[test]
  fn a_frame_exactly_on_the_boundary_is_kept() {
    let plan = plan(10, 1000.0);
    assert_eq!(plan.capture_slot(1000.0, 1), Some(1));
  }

  #[test]
  fn the_first_frame_past_the_boundary_is_kept() {
    // Frames land on multiples of the frame duration, not on our boundaries,
    // so the kept frame is nearly always slightly late.
    let plan = plan(10, 1000.0);
    assert_eq!(plan.capture_slot(1033.0, 1), Some(1));
  }

  #[test]
  fn a_full_sheet_keeps_nothing_more() {
    // The pass runs to the end of the file to reach EOF cleanly, so it keeps
    // being offered frames after the last slot is full.
    let plan = plan(10, 1000.0);
    assert_eq!(plan.capture_slot(500_000.0, 10), None);
  }

  #[test]
  fn a_gap_in_the_stream_fills_the_next_slot_rather_than_leaving_a_hole() {
    // Five seconds arrive at once with only slot 0 filled. The frame goes to
    // slot 1, not slot 5 -- a dense filmstrip that is slightly off in time
    // beats four transparent cells that read as a broken decode.
    let plan = plan(10, 1000.0);
    assert_eq!(plan.capture_slot(5200.0, 1), Some(1));
  }

  #[test]
  fn a_sequential_pass_fills_every_slot_exactly_once() {
    // The real shape of the thing: 30fps of frames offered in order to a
    // ten-slot sheet, and every slot ends up filled, in order, once.
    let plan = plan(10, 1000.0);
    let mut captured = 0;
    let mut filled = Vec::new();

    for frame in 0..300 {
      let timestamp_ms = frame as f64 * (1000.0 / 30.0);
      if let Some(slot) = plan.capture_slot(timestamp_ms, captured) {
        filled.push(slot);
        captured += 1;
      }
    }

    assert_eq!(filled, (0..10).collect::<Vec<_>>());
  }
}

#[cfg(test)]
mod tiling_scenarios {
  use super::*;

  /// Four two-by-two cells in a two-by-two grid: a sixteen-pixel sheet whose
  /// byte offsets can be worked out by hand.
  fn tiny_plan() -> SheetPlan {
    SheetPlan {
      frame_count: 4,
      interval_ms: 1000.0,
      cell_width: 2,
      cell_height: 2,
      columns: 2,
      rows: 2,
    }
  }

  /// A solid 2x2 cell in BGRA.
  fn cell(b: u8, g: u8, r: u8) -> Vec<u8> {
    let mut pixels = Vec::new();
    for _ in 0..4 {
      pixels.extend_from_slice(&[b, g, r, 255]);
    }
    pixels
  }

  /// The RGBA pixel at (x, y) of the sheet.
  fn pixel_at(sheet: &Sheet, x: u32, y: u32) -> [u8; 4] {
    let width = sheet.plan().sheet_width();
    let offset = ((y * width + x) * 4) as usize;
    let bytes = &sheet.pixels()[offset..offset + 4];
    [bytes[0], bytes[1], bytes[2], bytes[3]]
  }

  #[test]
  fn a_new_sheet_is_the_size_its_plan_says() {
    let sheet = Sheet::new(tiny_plan());
    // 4x4 pixels, four bytes each.
    assert_eq!(sheet.pixels().len(), 64);
  }

  #[test]
  fn a_new_sheet_is_fully_transparent() {
    // Unfilled cells have to be transparent rather than opaque black, so a
    // decode that dies halfway leaves gaps the lane can see through instead of
    // a row of black thumbnails that look like real frames.
    let sheet = Sheet::new(tiny_plan());
    assert!(sheet.pixels().iter().all(|byte| *byte == 0));
  }

  #[test]
  fn blue_and_red_are_swapped_on_the_way_in() {
    // The GPU reads back BGRA; PNG is RGBA. Pure BGRA blue is (255, 0, 0, 255)
    // and has to come out as RGBA (0, 0, 255, 255).
    let mut sheet = Sheet::new(tiny_plan());
    assert!(sheet.place(0, &cell(255, 0, 0)));
    assert_eq!(pixel_at(&sheet, 0, 0), [0, 0, 255, 255]);
  }

  #[test]
  fn the_green_channel_and_alpha_survive_the_swizzle() {
    let mut sheet = Sheet::new(tiny_plan());
    assert!(sheet.place(0, &cell(10, 20, 30)));
    assert_eq!(pixel_at(&sheet, 0, 0), [30, 20, 10, 255]);
  }

  #[test]
  fn the_first_slot_lands_in_the_top_left() {
    let mut sheet = Sheet::new(tiny_plan());
    sheet.place(0, &cell(255, 0, 0));
    assert_eq!(pixel_at(&sheet, 0, 0), [0, 0, 255, 255]);
    assert_eq!(pixel_at(&sheet, 1, 1), [0, 0, 255, 255]);
    // and nowhere else
    assert_eq!(pixel_at(&sheet, 2, 0), [0, 0, 0, 0]);
    assert_eq!(pixel_at(&sheet, 0, 2), [0, 0, 0, 0]);
  }

  #[test]
  fn the_second_slot_lands_beside_the_first_not_under_it() {
    // The mistake this catches is indexing by row-major cell instead of
    // column, which puts slot 1 below slot 0 and shears the whole sheet.
    let mut sheet = Sheet::new(tiny_plan());
    sheet.place(1, &cell(0, 0, 255));
    assert_eq!(pixel_at(&sheet, 2, 0), [255, 0, 0, 255]);
    assert_eq!(pixel_at(&sheet, 3, 1), [255, 0, 0, 255]);
    assert_eq!(pixel_at(&sheet, 0, 0), [0, 0, 0, 0]);
  }

  #[test]
  fn the_slot_after_the_last_column_wraps_to_the_next_row() {
    let mut sheet = Sheet::new(tiny_plan());
    sheet.place(2, &cell(0, 255, 0));
    assert_eq!(pixel_at(&sheet, 0, 2), [0, 255, 0, 255]);
    assert_eq!(pixel_at(&sheet, 1, 3), [0, 255, 0, 255]);
    // Row 0 is untouched.
    assert_eq!(pixel_at(&sheet, 0, 0), [0, 0, 0, 0]);
  }

  #[test]
  fn each_row_of_a_cell_goes_to_its_own_row_of_the_sheet() {
    // A cell is contiguous; its destination is not. Copying it as one block
    // rather than row by row is the classic version of this bug, and with a
    // single-colour cell it is invisible -- so this one has a distinct colour
    // per row.
    let mut sheet = Sheet::new(tiny_plan());
    let cell = vec![
      // row 0: two blue pixels (BGRA)
      255, 0, 0, 255, 255, 0, 0, 255, //
      // row 1: two red pixels
      0, 0, 255, 255, 0, 0, 255, 255,
    ];
    assert!(sheet.place(1, &cell));

    assert_eq!(pixel_at(&sheet, 2, 0), [0, 0, 255, 255]);
    assert_eq!(pixel_at(&sheet, 3, 0), [0, 0, 255, 255]);
    assert_eq!(pixel_at(&sheet, 2, 1), [255, 0, 0, 255]);
    assert_eq!(pixel_at(&sheet, 3, 1), [255, 0, 0, 255]);
  }

  #[test]
  fn a_cell_of_the_wrong_size_is_refused() {
    // Means the readback disagreed with the plan. Tiling it anyway would run
    // one cell's pixels into the next.
    let mut sheet = Sheet::new(tiny_plan());
    assert!(!sheet.place(0, &[0, 0, 0, 255]));
    assert!(sheet.pixels().iter().all(|byte| *byte == 0));
  }

  #[test]
  fn a_slot_outside_the_plan_is_refused() {
    let mut sheet = Sheet::new(tiny_plan());
    assert!(!sheet.place(4, &cell(255, 0, 0)));
    assert!(sheet.pixels().iter().all(|byte| *byte == 0));
  }

  #[test]
  fn filling_every_slot_leaves_no_transparent_pixel() {
    let mut sheet = Sheet::new(tiny_plan());
    for slot in 0..4 {
      assert!(sheet.place(slot, &cell(80, 90, 100)));
    }
    assert!(
      sheet.pixels().chunks(4).all(|pixel| pixel[3] == 255),
      "a full sheet still has transparent pixels"
    );
  }
}
