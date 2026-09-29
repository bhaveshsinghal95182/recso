//! CPU readback reaches Electron through a stable pool of linear DMA-BUFs.
//!
//! Every slot owns one GBM buffer and one exported descriptor for its lifetime.
//! Electron duplicates the descriptor on import; recycling a slot only changes
//! its pixels, never its identity.

use std::fs::{File, OpenOptions};
use std::os::fd::{AsRawFd, OwnedFd};

use gbm::{BufferObject, BufferObjectFlags, Device, Format};

use super::api::SharedTextureInfo;

struct PresentSlot {
  bo: BufferObject<()>,
  fd: OwnedFd,
  stride: u32,
  modifier: String,
}

/// Canvas-sized BGRA buffers with stable DMA-BUF descriptors.
pub(crate) struct PresentPool {
  slots: Vec<PresentSlot>,
  _device: Device<File>,
  width: u32,
  height: u32,
}

impl PresentPool {
  /// Use the first render node that supports linear, CPU-mappable ARGB buffers.
  pub(crate) fn new(width: u32, height: u32, count: usize) -> Result<Self, String> {
    if width == 0 || height == 0 || count == 0 {
      return Err("invalid DMA-BUF pool geometry".into());
    }
    let nodes: Vec<String> = if let Ok(node) = std::env::var("VELOCITY_GBM_NODE") {
      vec![node]
    } else {
      (128..=159).map(|index| format!("/dev/dri/renderD{index}")).collect()
    };
    let mut last_error = String::from("no usable GBM render node");
    for node in nodes {
      match Self::on_node(&node, width, height, count) {
        Ok(pool) => return Ok(pool),
        Err(error) => last_error = format!("{node}: {error}"),
      }
    }
    Err(last_error)
  }

  fn on_node(node: &str, width: u32, height: u32, count: usize) -> Result<Self, String> {
    let file = OpenOptions::new().read(true).write(true).open(node)
      .map_err(|error| error.to_string())?;
    let device = Device::new(file).map_err(|error| error.to_string())?;
    let mut slots = Vec::with_capacity(count);
    for _ in 0..count {
      let mut bo = device.create_buffer_object::<()>(width, height, Format::Argb8888,
        BufferObjectFlags::LINEAR | BufferObjectFlags::RENDERING)
        .map_err(|error| error.to_string())?;
      // Mapping now verifies this node can accept the CPU readback before open succeeds.
      bo.map_mut(0, 0, width, height, |_| ())
        .map_err(|error| error.to_string())?;
      let fd = bo.fd().map_err(|error| error.to_string())?;
      let stride = bo.stride();
      let modifier = u64::from(bo.modifier()).to_string();
      slots.push(PresentSlot { bo, fd, stride, modifier });
    }
    Ok(Self { slots, _device: device, width, height })
  }

  pub(crate) fn len(&self) -> usize { self.slots.len() }

  /// Copy tightly packed RGBA into a mapped ARGB8888 buffer in BGRA byte order.
  pub(crate) fn write(&mut self, slot: usize, rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    if (width, height) != (self.width, self.height) {
      return Err("present frame does not match canvas size".into());
    }
    let entry = self.slots.get_mut(slot).ok_or_else(|| "invalid present slot".to_string())?;
    entry.bo.map_mut(0, 0, width, height, |mapping| {
      let stride = mapping.stride() as usize;
      copy_rgba_to_bgra(rgba, width as usize, height as usize,
        mapping.buffer_mut(), stride)
    }).map_err(|error| error.to_string())?
  }

  /// Describe a slot without transferring ownership of its descriptor.
  pub(crate) fn texture_info(&self, slot: usize, timestamp_micros: f64) -> SharedTextureInfo {
    let entry = &self.slots[slot];
    SharedTextureInfo {
      handle: 0.0, width: self.width, height: self.height,
      visible_width: self.width, visible_height: self.height,
      pixel_format: "bgra".into(), timestamp: timestamp_micros,
      dmabuf_fd: Some(entry.fd.as_raw_fd()), dmabuf_stride: Some(entry.stride),
      dmabuf_offset: Some(0), dmabuf_size: Some(entry.stride.saturating_mul(self.height)),
      dmabuf_modifier: Some(entry.modifier.clone()),
    }
  }

  pub(crate) fn descriptors(&self) -> Vec<SharedTextureInfo> {
    (0..self.len()).map(|slot| self.texture_info(slot, 0.0)).collect()
  }
}

/// Validate both layouts and swap red and blue while respecting destination rows.
fn copy_rgba_to_bgra(source: &[u8], width: usize, height: usize,
  destination: &mut [u8], stride: usize) -> Result<(), String> {
  if width == 0 || height == 0 { return Err("empty RGBA image".into()); }
  let row = width.checked_mul(4).ok_or_else(|| "RGBA row is too large".to_string())?;
  let source_size = row.checked_mul(height).ok_or_else(|| "RGBA image is too large".to_string())?;
  let destination_size = stride.checked_mul(height).ok_or_else(|| "DMA-BUF image is too large".to_string())?;
  if stride < row || source.len() < source_size || destination.len() < destination_size {
    return Err("RGBA or DMA-BUF buffer is too short".into());
  }
  for (src, dst) in source.chunks_exact(row).take(height)
    .zip(destination.chunks_exact_mut(stride)) {
    for (rgba, bgra) in src.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
      bgra.copy_from_slice(&[rgba[2], rgba[1], rgba[0], rgba[3]]);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn swaps_channels_and_preserves_stride_padding() {
    let mut dst = [99; 24];
    copy_rgba_to_bgra(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      2, 2, &mut dst, 12).unwrap();
    assert_eq!(&dst[..12], &[3, 2, 1, 4, 7, 6, 5, 8, 99, 99, 99, 99]);
    assert_eq!(&dst[12..], &[11, 10, 9, 12, 15, 14, 13, 16, 99, 99, 99, 99]);
  }

  #[test]
  fn rejects_short_or_overlapping_rows() {
    assert!(copy_rgba_to_bgra(&[0; 8], 2, 2, &mut [0; 16], 8).is_err());
    assert!(copy_rgba_to_bgra(&[0; 16], 2, 2, &mut [0; 16], 7).is_err());
  }

  #[test]
  #[ignore = "requires a GBM render node"]
  fn round_trips_a_colour_on_hardware() {
    let mut pool = PresentPool::new(16, 8, 1).unwrap();
    pool.write(0, &[12, 34, 56, 255].repeat(16 * 8), 16, 8).unwrap();
    let mut first = [0; 4];
    pool.slots[0].bo.map_mut(0, 0, 16, 8, |mapping| {
      first.copy_from_slice(&mapping.buffer_mut()[..4]);
    }).unwrap();
    assert_eq!(first, [56, 34, 12, 255]);
    assert!(pool.texture_info(0, 0.0).dmabuf_fd.is_some());
  }
}
