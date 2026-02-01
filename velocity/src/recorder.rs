//! Native screen recorder using windows-capture
//!
//! This module provides high-performance screen recording with:
//! - Hardware-accelerated video encoding (H.264, HEVC, VP9)
//! - Cursor-free capture (cursor hidden from recording)
//! - Pause/resume support via frame skipping
//! - Resolution scaling
//!
//! The recorder writes directly to a file path, no frames are sent back to JS.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::error::Error as StdError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
        VideoSettingsSubType,
    },
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

/// Video codec for recording
#[napi(string_enum)]
#[derive(Debug, Clone, Copy, Default)]
pub enum VideoCodec {
    /// H.264/AVC - Best compatibility, good quality
    #[default]
    H264,
    /// H.265/HEVC - Better compression, newer devices required
    Hevc,
    /// VP9 - Open codec, good for web
    Vp9,
}

impl VideoCodec {
    fn to_subtype(self) -> VideoSettingsSubType {
        match self {
            VideoCodec::H264 => VideoSettingsSubType::H264,
            VideoCodec::Hevc => VideoSettingsSubType::HEVC,
            VideoCodec::Vp9 => VideoSettingsSubType::VP9,
        }
    }
}

/// Configuration for starting a recording
#[napi(object)]
#[derive(Clone)]
pub struct RecordingConfig {
    /// Monitor index (1-based) to record
    pub monitor_index: u32,
    /// Output file path (e.g., "C:\\Videos\\recording.mp4")
    pub output_path: String,
    /// Frame rate (default: 30)
    pub frame_rate: Option<u32>,
    /// Video bitrate in bits per second (default: 8_000_000 = 8 Mbps)
    pub bitrate: Option<u32>,
    /// Video codec (default: H264)
    pub codec: Option<VideoCodec>,
    /// Output width in pixels (for resolution scaling, default: native)
    pub width: Option<u32>,
    /// Output height in pixels (for resolution scaling, default: native)
    pub height: Option<u32>,
}

/// Flags passed to the capture handler
struct CaptureFlags {
    output_path: String,
    width: u32,
    height: u32,
    frame_rate: u32,
    bitrate: u32,
    codec: VideoCodec,
    is_paused: Arc<AtomicBool>,
    is_recording: Arc<AtomicBool>,
}

/// Global state for the active recording session
struct RecorderState {
    is_paused: Arc<AtomicBool>,
    is_recording: Arc<AtomicBool>,
    output_path: String,
}

static RECORDER_STATE: Mutex<Option<RecorderState>> = Mutex::new(None);

/// Capture handler that writes frames to the video encoder
struct CaptureHandler {
    encoder: Option<VideoEncoder>,
    is_paused: Arc<AtomicBool>,
    is_recording: Arc<AtomicBool>,
    #[allow(dead_code)]
    start_time: Instant,
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = CaptureFlags;
    type Error = Box<dyn StdError + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> std::result::Result<Self, Self::Error> {
        let flags = ctx.flags;

        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(flags.width, flags.height)
                .frame_rate(flags.frame_rate)
                .bitrate(flags.bitrate)
                .sub_type(flags.codec.to_subtype()),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &flags.output_path,
        )?;

