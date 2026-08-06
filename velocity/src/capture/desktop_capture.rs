use crate::singular_clock::{delta_100ns_or_default, expected_audio_bytes};
use napi_derive::napi;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{
  channel, sync_channel, Receiver, Sender, SyncSender, TryRecvError, TrySendError,
};
use std::sync::Arc;
use std::thread;
use std::thread::JoinHandle;
use std::time::Duration;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
  IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
  AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
  ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
  MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;
use wasapi::{
  deinitialize, initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};

const AUDIO_SAMPLE_RATE: usize = 48_000;
const AUDIO_CHANNEL_COUNT: usize = 2;
const AUDIO_BITS_PER_SAMPLE: usize = 16;
const AUDIO_BLOCK_ALIGN: usize = AUDIO_CHANNEL_COUNT * (AUDIO_BITS_PER_SAMPLE / 8);
const AUDIO_BYTES_PER_SECOND: usize = AUDIO_SAMPLE_RATE * AUDIO_BLOCK_ALIGN;
const AUDIO_CHUNK_MS: usize = 10;
const AUDIO_CHUNK_BYTES: usize =
  (AUDIO_BYTES_PER_SECOND * AUDIO_CHUNK_MS / 1000 / AUDIO_BLOCK_ALIGN) * AUDIO_BLOCK_ALIGN;
const DEFAULT_FRAME_DURATION_100NS: i64 = 166_667;

#[napi]
pub struct Stopper {
  stop_txs: Vec<Sender<()>>,
  done_rxs: Vec<Receiver<()>>,
}

impl Stopper {
  pub(crate) fn from_channels(stop_tx: Sender<()>, done_rx: Receiver<()>) -> Self {
    Self {
      stop_txs: vec![stop_tx],
      done_rxs: vec![done_rx],
    }
  }

  pub(crate) fn append(&mut self, mut other: Stopper) {
    self.stop_txs.append(&mut other.stop_txs);
    self.done_rxs.append(&mut other.done_rxs);
  }
}

#[napi]
impl Stopper {
  #[napi]
  pub fn stop(&mut self) {
    for stop_tx in self.stop_txs.drain(..) {
      let _ = stop_tx.send(());
    }

    for done_rx in self.done_rxs.drain(..) {
      let _ = done_rx.recv_timeout(Duration::from_secs(8));
    }
  }
}

struct Capture {
  encoder: Option<VideoEncoder>,
  output_path: String,
  bitrate: u32,
  enable_system_audio: bool,
  native_audio_active: bool,
  audio_rx: Option<Receiver<Vec<u8>>>,
  audio_thread: Option<JoinHandle<()>>,
  audio_stop_flag: Option<Arc<AtomicBool>>,
  pending_audio_bytes: VecDeque<u8>,
  audio_fractional_bytes: f64,
  last_frame_timestamp_100ns: Option<i64>,
}

impl Capture {
  fn initialize_encoder(
    &mut self,
    width: u32,
    height: u32,
  ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if self.encoder.is_some() {
      return Ok(());
    }

    self.native_audio_active = false;

    if self.enable_system_audio {
      let stop_flag = Arc::new(AtomicBool::new(false));

      match spawn_loopback_audio_capture(stop_flag.clone()) {
        Ok((audio_rx, audio_thread)) => {
          self.native_audio_active = true;
          self.audio_rx = Some(audio_rx);
          self.audio_thread = Some(audio_thread);
          self.audio_stop_flag = Some(stop_flag);
        }
        Err(error) => {
          eprintln!(
            "[VelocityCapture] Falling back to video-only native recording (audio init failed): {error}"
          );
          self.stop_native_audio_capture();
        }
      }
    }

    let audio_settings = if self.native_audio_active {
      AudioSettingsBuilder::default()
        .sample_rate(AUDIO_SAMPLE_RATE as u32)
        .channel_count(AUDIO_CHANNEL_COUNT as u32)
        .bit_per_sample(AUDIO_BITS_PER_SAMPLE as u32)
        .bitrate(160_000)
        .disabled(false)
    } else {
      AudioSettingsBuilder::default().disabled(true)
    };

    let encoder = VideoEncoder::new(
      VideoSettingsBuilder::new(width, height).bitrate(self.bitrate),
      audio_settings,
      ContainerSettingsBuilder::default(),
      &self.output_path,
    )?;

    self.encoder = Some(encoder);
    Ok(())
  }

  fn stop_native_audio_capture(&mut self) {
    if let Some(stop_flag) = &self.audio_stop_flag {
      stop_flag.store(true, Ordering::Relaxed);
    }

    if let Some(thread_handle) = self.audio_thread.take() {
      let _ = thread_handle.join();
    }

    self.audio_rx = None;
    self.audio_stop_flag = None;
    self.native_audio_active = false;
    self.pending_audio_bytes.clear();
    self.audio_fractional_bytes = 0.0;
    self.last_frame_timestamp_100ns = None;
  }

