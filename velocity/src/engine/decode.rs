//! Hardware H.264 decode via Media Foundation, output straight into a D3D11 texture.
//!
//! The chain is: Source Reader -> (hardware decoder MFT bound to our D3D11
//! device) -> IMFSample -> IMFDXGIBuffer -> ID3D11Texture2D. No frame ever
//! touches system memory.

use windows::core::{Interface, Result, PCWSTR};
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_I8;

use crate::engine::d3d::{gpu, SharedTexture, Sharing};
use crate::engine::mf::{device_manager, ensure_mf, wide};

pub struct DecodedFrame {
  /// 100ns units, as Media Foundation reports it.
  pub timestamp_100ns: i64,
  pub end_of_stream: bool,
}

/// A decoded frame still sitting in the decoder's own texture array.
pub struct RawSample {
  pub texture: Option<ID3D11Texture2D>,
  /// Which array slice of `texture` holds this frame.
  pub subresource: u32,
  pub timestamp_100ns: i64,
  pub end_of_stream: bool,
}

unsafe impl Send for RawSample {}

pub struct Decoder {
  reader: IMFSourceReader,
  /// The texture we copy each decoded frame into and share with Chromium.
  pub target: SharedTexture,
  pub display_width: u32,
  pub display_height: u32,
  /// Frame rate as the container reports it, e.g. 24000/1001 for 23.976.
  pub fps_num: u32,
  pub fps_den: u32,
  pub duration_100ns: i64,
  pub frames_decoded: u64,
}

unsafe impl Send for Decoder {}

impl Decoder {
  pub fn open(path: &str) -> Result<Self> {
    ensure_mf();
    let gpu = gpu()?;

    // Hand our D3D11 device to Media Foundation so the decoder MFT allocates
    // its output textures on the same device we share from.
    let (manager, _token) = device_manager()?;

    let mut attrs: Option<IMFAttributes> = None;
    unsafe { MFCreateAttributes(&mut attrs, 4)? };
    let attrs = attrs.expect("attributes");

    unsafe {
      attrs.SetUnknown(&MF_SOURCE_READER_D3D_MANAGER, manager)?;
      // Without this the reader may quietly fall back to a software decoder.
      attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
      // Lets the reader insert a video processor if the decoder's native output
      // is not what we asked for.
      attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)?;
    }

