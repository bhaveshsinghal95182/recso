//! Audio decode on Windows, through Media Foundation.
//!
//! The mixing itself is platform-neutral and lives in `mix.rs`; this is the
//! Windows [`ChunkSource`] it reads from.

use windows::core::{Result, PCWSTR};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_I8;

use crate::engine::cuts::CutTrack;
use crate::engine::mf::{ensure_mf, wide};
pub use crate::engine::mix::{AudioChunk, AudioMixer, ChunkSource, MIX_CHANNELS, MIX_SAMPLE_RATE};

/// A decoded audio stream from one file.
///
/// Deliberately separate from the video `Decoder` even when both come from the
/// same file: a Media Foundation source reader is single-consumer, and the
/// export reads video and audio at different rates. Two readers on one file
/// cost less than trying to interleave one.
pub struct AudioDecoder {
  reader: IMFSourceReader,
  pub sample_rate: u32,
  pub channels: u32,
  pub duration_100ns: i64,
}

unsafe impl Send for AudioDecoder {}

impl AudioDecoder {
  /// Open a file's first audio stream, decoded to float PCM.
  ///
  /// Returns `Ok(None)` when the file has no audio at all, which is not an
  /// error: a screen recording with the microphone off is a perfectly good
  /// recording and the caller should carry on without it.
  pub fn open(path: &str) -> Result<Option<Self>> {
    ensure_mf();

    let url = wide(path);
    let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(url.as_ptr()), None)? };

    let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

    // Ask for float PCM at the mix rate. The reader inserts a resampler when
    // the file is something else, which is the whole reason to state a rate
    // here rather than take whatever the file has and convert later.
    let want = unsafe { MFCreateMediaType()? };
    let configured = unsafe {
      want
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
        .and_then(|_| want.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float))
        .and_then(|_| want.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 32))
        .and_then(|_| want.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, MIX_SAMPLE_RATE))
        .and_then(|_| want.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, MIX_CHANNELS))
        .and_then(|_| reader.SetCurrentMediaType(stream, None, &want))
        .and_then(|_| reader.SetStreamSelection(stream, true))
    };

    // No audio stream, or one nothing can decode. Both mean "carry on without
    // it" rather than "fail the export".
    if configured.is_err() {
      return Ok(None);
    }

    let actual = unsafe { reader.GetCurrentMediaType(stream)? };
    let sample_rate =
      unsafe { actual.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND) }.unwrap_or(MIX_SAMPLE_RATE);
    let channels = unsafe { actual.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) }.unwrap_or(MIX_CHANNELS);

    let duration_100ns = unsafe {
      match reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
      {
        Ok(v) => (*v.Anonymous.Anonymous).Anonymous.uhVal as i64,
        Err(_) => 0,
      }
    };

    Ok(Some(Self {
      reader,
      sample_rate,
      channels,
      duration_100ns,
    }))
  }

  /// Pull one block of decoded audio.
  pub fn read_chunk(&mut self) -> Result<AudioChunk> {
    let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

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
        return Ok(AudioChunk {
          timestamp_100ns: timestamp,
          samples: Vec::new(),
          end_of_stream: true,
        });
      }

      // A stream tick is the reader saying "nothing yet, but not the end".
      let Some(sample) = sample else {
        continue;
      };

      let samples = unsafe { read_float_samples(&sample)? };
      return Ok(AudioChunk {
        timestamp_100ns: timestamp,
        samples,
        end_of_stream: false,
      });
    }
  }

  /// Seek to a position in 100ns units.
  pub fn seek(&mut self, position_100ns: i64) -> Result<()> {
    let mut var = PROPVARIANT::default();
    unsafe {
      let inner = &mut *var.Anonymous.Anonymous;
      inner.vt = VT_I8;
      inner.Anonymous.hVal = position_100ns;
      self.reader.SetCurrentPosition(&GUID_NULL, &var)?;
    }
    Ok(())
  }
}

const GUID_NULL: windows::core::GUID = windows::core::GUID::zeroed();

/// Copy an `IMFSample`'s bytes out as `f32`s.
///
/// The buffer belongs to Media Foundation and is recycled, so this copies
/// rather than borrowing -- the same reason the video path copies decoder
/// textures into its own.
unsafe fn read_float_samples(sample: &IMFSample) -> Result<Vec<f32>> {
  unsafe {
    let buffer = sample.ConvertToContiguousBuffer()?;

    let mut data: *mut u8 = std::ptr::null_mut();
    let mut length = 0u32;
    buffer.Lock(&mut data, None, Some(&mut length))?;

    let count = length as usize / std::mem::size_of::<f32>();
    let mut out = vec![0f32; count];
    if count > 0 && !data.is_null() {
      std::ptr::copy_nonoverlapping(data as *const f32, out.as_mut_ptr(), count);
    }

    buffer.Unlock()?;
    Ok(out)
  }
}

impl ChunkSource for AudioDecoder {
  type Error = windows::core::Error;

  fn channels(&self) -> u32 {
    self.channels
  }

  fn read_chunk(&mut self) -> Result<AudioChunk> {
    AudioDecoder::read_chunk(self)
  }

  fn seek(&mut self, position_100ns: i64) -> Result<()> {
    AudioDecoder::seek(self, position_100ns)
  }
}

impl AudioMixer<AudioDecoder> {
  /// Open every source that has audio through Media Foundation. `None` when
  /// none of them do.
  pub fn open(sources: &[(String, f64)], cuts: CutTrack) -> Result<Option<Self>> {
    Ok(Self::open_with(sources, cuts, AudioDecoder::open))
  }
}