  fn drain_audio_channel(&mut self) {
    loop {
      let next_chunk = match &self.audio_rx {
        Some(receiver) => receiver.try_recv(),
        None => return,
      };

      match next_chunk {
        Ok(chunk) => {
          for byte in chunk {
            self.pending_audio_bytes.push_back(byte);
          }
        }
        Err(TryRecvError::Empty) => break,
        Err(TryRecvError::Disconnected) => {
          self.native_audio_active = false;
          break;
        }
      }
    }
  }

  fn build_audio_buffer_for_frame(&mut self, frame_timestamp_100ns: i64) -> Vec<u8> {
    let delta_100ns = delta_100ns_or_default(
      self.last_frame_timestamp_100ns,
      frame_timestamp_100ns,
      DEFAULT_FRAME_DURATION_100NS,
    );

    self.last_frame_timestamp_100ns = Some(frame_timestamp_100ns);

    let (expected_bytes, next_fraction) = expected_audio_bytes(
      delta_100ns,
      AUDIO_BYTES_PER_SECOND,
      AUDIO_BLOCK_ALIGN,
      self.audio_fractional_bytes,
    );
    self.audio_fractional_bytes = next_fraction;

    let mut audio = vec![0u8; expected_bytes];
    for sample in &mut audio {
      if let Some(value) = self.pending_audio_bytes.pop_front() {
        *sample = value;
      } else {
        break;
      }
    }

    audio
  }
}

fn run_loopback_audio_capture(
  stop_flag: Arc<AtomicBool>,
  tx: SyncSender<Vec<u8>>,
) -> Result<(), String> {
  let enumerator = DeviceEnumerator::new().map_err(|error| format!("{error}"))?;
  let device = enumerator
    .get_default_device(&Direction::Render)
    .map_err(|error| format!("{error}"))?;

  let mut audio_client = device
    .get_iaudioclient()
    .map_err(|error| format!("{error}"))?;

  let desired_format = WaveFormat::new(
    AUDIO_BITS_PER_SAMPLE,
    AUDIO_BITS_PER_SAMPLE,
    &SampleType::Int,
    AUDIO_SAMPLE_RATE,
    AUDIO_CHANNEL_COUNT,
    None,
  );

  let (_, min_period) = audio_client
    .get_device_period()
    .map_err(|error| format!("{error}"))?;

  let mode = StreamMode::EventsShared {
    autoconvert: true,
    buffer_duration_hns: min_period,
  };

  // Loopback capture is enabled by using Direction::Capture on a render endpoint.
  audio_client
    .initialize_client(&desired_format, &Direction::Capture, &mode)
    .map_err(|error| format!("{error}"))?;

  let event_handle = audio_client
    .set_get_eventhandle()
    .map_err(|error| format!("{error}"))?;

  let capture_client = audio_client
    .get_audiocaptureclient()
    .map_err(|error| format!("{error}"))?;

  let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(AUDIO_CHUNK_BYTES * 8);

  audio_client
    .start_stream()
    .map_err(|error| format!("{error}"))?;

  while !stop_flag.load(Ordering::Relaxed) {
    let _ = capture_client.read_from_device_to_deque(&mut sample_queue);

    while sample_queue.len() >= AUDIO_CHUNK_BYTES {
      let mut chunk = vec![0u8; AUDIO_CHUNK_BYTES];
      for sample in &mut chunk {
        *sample = sample_queue.pop_front().unwrap_or(0);
      }

      match tx.try_send(chunk) {
        Ok(_) => {}
        Err(TrySendError::Full(_)) => {
          // Drop backlog chunks to keep sync close to real time.
        }
        Err(TrySendError::Disconnected(_)) => {
          stop_flag.store(true, Ordering::Relaxed);
          break;
        }
      }
    }

    let _ = event_handle.wait_for_event(40);
  }

  let _ = audio_client.stop_stream();
  Ok(())
}

fn spawn_loopback_audio_capture(
  stop_flag: Arc<AtomicBool>,
) -> Result<(Receiver<Vec<u8>>, JoinHandle<()>), String> {
  let (tx, rx) = sync_channel::<Vec<u8>>(16);

  let thread_handle = thread::Builder::new()
    .name("velocity-loopback-audio".to_string())
    .spawn(move || {
      if initialize_mta().is_err() {
        return;
      }

      let _ = run_loopback_audio_capture(stop_flag, tx);
      deinitialize();
    })
    .map_err(|error| error.to_string())?;

  Ok((rx, thread_handle))
}