    let url = wide(path);
    let reader =
      unsafe { MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), &attrs)? };

    let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

    // Ask for NV12: it is what hardware H.264 decoders produce natively, so
    // this avoids an implicit conversion pass.
    let want = unsafe { MFCreateMediaType()? };
    unsafe {
      want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
      want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
      reader.SetCurrentMediaType(stream, None, &want)?;
      reader.SetStreamSelection(stream, true)?;
    }

    let actual = unsafe { reader.GetCurrentMediaType(stream)? };
    let frame_size = unsafe { actual.GetUINT64(&MF_MT_FRAME_SIZE)? };
    let display_width = (frame_size >> 32) as u32;
    let display_height = (frame_size & 0xFFFF_FFFF) as u32;

    // Packed as num<<32 | den. Needed for exact frame stepping and for handing
    // the encoder a matching rate on export.
    let (fps_num, fps_den) = match unsafe { actual.GetUINT64(&MF_MT_FRAME_RATE) } {
      Ok(v) if (v & 0xFFFF_FFFF) != 0 => ((v >> 32) as u32, (v & 0xFFFF_FFFF) as u32),
      _ => (30, 1),
    };

    // MF_PD_DURATION comes back as a VT_UI8 in 100ns units.
    let duration_100ns = unsafe {
      match reader
        .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
      {
        Ok(v) => (*v.Anonymous.Anonymous).Anonymous.uhVal as i64,
        Err(_) => 0,
      }
    };

    // NV12 => keyed mutex, per Electron's import rules.
    let target = SharedTexture::new(
      gpu,
      display_width,
      display_height,
      DXGI_FORMAT_NV12,
      Sharing::KeyedMutex,
      None,
    )?;

    Ok(Self {
      reader,
      target,
      display_width,
      display_height,
      fps_num,
      fps_den,
      duration_100ns,
      frames_decoded: 0,
    })
  }

  /// Pull one decoded sample. The texture it returns belongs to the decoder.
  ///
  /// Split out from the copy so a caller with its own texture pool can choose
  /// where the frame lands, instead of everything funnelling through one target.
  pub fn read_sample(&mut self) -> Result<RawSample> {
    let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

    loop {
      let mut flags = 0u32;
      let mut timestamp = 0i64;
      let mut sample: Option<IMFSample> = None;

      unsafe {
        self.reader.ReadSample(
          stream,
          0,
          None,
          Some(&mut flags),
          Some(&mut timestamp),
          Some(&mut sample),
        )?;
      }

      if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
        return Ok(RawSample {
          texture: None,
          subresource: 0,
          timestamp_100ns: timestamp,
          end_of_stream: true,
        });
      }

      let Some(sample) = sample else {
        // A gap or a format change produces no sample; just read again.
        continue;
      };

      let buffer = unsafe { sample.GetBufferByIndex(0)? };
      let dxgi: IMFDXGIBuffer = buffer.cast()?;

      // The texture lives on the GPU already. This is the whole point.
      let mut texture: Option<ID3D11Texture2D> = None;
      unsafe {
        dxgi.GetResource(
          &ID3D11Texture2D::IID,
          &mut texture as *mut _ as *mut *mut std::ffi::c_void,
        )?;
      }
      let subresource = unsafe { dxgi.GetSubresourceIndex()? };

      self.frames_decoded += 1;
      return Ok(RawSample {
        texture,
        subresource,
        timestamp_100ns: timestamp,
        end_of_stream: false,
      });
    }
  }

  /// Copy a decoded sample into a texture we own and can share.
  ///
  /// The decoder hands back a slice of its own texture *array*, and shared
  /// textures must be single-slice, so this copy is unavoidable. It stays on
  /// the GPU.
  pub fn copy_into(&self, sample: &RawSample, dst: &SharedTexture) -> Result<()> {
    let Some(src) = sample.texture.as_ref() else {
      return Ok(());
    };
    let gpu = gpu()?;

    let _render = crate::engine::d3d::render_lock();
    let _guard = dst.lock()?;
    unsafe {
      gpu
        .context
        .CopySubresourceRegion(&dst.texture, 0, 0, 0, 0, src, sample.subresource, None);
      gpu.context.Flush();
    }
    Ok(())
  }

  /// Decode one frame into this decoder's own target texture.
  pub fn next_frame(&mut self) -> Result<DecodedFrame> {
    let sample = self.read_sample()?;
    if !sample.end_of_stream {
      // Borrow-splitting: copy_into only reads &self, but `target` is a field,
      // so take the reference through a raw pointer-free local first.
      let target = &self.target as *const SharedTexture;
      unsafe { self.copy_into(&sample, &*target)? };
    }
    Ok(DecodedFrame {
      timestamp_100ns: sample.timestamp_100ns,
      end_of_stream: sample.end_of_stream,
    })
  }

  /// Seek to a position in 100ns units. Media Foundation snaps to the nearest
  /// preceding keyframe, so the next decoded frame may be earlier than asked.
  pub fn seek(&mut self, position_100ns: i64) -> Result<()> {
    let mut var = PROPVARIANT::default();
    unsafe {
      // A seek position is just a VT_I8 in 100ns units.
      // The inner struct sits behind a ManuallyDrop union field, so go through
      // an explicit deref rather than letting Rust try to drop the old value.
      let inner = &mut *var.Anonymous.Anonymous;
      inner.vt = VT_I8;
      inner.Anonymous.hVal = position_100ns;
      // GUID_NULL as the time format means "100ns units", the default.
      self.reader.SetCurrentPosition(&GUID_NULL, &var)?;
    }
    Ok(())
  }

  /// Coded size of the shared target, which is what Electron wants for codedSize.
  pub fn coded_size(&self) -> (u32, u32) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { self.target.texture.GetDesc(&mut desc) };
    (desc.Width, desc.Height)
  }
}

const GUID_NULL: windows::core::GUID = windows::core::GUID::zeroed();

/// What Media Foundation thinks is in a file, before we ask for anything.
///
/// Exists because `MF_E_TOPO_CODEC_NOT_FOUND` is ambiguous: it fires both when
/// the container is unreadable and when the requested output format is
/// unreachable, and those need opposite fixes.
pub struct Probe {
  pub opened: bool,
  pub error: String,
  pub native_types: Vec<String>,
}

fn guid_name(g: &windows::core::GUID) -> String {
  // The video subtype GUIDs are all {FOURCC}-0000-0010-8000-00AA00389B71.
  let d1 = g.data1;
  let fourcc = [
    (d1 & 0xFF) as u8,
    ((d1 >> 8) & 0xFF) as u8,
    ((d1 >> 16) & 0xFF) as u8,
    ((d1 >> 24) & 0xFF) as u8,
  ];
  let printable = fourcc.iter().all(|c| c.is_ascii_graphic());
  if printable {
    format!("{} ({:?})", String::from_utf8_lossy(&fourcc), g)
  } else {
    format!("{:?}", g)
  }
}

