//! Hardware H.264 encode straight from D3D11 textures, muxed to MP4.
//!
//! Uses IMFSinkWriter, which owns both the encoder MFT and the MP4 muxer. Doing
//! it by hand would mean driving the MFT and an IMFMediaSink separately for no
//! benefit at this stage.

use windows::core::{Interface, Result, PCWSTR};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;
use windows::Win32::Media::MediaFoundation::*;

use crate::engine::d3d::gpu;
use crate::engine::mf::{device_manager, ensure_mf, wide};

/// How many staging textures to rotate through.
///
/// The encoder holds a reference to a submitted frame until it has consumed it.
/// Writing into a texture that is still queued corrupts the output, so we cycle
/// through a small ring instead of reusing one.
const RING: usize = 6;

fn pack(hi: u32, lo: u32) -> u64 {
  ((hi as u64) << 32) | lo as u64
}

// The encoder only takes NV12. Feeding the sink writer RGB32 and letting it
// insert a video processor looks tempting, but it fails with E_INVALIDARG on
// the second frame, so the render layer converts back to NV12 itself.

pub struct Encoder {
  writer: IMFSinkWriter,
  stream: u32,
  ring: Vec<ID3D11Texture2D>,
  next: usize,
  pub width: u32,
  pub height: u32,
  /// Kept as a rational. 29.97 is 30000/1001, and rounding it to 30 makes the
  /// output drift about a second per hour.
  pub fps_num: u32,
  pub fps_den: u32,
  pub frames_written: u64,
  finished: bool,
}

unsafe impl Send for Encoder {}

impl Encoder {
  pub fn create(
    path: &str,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    bitrate: u32,
  ) -> Result<Self> {
    ensure_mf();
    let gpu = gpu()?;
    let (manager, _token) = device_manager()?;

    let attrs = unsafe { create_attributes(4)? };
    unsafe {
      attrs.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, manager)?;
      // Without this the sink writer picks a software encoder.
      attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
      // Throttling paces writes to real time, which is exactly wrong for export.
      attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
    }

    let url = wide(path);
    let writer =
      unsafe { MFCreateSinkWriterFromURL(PCWSTR(url.as_ptr()), None, &attrs)? };

    // What lands in the file.
    let out = unsafe { MFCreateMediaType()? };
    unsafe {
      out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
      out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
      out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
      out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
      out.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
      out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps_num, fps_den))?;
      out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
    }
    let stream = unsafe { writer.AddStream(&out)? };

    // What we feed it: NV12, either straight from a decoder or from the render
    // layer's conversion pass.
    let input = unsafe { MFCreateMediaType()? };
    unsafe {
      input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
      input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
      input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
      input.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
      input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps_num, fps_den))?;
      input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
      writer.SetInputMediaType(stream, &input, None)?;
    }

    // Staging textures the encoder reads from.

    let mut ring = Vec::with_capacity(RING);
    for _ in 0..RING {
      let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_NV12,
        SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
          Count: 1,
          Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
      };
      let mut tex: Option<ID3D11Texture2D> = None;
      unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut tex))? };
      ring.push(tex.expect("staging texture"));
    }

    unsafe { writer.BeginWriting()? };

    Ok(Self {
      writer,
      stream,
      ring,
      next: 0,
      width,
      height,
      fps_num,
      fps_den,
      frames_written: 0,
      finished: false,
    })
  }

  /// Copy a GPU texture into the ring and submit it to the encoder.
  ///
  /// `src_subresource` matters because decoder output is a texture array.
  pub fn write_texture(
    &mut self,
    src: &ID3D11Texture2D,
    src_subresource: u32,
  ) -> Result<()> {
    let gpu = gpu()?;
    let slot = self.ring[self.next].clone();
    self.next = (self.next + 1) % RING;

    {
      let _guard = crate::engine::d3d::render_lock();
      unsafe {
        gpu
          .context
          .CopySubresourceRegion(&slot, 0, 0, 0, 0, src, src_subresource, None);
        gpu.context.Flush();
      }
    }

    // Wrap the texture as an MF buffer. No copy to system memory happens here;
    // the encoder reads the surface directly.
    let buffer: IMFMediaBuffer = unsafe {
      MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &slot, 0, false)?
    };

    // The buffer starts with length 0. An encoder handed a zero-length buffer
    // silently writes nothing, so this line is load-bearing.
    let len = unsafe { buffer.cast::<IMF2DBuffer>()?.GetContiguousLength()? };
    unsafe { buffer.SetCurrentLength(len)? };

    let sample = unsafe { MFCreateSample()? };
    // 100ns units per frame, from the rational rate.
    let ticks_per_frame =
      (10_000_000i64 * self.fps_den as i64) / self.fps_num.max(1) as i64;
    unsafe {
      sample.AddBuffer(&buffer)?;
      sample.SetSampleTime(self.frames_written as i64 * ticks_per_frame)?;
      sample.SetSampleDuration(ticks_per_frame)?;
      self.writer.WriteSample(self.stream, &sample)?;
    }

    self.frames_written += 1;
    Ok(())
  }

  /// Flush the encoder and close the MP4. Without this the file has no moov
  /// atom and nothing will play it.
  pub fn finish(&mut self) -> Result<()> {
    if !self.finished {
      unsafe { self.writer.Finalize()? };
      self.finished = true;
    }
    Ok(())
  }
}

impl Drop for Encoder {
  fn drop(&mut self) {
    let _ = self.finish();
  }
}

/// `MFCreateAttributes` takes an out-param; this just makes call sites readable.
unsafe fn create_attributes(count: u32) -> Result<IMFAttributes> {
  let mut attrs: Option<IMFAttributes> = None;
  unsafe { MFCreateAttributes(&mut attrs, count)? };
  Ok(attrs.expect("attributes"))
}