impl GraphicsCaptureApiHandler for Capture {
  type Flags = (String, u32, bool);
  type Error = Box<dyn std::error::Error + Send + Sync>;

  fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
    let (output_path, bitrate, enable_system_audio) = ctx.flags;
    Ok(Self {
      encoder: None,
      output_path,
      bitrate,
      enable_system_audio,
      native_audio_active: false,
      audio_rx: None,
      audio_thread: None,
      audio_stop_flag: None,
      pending_audio_bytes: VecDeque::new(),
      audio_fractional_bytes: 0.0,
      last_frame_timestamp_100ns: None,
    })
  }

  fn on_frame_arrived(
    &mut self,
    frame: &mut Frame,
    _capture_control: InternalCaptureControl,
  ) -> Result<(), Self::Error> {
    // Initialize the VideoEncoder on the very first frame so its width/height exactly matches the dimensions.
    if self.encoder.is_none() {
      self.initialize_encoder(frame.width(), frame.height())?;
    }

    if self.native_audio_active {
      self.drain_audio_channel();
      let audio_buffer = self.build_audio_buffer_for_frame(frame.timestamp()?.Duration);
      if let Some(encoder) = self.encoder.as_mut() {
        let _ = encoder.send_frame_with_audio(frame, &audio_buffer);
      }
    } else if let Some(encoder) = self.encoder.as_mut() {
      let _ = encoder.send_frame(frame);
    }

    Ok(())
  }

  fn on_closed(&mut self) -> Result<(), Self::Error> {
    // If window is closed while recording, finish the encoder to save the video safely
    self.stop_native_audio_capture();
    if let Some(encoder) = self.encoder.take() {
      let _ = encoder.finish();
    }
    Ok(())
  }
}

#[napi]
pub fn start_monitor_recording(
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
) -> napi::Result<Stopper> {
  start_monitor_recording_internal(
    output_path,
    bitrate,
    include_system_audio,
    MinimumUpdateIntervalSettings::Default,
  )
}

fn start_monitor_recording_internal(
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  minimum_update_interval_settings: MinimumUpdateIntervalSettings,
) -> napi::Result<Stopper> {
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let enable_system_audio = include_system_audio.unwrap_or(false);

  let primary_monitor = Monitor::primary()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get primary monitor: {:?}", e)))?;

  let settings = Settings::new(
    primary_monitor,
    CursorCaptureSettings::WithoutCursor,
    DrawBorderSettings::WithoutBorder,
    SecondaryWindowSettings::Default,
    minimum_update_interval_settings,
    DirtyRegionSettings::Default,
    ColorFormat::Bgra8,
    (output_path, bitrate, enable_system_audio),
  );

  thread::spawn(move || {
    match Capture::start_free_threaded(settings) {
      Ok(control) => {
        let _ = stop_rx.recv();
        let _ = control.stop();
      }
      Err(error) => {
        eprintln!("[VelocityCapture] Failed to start monitor recording: {error}");
      }
    }

    let _ = done_tx.send(());
  });

  Ok(Stopper::from_channels(stop_tx, done_rx))
}

#[napi]
pub fn start_window_recording(
  window_title: String,
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
) -> napi::Result<Stopper> {
  start_window_recording_internal(
    window_title,
    output_path,
    bitrate,
    include_system_audio,
    MinimumUpdateIntervalSettings::Default,
  )
}

fn start_window_recording_internal(
  window_title: String,
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  minimum_update_interval_settings: MinimumUpdateIntervalSettings,
) -> napi::Result<Stopper> {
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let enable_system_audio = include_system_audio.unwrap_or(false);

  let window = Window::from_contains_name(&window_title)
    .map_err(|e| napi::Error::from_reason(format!("Failed to find window '{}': {:?}", window_title, e)))?;

  // WGC won't deliver frames for occluded/minimized windows.
  // Bring the target window to the foreground so the compositor renders it.
  // Only SW_RESTORE if truly minimized - otherwise it un-maximizes the window.
  let hwnd = HWND(window.as_raw_hwnd() as *mut _);
  unsafe {
    if IsIconic(hwnd).as_bool() {
      let _ = ShowWindow(hwnd, SW_RESTORE);
    }
    let _ = SetForegroundWindow(hwnd);
  }

  let settings = Settings::new(
    window,
    CursorCaptureSettings::WithoutCursor,
    DrawBorderSettings::WithoutBorder,
    SecondaryWindowSettings::Default,
    minimum_update_interval_settings,
    DirtyRegionSettings::Default,
    ColorFormat::Bgra8,
    (output_path, bitrate, enable_system_audio),
  );

  thread::spawn(move || {
    match Capture::start_free_threaded(settings) {
      Ok(control) => {
        let _ = stop_rx.recv();
        let _ = control.stop();
      }
      Err(error) => {
        eprintln!("[VelocityCapture] Failed to start window recording: {error}");
      }
    }

    let _ = done_tx.send(());
  });

  Ok(Stopper::from_channels(stop_tx, done_rx))
}