        Ok(Self {
            encoder: Some(encoder),
            is_paused: flags.is_paused,
            is_recording: flags.is_recording,
            start_time: Instant::now(),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> std::result::Result<(), Self::Error> {
        // Check if we should stop
        if !self.is_recording.load(Ordering::SeqCst) {
            // Finalize encoder before stopping
            if let Some(encoder) = self.encoder.take() {
                encoder.finish()?;
            }
            capture_control.stop();
            return Ok(());
        }

        // Skip frame if paused
        if self.is_paused.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Send frame to encoder
        if let Some(encoder) = &mut self.encoder {
            encoder.send_frame(frame)?;
        }

        Ok(())
    }

    fn on_closed(&mut self) -> std::result::Result<(), Self::Error> {
        // Finalize encoder when capture stops
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        Ok(())
    }
}

/// Start a new recording session
///
/// This spawns a background thread that captures the screen and encodes to the output file.
/// The cursor is NOT captured (hidden from recording).
#[napi]
pub fn start_recording(config: RecordingConfig) -> Result<()> {
    let mut state = RECORDER_STATE
        .lock()
        .map_err(|_| Error::from_reason("Lock poisoned"))?;

    if state.is_some() {
        return Err(Error::from_reason("Recording already in progress"));
    }

    let monitor = Monitor::from_index(config.monitor_index as usize)
        .map_err(|e| Error::from_reason(format!("Invalid monitor index: {}", e)))?;

    let native_width = monitor.width().unwrap_or(1920);
    let native_height = monitor.height().unwrap_or(1080);

    // Use custom resolution if provided, otherwise use native
    let width = config.width.unwrap_or(native_width);
    let height = config.height.unwrap_or(native_height);

    let frame_rate = config.frame_rate.unwrap_or(30);
    let bitrate = config.bitrate.unwrap_or(8_000_000);
    let codec = config.codec.unwrap_or_default();
    let output_path = config.output_path.clone();

    let is_paused = Arc::new(AtomicBool::new(false));
    let is_recording = Arc::new(AtomicBool::new(true));

    let flags = CaptureFlags {
        output_path: output_path.clone(),
        width,
        height,
        frame_rate,
        bitrate,
        codec,
        is_paused: is_paused.clone(),
        is_recording: is_recording.clone(),
    };

    // Spawn capture thread
    std::thread::spawn(move || {
        let settings = Settings::new(
            monitor,
            CursorCaptureSettings::WithoutCursor, // KEY: Cursor hidden from recording
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        );

        // Start capture - this blocks until stopped
        if let Err(e) = CaptureHandler::start(settings) {
            eprintln!("[velocity::recorder] Capture error: {}", e);
        }
    });

    *state = Some(RecorderState {
        is_paused,
        is_recording,
        output_path,
    });

    Ok(())
}

/// Stop the current recording
///
/// Returns the output file path on success.
#[napi]
pub fn stop_recording() -> Result<String> {
    let mut state = RECORDER_STATE
        .lock()
        .map_err(|_| Error::from_reason("Lock poisoned"))?;

    let recorder = state
        .take()
        .ok_or_else(|| Error::from_reason("No active recording"))?;

    // Signal the capture thread to stop
    recorder.is_recording.store(false, Ordering::SeqCst);

    // Give the thread a moment to finalize
    std::thread::sleep(std::time::Duration::from_millis(500));

    Ok(recorder.output_path)
}

/// Pause the current recording
///
/// Frames will be skipped while paused.
#[napi]
pub fn pause_recording() -> Result<()> {
    let state = RECORDER_STATE
        .lock()
        .map_err(|_| Error::from_reason("Lock poisoned"))?;

    let recorder = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("No active recording"))?;
    recorder.is_paused.store(true, Ordering::SeqCst);

    Ok(())
}

/// Resume the current recording
#[napi]
pub fn resume_recording() -> Result<()> {
    let state = RECORDER_STATE
        .lock()
        .map_err(|_| Error::from_reason("Lock poisoned"))?;

    let recorder = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("No active recording"))?;
    recorder.is_paused.store(false, Ordering::SeqCst);

    Ok(())
}

/// Check if a recording is currently active
#[napi]
pub fn is_recording() -> bool {
    RECORDER_STATE
        .lock()
        .map(|state| state.is_some())
        .unwrap_or(false)
}

/// Check if the recording is paused
#[napi]
pub fn is_paused() -> bool {
    RECORDER_STATE
        .lock()
        .map(|state| {
            state
                .as_ref()
                .map(|s| s.is_paused.load(Ordering::SeqCst))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}