pub fn probe(path: &str) -> Probe {
  ensure_mf();

  let mut out = Probe {
    opened: false,
    error: String::new(),
    native_types: Vec::new(),
  };

  let url = wide(path);
  // Deliberately no D3D manager and no attributes: this asks the plainest
  // possible question, "can you parse this container at all?".
  let reader = match unsafe { MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), None) } {
    Ok(r) => r,
    Err(e) => {
      out.error = format!("MFCreateSourceReaderFromURL: {} (hr=0x{:08X})", e.message(), e.code().0 as u32);
      return out;
    }
  };

  out.opened = true;
  let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;

  for i in 0..8u32 {
    match unsafe { reader.GetNativeMediaType(stream, i) } {
      Ok(mt) => {
        let subtype = unsafe { mt.GetGUID(&MF_MT_SUBTYPE) }
          .map(|g| guid_name(&g))
          .unwrap_or_else(|_| "?".into());
        let size = unsafe { mt.GetUINT64(&MF_MT_FRAME_SIZE) }.unwrap_or(0);
        out.native_types.push(format!(
          "{} {}x{}",
          subtype,
          size >> 32,
          size & 0xFFFF_FFFF
        ));
      }
      Err(_) => break,
    }
  }

  out
}

/// Enumerate the video decoder MFTs registered for a given input subtype.
///
/// HEVC is the interesting case on Windows: the hardware can almost always do
/// it, but the Media Foundation decoder ships as a separate Store package. If
/// this list is empty for HEVC, that package is missing -- it is not a GPU
/// limitation.
pub fn list_decoders(subtype: windows::core::GUID) -> Vec<String> {
  ensure_mf();

  let input = MFT_REGISTER_TYPE_INFO {
    guidMajorType: MFMediaType_Video,
    guidSubtype: subtype,
  };

  let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
  let mut count = 0u32;

  // FIELDOFUSE matters: MFTs with field-of-use restrictions (the HEVC decoder
  // is one) are excluded from enumeration unless it is set, which makes a
  // present-but-restricted codec look completely absent.
  let flags = MFT_ENUM_FLAG(
    MFT_ENUM_FLAG_HARDWARE.0
      | MFT_ENUM_FLAG_SYNCMFT.0
      | MFT_ENUM_FLAG_ASYNCMFT.0
      | MFT_ENUM_FLAG_LOCALMFT.0
      | MFT_ENUM_FLAG_FIELDOFUSE.0
      | MFT_ENUM_FLAG_SORTANDFILTER.0,
  );

  let mut out = Vec::new();

  unsafe {
    if MFTEnumEx(
      MFT_CATEGORY_VIDEO_DECODER,
      flags,
      Some(&input),
      None,
      &mut activates,
      &mut count,
    )
    .is_err()
    {
      return out;
    }

    for i in 0..count as isize {
      if let Some(activate) = (*activates.offset(i)).as_ref() {
        let mut name = windows::core::PWSTR::null();
        let mut len = 0u32;
        if activate
          .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)
          .is_ok()
        {
          let slice = std::slice::from_raw_parts(name.0, len as usize);
          out.push(String::from_utf16_lossy(slice));
          windows::Win32::System::Com::CoTaskMemFree(Some(name.0 as *const _));
        }
      }
    }
    windows::Win32::System::Com::CoTaskMemFree(Some(activates as *const _));
  }

  out
}

pub fn hevc_subtype() -> windows::core::GUID {
  MFVideoFormat_HEVC
}

pub fn h264_subtype() -> windows::core::GUID {
  MFVideoFormat_H264
}

/// Ask the GPU directly whether it can DXVA-decode a profile.
///
/// This separates "your hardware can't" from "Windows has no decoder plugged
/// in". They look identical from Media Foundation but need different fixes.
pub fn gpu_decoder_profiles() -> Result<Vec<String>> {
  use windows::Win32::Graphics::Direct3D11::*;

  let gpu = crate::engine::d3d::gpu()?;
  let video: ID3D11VideoDevice = gpu.device.cast()?;

  let candidates: [(&str, windows::core::GUID); 4] = [
    ("h264_vld_noFGT", D3D11_DECODER_PROFILE_H264_VLD_NOFGT),
    ("hevc_vld_main", D3D11_DECODER_PROFILE_HEVC_VLD_MAIN),
    ("hevc_vld_main10", D3D11_DECODER_PROFILE_HEVC_VLD_MAIN10),
    ("vp9_vld_profile0", D3D11_DECODER_PROFILE_VP9_VLD_PROFILE0),
  ];

  let mut out = Vec::new();
  for (name, guid) in candidates {
    // NV12 is the universal decode output format; if it isn't supported for a
    // profile, that profile is effectively unusable here.
    let supported = unsafe { video.CheckVideoDecoderFormat(&guid, DXGI_FORMAT_NV12) }
      .map(|b| b.as_bool())
      .unwrap_or(false);
    out.push(format!("{}: {}", name, if supported { "yes" } else { "no" }));
  }
  Ok(out)
}