fn minimum_update_interval_for_target_fps(
  target_fps: Option<u32>,
  api_name: &str,
) -> MinimumUpdateIntervalSettings {
  let fps = match target_fps {
    Some(30) => 30,
    Some(60) | None => 60,
    Some(other) => {
      eprintln!(
        "[VelocityCapture] {api_name} requested unsupported target_fps={other}. Falling back to 60 fps."
      );
      60
    }
  };

  let interval_nanos = (1_000_000_000u64 / fps as u64).max(1);
  MinimumUpdateIntervalSettings::Custom(Duration::from_nanos(interval_nanos))
}

pub(crate) fn start_monitor_recording_with_target_fps(
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  start_monitor_recording_internal(
    output_path,
    bitrate,
    include_system_audio,
    minimum_update_interval_for_target_fps(target_fps, "start_monitor_recording_v2"),
  )
}

pub(crate) fn start_window_recording_with_target_fps(
  window_title: String,
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  start_window_recording_internal(
    window_title,
    output_path,
    bitrate,
    include_system_audio,
    minimum_update_interval_for_target_fps(target_fps, "start_window_recording_v2"),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn custom_interval_for_fps(fps: u64) -> MinimumUpdateIntervalSettings {
    let interval_nanos = (1_000_000_000u64 / fps).max(1);
    MinimumUpdateIntervalSettings::Custom(Duration::from_nanos(interval_nanos))
  }

  #[test]
  fn minimum_update_interval_defaults_to_60fps_when_none() {
    let settings = minimum_update_interval_for_target_fps(None, "test");
    assert_eq!(settings, custom_interval_for_fps(60));
  }

  #[test]
  fn minimum_update_interval_supports_30_and_60fps() {
    assert_eq!(
      minimum_update_interval_for_target_fps(Some(30), "test"),
      custom_interval_for_fps(30)
    );
    assert_eq!(
      minimum_update_interval_for_target_fps(Some(60), "test"),
      custom_interval_for_fps(60)
    );
  }

  #[test]
  fn minimum_update_interval_falls_back_to_60fps_for_unsupported_values() {
    assert_eq!(
      minimum_update_interval_for_target_fps(Some(24), "test"),
      custom_interval_for_fps(60)
    );
    assert_eq!(
      minimum_update_interval_for_target_fps(Some(0), "test"),
      custom_interval_for_fps(60)
    );
    assert_eq!(
      minimum_update_interval_for_target_fps(Some(144), "test"),
      custom_interval_for_fps(60)
    );
  }

  #[test]
  fn stopper_append_merges_channel_vectors_from_both_sides() {
    let (stop_tx_a, _stop_rx_a) = channel::<()>();
    let (_done_tx_a, done_rx_a) = channel::<()>();
    let (stop_tx_b, _stop_rx_b) = channel::<()>();
    let (_done_tx_b, done_rx_b) = channel::<()>();

    let mut stopper = Stopper::from_channels(stop_tx_a, done_rx_a);
    let other = Stopper::from_channels(stop_tx_b, done_rx_b);
    stopper.append(other);

    assert_eq!(stopper.stop_txs.len(), 2);
    assert_eq!(stopper.done_rxs.len(), 2);
  }

  #[test]
  fn stopper_stop_signals_every_registered_channel_and_waits_for_done() {
    let (stop_tx, stop_rx) = channel::<()>();
    let (done_tx, done_rx) = channel::<()>();
    let mut stopper = Stopper::from_channels(stop_tx, done_rx);

    let worker = thread::spawn(move || {
      // Mirrors how a real capture thread behaves: block until told to stop,
      // then report completion on the done channel.
      let _ = stop_rx.recv();
      let _ = done_tx.send(());
    });

    stopper.stop();
    worker.join().expect("worker thread should not panic");

    // stop() drains both vectors after signalling/joining every channel pair.
    assert!(stopper.stop_txs.is_empty());
    assert!(stopper.done_rxs.is_empty());
  }

  #[test]
  fn stopper_stop_does_not_hang_when_worker_never_reports_done() {
    // Regression guard: stop() must bound its wait per channel instead of blocking forever
    // if a capture thread dies without sending on `done_tx`.
    let (stop_tx, _stop_rx) = channel::<()>();
    let (_done_tx, done_rx) = channel::<()>();
    let mut stopper = Stopper::from_channels(stop_tx, done_rx);

    let started_at = std::time::Instant::now();
    stopper.stop();
    assert!(started_at.elapsed() < Duration::from_secs(10));
  }
}
