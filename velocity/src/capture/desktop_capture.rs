use crate::capture::borderless::ensure_borderless_access;
use crate::capture::recording_info::{RecordingMediaInfo, RecordingStats};
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
use wasapi::{
  deinitialize, initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
  IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
  AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
  VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
  ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
  MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

const AUDIO_SAMPLE_RATE: usize = 48_000;
const AUDIO_CHANNEL_COUNT: usize = 2;
const AUDIO_BITS_PER_SAMPLE: usize = 16;
const AUDIO_BLOCK_ALIGN: usize = AUDIO_CHANNEL_COUNT * (AUDIO_BITS_PER_SAMPLE / 8);
const AUDIO_BYTES_PER_SECOND: usize = AUDIO_SAMPLE_RATE * AUDIO_BLOCK_ALIGN;
const AUDIO_CHUNK_MS: usize = 10;
const AUDIO_CHUNK_BYTES: usize =
  (AUDIO_BYTES_PER_SECOND * AUDIO_CHUNK_MS / 1000 / AUDIO_BLOCK_ALIGN) * AUDIO_BLOCK_ALIGN;
const DEFAULT_FRAME_DURATION_100NS: i64 = 166_667;
/// What windows-capture asks for when no interval is set.

#[napi]
pub struct Stopper {
  stop_txs: Vec<Sender<()>>,
  done_rxs: Vec<Receiver<()>>,
  /// One per capture this Stopper owns -- a v2 recording appends the webcam's
  /// to the screen's, and `stop` reports both.
  stats: Vec<Arc<RecordingStats>>,
}

impl Stopper {
  pub(crate) fn from_channels(stop_tx: Sender<()>, done_rx: Receiver<()>) -> Self {
    Self {
      stop_txs: vec![stop_tx],
      done_rxs: vec![done_rx],
      stats: Vec::new(),
    }
  }

  pub(crate) fn with_stats(
    stop_tx: Sender<()>,
    done_rx: Receiver<()>,
    stats: Arc<RecordingStats>,
  ) -> Self {
    Self {
      stop_txs: vec![stop_tx],
      done_rxs: vec![done_rx],
      stats: vec![stats],
    }
  }

  pub(crate) fn screen_stats(&self) -> Option<Arc<RecordingStats>> {
    self.stats.first().cloned()
  }

  pub(crate) fn append(&mut self, mut other: Stopper) {
    self.stop_txs.append(&mut other.stop_txs);
    self.done_rxs.append(&mut other.done_rxs);
    self.stats.append(&mut other.stats);
  }
}

#[napi]
impl Stopper {
  /// Stop every capture and describe what was written.
  ///
  /// Only meaningful once the encoders have been finalised, which is what the
  /// `done_rx` wait below is for -- the snapshot reads file sizes, and a file
  /// still being muxed reports the wrong one.
  #[napi]
  pub fn stop(&mut self) -> Vec<RecordingMediaInfo> {
    // Before waiting on anything: the duration is measured to this instant, and
    // finalising an MP4 takes long enough to distort it.
    for stats in &self.stats {
      stats.mark_stopped();
    }

    for stop_tx in self.stop_txs.drain(..) {
      let _ = stop_tx.send(());
    }

    for done_rx in self.done_rxs.drain(..) {
      let _ = done_rx.recv_timeout(Duration::from_secs(8));
    }

    self.stats.iter().map(|stats| stats.snapshot()).collect()
  }
}

/// How far a source's queue may run ahead before the oldest audio is dropped.
///
/// Two sound devices have two clocks and they drift. The frame loop pulls the
/// same number of bytes from each per frame, so a device running slightly fast
/// builds a backlog, and every byte of backlog is audio arriving later than it
/// happened -- a lag that grows for as long as the recording does. Dropping the
/// oldest keeps each source near the present, which is the same trade the phone
/// camera's single frame slot makes.
const MAX_AUDIO_BACKLOG_BYTES: usize = AUDIO_BYTES_PER_SECOND / 2;

/// One WASAPI endpoint feeding the recording's single audio track.
struct AudioSource {
  label: &'static str,
  rx: Receiver<Vec<u8>>,
  thread: Option<JoinHandle<()>>,
  stop: Arc<AtomicBool>,
  /// Captured but not yet written into a frame's buffer.
  pending: VecDeque<u8>,
  /// False once the capture thread has gone. A dead source stops being mixed
  /// rather than contributing silence for the rest of the take.
  live: bool,
}

impl AudioSource {
  /// Move everything the capture thread has produced into `pending`.
  fn drain(&mut self) {
    loop {
      match self.rx.try_recv() {
        Ok(chunk) => self.pending.extend(chunk),
        Err(TryRecvError::Empty) => break,
        Err(TryRecvError::Disconnected) => {
          self.live = false;
          break;
        }
      }
    }

    if self.pending.len() > MAX_AUDIO_BACKLOG_BYTES {
      let excess = self.pending.len() - MAX_AUDIO_BACKLOG_BYTES;
      // Whole frames only: half a sample would swap the channels for the rest
      // of the recording.
      let aligned = excess - (excess % AUDIO_BLOCK_ALIGN);
      self.pending.drain(..aligned);
      eprintln!(
        "[VelocityCapture] {} audio ran {aligned} bytes ahead; dropped the oldest to stay in step.",
        self.label
      );
    }
  }

  /// Take up to `wanted` bytes, zero-padded. Returns how many were real.
  fn take(&mut self, wanted: usize) -> (Vec<u8>, u64) {
    let mut buffer = vec![0u8; wanted];
    let mut captured = 0u64;

    for slot in &mut buffer {
      match self.pending.pop_front() {
        Some(byte) => {
          *slot = byte;
          captured += 1;
        }
        None => break,
      }
    }

    (buffer, captured)
  }
}

struct Capture {
  encoder: Option<VideoEncoder>,
  output_path: String,
  bitrate: u32,
  enable_system_audio: bool,
  enable_microphone: bool,
  /// Which microphone, by WASAPI endpoint id. None takes the system default.
  microphone_device_id: Option<String>,
  /// Every endpoint being recorded. Empty means a video-only file.
  audio_sources: Vec<AudioSource>,
  audio_fractional_bytes: f64,
  last_frame_timestamp_100ns: Option<i64>,
  stats: Arc<RecordingStats>,
}

/// Add 16-bit little-endian PCM into a running sum.
///
/// A sum rather than an average: two people talking should not each get quieter
/// because the other exists, and the loopback track is usually near silent while
/// someone is speaking over it. Clipping is handled once at the end.
fn mix_pcm_into(accumulator: &mut [i32], source: &[u8]) {
  // `as_chunks` rather than `chunks_exact`: a trailing odd byte is dropped
  // either way, which is what keeps a short read from shifting every sample
  // after it by half a frame and swapping the channels.
  let (samples, _) = source.as_chunks::<2>();
  for (slot, sample) in accumulator.iter_mut().zip(samples) {
    *slot += i16::from_le_bytes(*sample) as i32;
  }
}

/// Back to bytes, clamped rather than wrapped.
///
/// Wrapping is what makes a loud moment come out as a burst of noise instead of
/// a loud moment: an i32 sum past 32767 truncated to i16 flips sign.
fn pcm_from_accumulator(accumulator: &[i32]) -> Vec<u8> {
  let mut bytes = Vec::with_capacity(accumulator.len() * 2);
  for sample in accumulator {
    let clamped = (*sample).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    bytes.extend_from_slice(&clamped.to_le_bytes());
  }
  bytes
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

    self.audio_sources.clear();

    // Each endpoint is opened independently, and one failing costs only itself.
    // A machine with no microphone should still record what it was playing, and
    // a machine with sound disabled should still record a voice.
    let wanted: [(bool, Direction, Option<String>, &'static str, &'static str); 2] = [
      (
        self.enable_system_audio,
        Direction::Render,
        // Loopback always follows whatever the machine is playing out of, so
        // there is no device to choose here.
        None,
        "system audio",
        "velocity-loopback-audio",
      ),
      (
        self.enable_microphone,
        Direction::Capture,
        self.microphone_device_id.clone(),
        "microphone",
        "velocity-microphone-audio",
      ),
    ];

    for (enabled, endpoint, device_id, label, thread_name) in wanted {
      if !enabled {
        continue;
      }

      let stop = Arc::new(AtomicBool::new(false));
      match spawn_audio_capture(endpoint, device_id, thread_name, stop.clone()) {
        Ok((rx, thread)) => {
          self.audio_sources.push(AudioSource {
            label,
            rx,
            thread: Some(thread),
            stop,
            pending: VecDeque::new(),
            live: true,
          });
        }
        Err(error) => {
          eprintln!(
            "[VelocityCapture] {label} capture unavailable, continuing without it: {error}"
          );
        }
      }
    }

    // NOTE: `disabled(true)` does not keep the audio track out of the file. windows-capture 2.0.0
    // always calls `SetAudio` and builds its `MediaStreamSource` from both a video and an audio
    // stream descriptor; the disabled flag is only consulted in the sample-requested handler, which
    // answers audio requests with `SetSample(None)`. Every video-only recording therefore ends up
    // with an AAC track carrying zero samples. Consumers must treat the mere presence of an audio
    // track as meaningless and check that it actually has samples — see `hasPrimaryAudioTrack()` in
    // src/electron/services/recorder.service.ts.
    let audio_settings = if !self.audio_sources.is_empty() {
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
      VideoSettingsBuilder::new(width, height)
        .bitrate(self.bitrate)
        .sub_type(VideoSettingsSubType::H264),
      audio_settings,
      ContainerSettingsBuilder::default(),
      &self.output_path,
    )?;

    self.encoder = Some(encoder);
    Ok(())
  }

  fn stop_native_audio_capture(&mut self) {
    for source in &self.audio_sources {
      source.stop.store(true, Ordering::Relaxed);
    }

    // Signalled first, then joined, so two devices shut down concurrently
    // rather than one waiting out the other's event timeout.
    for source in &mut self.audio_sources {
      if let Some(thread_handle) = source.thread.take() {
        let _ = thread_handle.join();
      }
    }

    self.audio_sources.clear();
    self.audio_fractional_bytes = 0.0;
    self.last_frame_timestamp_100ns = None;
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

    // Buffers are sized to the frame cadence, so audio is laid down against the
    // video's own timestamps rather than against a second clock that has to be
    // reconciled afterwards. That is the whole reason this is worth doing in
    // here instead of muxing sidecars later.
    let mut accumulator = vec![0i32; expected_bytes / 2];
    let mut captured = 0u64;

    for source in &mut self.audio_sources {
      if !source.live {
        continue;
      }

      source.drain();
      let (buffer, taken) = source.take(expected_bytes);
      // The most any single device produced. A frame padded out to length is
      // still silence we invented, and a file made entirely of it must not
      // report itself as having sound.
      captured = captured.max(taken);
      mix_pcm_into(&mut accumulator, &buffer);
    }

    self.audio_sources.retain(|source| source.live);
    self.stats.note_captured_audio_bytes(captured);

    pcm_from_accumulator(&accumulator)
  }
}

/// One recording device the machine can hear from.
#[napi(object)]
pub struct AudioDeviceInfo {
  /// The WASAPI endpoint id. Stable across renames, unlike the label.
  pub id: String,
  pub label: String,
  pub is_default: bool,
}

fn enumerate_capture_devices() -> Result<Vec<AudioDeviceInfo>, String> {
  let enumerator = DeviceEnumerator::new().map_err(|error| format!("{error}"))?;

  let default_id = enumerator
    .get_default_device(&Direction::Capture)
    .ok()
    .and_then(|device| device.get_id().ok());

  let collection = enumerator
    .get_device_collection(&Direction::Capture)
    .map_err(|error| format!("{error}"))?;
  let count = collection
    .get_nbr_devices()
    .map_err(|error| format!("{error}"))?;

  let mut devices = Vec::new();
  for index in 0..count {
    let Ok(device) = collection.get_device_at_index(index) else {
      continue;
    };
    // Without an id there is no way to ask for this device later, so it would
    // only be an entry the user could pick and not get.
    let Ok(id) = device.get_id() else {
      continue;
    };

    let label = device
      .get_friendlyname()
      .unwrap_or_else(|_| format!("Microphone {}", index + 1));
    let is_default = default_id.as_deref() == Some(id.as_str());

    devices.push(AudioDeviceInfo {
      id,
      label,
      is_default,
    });
  }

  Ok(devices)
}

/// Every microphone Windows can record from.
///
/// Needed because the browser's `enumerateDevices` ids are salted per origin and
/// mean nothing to WASAPI -- so a microphone picked in the renderer could not be
/// opened here, and native capture silently used whatever was default. These ids
/// go back to `startMonitorRecordingV2` and open the device that was chosen.
#[napi]
pub fn list_audio_capture_devices() -> Vec<AudioDeviceInfo> {
  // On its own thread with its own apartment. The JavaScript thread already has
  // COM initialised in a mode this does not control, and asking for a different
  // one there fails outright.
  thread::spawn(|| {
    if initialize_mta().is_err() {
      return Vec::new();
    }
    let devices = enumerate_capture_devices().unwrap_or_else(|error| {
      eprintln!("[VelocityCapture] could not list recording devices: {error}");
      Vec::new()
    });
    deinitialize();
    devices
  })
  .join()
  .unwrap_or_default()
}

/// Open one WASAPI endpoint and stream 48kHz stereo PCM out of it.
///
/// `endpoint` is which side of the sound card to take the default device from,
/// and it is the only difference between the two things this records:
///
/// - `Direction::Render` is the speakers. Opening a *render* endpoint for
///   capture is what loopback means -- what the machine is playing.
/// - `Direction::Capture` is the microphone, opened the ordinary way.
///
/// Both are then initialised as `Direction::Capture`, because in both cases we
/// are reading. That asymmetry is the whole trick and it is easy to misread, so
/// the endpoint is a parameter and the initialise call is not.
fn run_audio_capture(
  endpoint: Direction,
  device_id: Option<String>,
  stop_flag: Arc<AtomicBool>,
  tx: SyncSender<Vec<u8>>,
) -> Result<(), String> {
  let enumerator = DeviceEnumerator::new().map_err(|error| format!("{error}"))?;

  // Matched on id rather than name: a device the user renames is still the
  // device they picked, and two identical headsets share a friendly name.
  let device = match device_id.as_deref() {
    Some(wanted) => {
      let collection = enumerator
        .get_device_collection(&endpoint)
        .map_err(|error| format!("{error}"))?;
      let count = collection
        .get_nbr_devices()
        .map_err(|error| format!("{error}"))?;

      let mut found = None;
      for index in 0..count {
        let Ok(candidate) = collection.get_device_at_index(index) else {
          continue;
        };
        if candidate.get_id().ok().as_deref() == Some(wanted) {
          found = Some(candidate);
          break;
        }
      }

      match found {
        Some(device) => device,
        None => {
          // Unplugged since it was chosen. The default is a better answer than
          // no sound at all, and saying so beats a silent recording.
          eprintln!(
            "[VelocityCapture] recording device {wanted} is gone; falling back to the default"
          );
          enumerator
            .get_default_device(&endpoint)
            .map_err(|error| format!("{error}"))?
        }
      }
    }
    None => enumerator
      .get_default_device(&endpoint)
      .map_err(|error| format!("{error}"))?,
  };

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

  // Always Capture: we are reading either way. See the note on `endpoint`.
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

fn spawn_audio_capture(
  endpoint: Direction,
  device_id: Option<String>,
  thread_name: &str,
  stop_flag: Arc<AtomicBool>,
) -> Result<(Receiver<Vec<u8>>, JoinHandle<()>), String> {
  let (tx, rx) = sync_channel::<Vec<u8>>(16);

  let thread_handle = thread::Builder::new()
    .name(thread_name.to_string())
    .spawn(move || {
      if initialize_mta().is_err() {
        return;
      }

      let _ = run_audio_capture(endpoint, device_id, stop_flag, tx);
      deinitialize();
    })
    .map_err(|error| error.to_string())?;

  Ok((rx, thread_handle))
}

impl GraphicsCaptureApiHandler for Capture {
  type Flags = (String, u32, bool, bool, Option<String>, Arc<RecordingStats>);
  type Error = Box<dyn std::error::Error + Send + Sync>;

  fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
    let (output_path, bitrate, enable_system_audio, enable_microphone, microphone_device_id, stats) =
      ctx.flags;
    Ok(Self {
      encoder: None,
      output_path,
      bitrate,
      enable_system_audio,
      enable_microphone,
      microphone_device_id,
      audio_sources: Vec::new(),
      audio_fractional_bytes: 0.0,
      last_frame_timestamp_100ns: None,
      stats,
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
      self.stats.set_dimensions(frame.width(), frame.height());
    }

    let timestamp_100ns = frame.timestamp()?.Duration;

    if !self.audio_sources.is_empty() {
      let audio_buffer = self.build_audio_buffer_for_frame(timestamp_100ns);
      if let Some(encoder) = self.encoder.as_mut() {
        let _ = encoder.send_frame_with_audio(frame, &audio_buffer);
      }
    } else if let Some(encoder) = self.encoder.as_mut() {
      let _ = encoder.send_frame(frame);
    }

    self.stats.note_frame(timestamp_100ns);

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

fn start_monitor_recording_internal(
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  include_microphone: Option<bool>,
  microphone_device_id: Option<String>,
  minimum_update_interval_settings: MinimumUpdateIntervalSettings,
  target_fps: u32,
) -> napi::Result<Stopper> {
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let enable_system_audio = include_system_audio.unwrap_or(false);
  let enable_microphone = include_microphone.unwrap_or(false);

  let primary_monitor = Monitor::primary()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get primary monitor: {:?}", e)))?;

  // WithoutBorder below is ignored unless this has been granted first.
  ensure_borderless_access();

  let stats = Arc::new(RecordingStats::new(
    output_path.clone(),
    "screen",
    target_fps,
    bitrate,
    "h264",
  ));

  let settings = Settings::new(
    primary_monitor,
    CursorCaptureSettings::WithoutCursor,
    DrawBorderSettings::WithoutBorder,
    SecondaryWindowSettings::Default,
    minimum_update_interval_settings,
    DirtyRegionSettings::Default,
    ColorFormat::Bgra8,
    (
      output_path,
      bitrate,
      enable_system_audio,
      enable_microphone,
      microphone_device_id.clone(),
      stats.clone(),
    ),
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

  Ok(Stopper::with_stats(stop_tx, done_rx, stats))
}

fn start_window_recording_internal(
  window_title: String,
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  include_microphone: Option<bool>,
  microphone_device_id: Option<String>,
  minimum_update_interval_settings: MinimumUpdateIntervalSettings,
  target_fps: u32,
) -> napi::Result<Stopper> {
  let (stop_tx, stop_rx) = channel();
  let (done_tx, done_rx) = channel();
  let enable_system_audio = include_system_audio.unwrap_or(false);
  let enable_microphone = include_microphone.unwrap_or(false);

  let window = Window::from_contains_name(&window_title).map_err(|e| {
    napi::Error::from_reason(format!("Failed to find window '{}': {:?}", window_title, e))
  })?;

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

  // WithoutBorder below is ignored unless this has been granted first.
  ensure_borderless_access();

  let stats = Arc::new(RecordingStats::new(
    output_path.clone(),
    "screen",
    target_fps,
    bitrate,
    "h264",
  ));

  let settings = Settings::new(
    window,
    CursorCaptureSettings::WithoutCursor,
    DrawBorderSettings::WithoutBorder,
    SecondaryWindowSettings::Default,
    minimum_update_interval_settings,
    DirtyRegionSettings::Default,
    ColorFormat::Bgra8,
    (
      output_path,
      bitrate,
      enable_system_audio,
      enable_microphone,
      microphone_device_id.clone(),
      stats.clone(),
    ),
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

  Ok(Stopper::with_stats(stop_tx, done_rx, stats))
}

/// The capture rate we will actually ask Windows for.
///
/// Split out from the interval so a caller can record the number without
/// triggering the fallback warning a second time.
fn resolved_capture_fps(target_fps: Option<u32>, api_name: &str) -> u32 {
  match target_fps {
    Some(30) => 30,
    Some(60) | None => 60,
    Some(other) => {
      eprintln!(
        "[VelocityCapture] {api_name} requested unsupported target_fps={other}. Falling back to 60 fps."
      );
      60
    }
  }
}

fn minimum_update_interval_for_fps(fps: u32) -> MinimumUpdateIntervalSettings {
  let interval_nanos = (1_000_000_000u64 / fps.max(1) as u64).max(1);
  MinimumUpdateIntervalSettings::Custom(Duration::from_nanos(interval_nanos))
}


pub(crate) fn start_monitor_recording_with_target_fps(
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  include_microphone: Option<bool>,
  microphone_device_id: Option<String>,
  target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  let fps = resolved_capture_fps(target_fps, "start_monitor_recording_v2");
  start_monitor_recording_internal(
    output_path,
    bitrate,
    include_system_audio,
    include_microphone,
    microphone_device_id,
    minimum_update_interval_for_fps(fps),
    fps,
  )
}

pub(crate) fn start_window_recording_with_target_fps(
  window_title: String,
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  include_microphone: Option<bool>,
  microphone_device_id: Option<String>,
  target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  let fps = resolved_capture_fps(target_fps, "start_window_recording_v2");
  start_window_recording_internal(
    window_title,
    output_path,
    bitrate,
    include_system_audio,
    include_microphone,
    microphone_device_id,
    minimum_update_interval_for_fps(fps),
    fps,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn pcm(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
  }

  #[test]
  fn one_source_passes_through_unchanged() {
    let mut accumulator = vec![0i32; 4];
    mix_pcm_into(&mut accumulator, &pcm(&[100, -200, 300, -400]));
    assert_eq!(
      pcm_from_accumulator(&accumulator),
      pcm(&[100, -200, 300, -400])
    );
  }

  #[test]
  fn two_sources_are_summed_not_averaged() {
    // Someone talking over a quiet game should not get quieter because the game
    // is also being recorded.
    let mut accumulator = vec![0i32; 2];
    mix_pcm_into(&mut accumulator, &pcm(&[1000, -1000]));
    mix_pcm_into(&mut accumulator, &pcm(&[500, -500]));
    assert_eq!(pcm_from_accumulator(&accumulator), pcm(&[1500, -1500]));
  }

  #[test]
  fn a_loud_moment_clips_rather_than_wrapping() {
    // Wrapping is the difference between "loud" and "a burst of noise": an i32
    // sum past 32767 truncated to i16 flips sign.
    let mut accumulator = vec![0i32; 2];
    mix_pcm_into(&mut accumulator, &pcm(&[30_000, -30_000]));
    mix_pcm_into(&mut accumulator, &pcm(&[30_000, -30_000]));
    assert_eq!(
      pcm_from_accumulator(&accumulator),
      pcm(&[i16::MAX, i16::MIN])
    );
  }

  #[test]
  fn a_source_that_ran_short_leaves_the_rest_alone() {
    // The frame buffer is sized to the cadence; a device that has not delivered
    // that much yet contributes what it has and no more.
    let mut accumulator = vec![0i32; 4];
    mix_pcm_into(&mut accumulator, &pcm(&[700, 700]));
    assert_eq!(pcm_from_accumulator(&accumulator), pcm(&[700, 700, 0, 0]));
  }

  #[test]
  fn a_trailing_odd_byte_is_ignored_rather_than_shifting_the_stream() {
    // chunks_exact drops a partial sample. Consuming it would put every
    // subsequent sample half a frame out and swap the channels.
    let mut accumulator = vec![0i32; 2];
    let mut odd = pcm(&[1234]);
    odd.push(0x7f);
    mix_pcm_into(&mut accumulator, &odd);
    assert_eq!(pcm_from_accumulator(&accumulator), pcm(&[1234, 0]));
  }

  fn custom_interval_for_fps(fps: u64) -> MinimumUpdateIntervalSettings {
    let interval_nanos = (1_000_000_000u64 / fps).max(1);
    MinimumUpdateIntervalSettings::Custom(Duration::from_nanos(interval_nanos))
  }

  #[test]
  fn minimum_update_interval_defaults_to_60fps_when_none() {
    let settings = minimum_update_interval_for_fps(resolved_capture_fps(None, "test"));
    assert_eq!(settings, custom_interval_for_fps(60));
  }

  #[test]
  fn minimum_update_interval_supports_30_and_60fps() {
    assert_eq!(
      minimum_update_interval_for_fps(resolved_capture_fps(Some(30), "test")),
      custom_interval_for_fps(30)
    );
    assert_eq!(
      minimum_update_interval_for_fps(resolved_capture_fps(Some(60), "test")),
      custom_interval_for_fps(60)
    );
  }

  /// The resolved rate is reported as `configuredFps`, so it has to be the
  /// rate we actually asked Windows for -- not what the caller passed.
  #[test]
  fn resolved_capture_fps_is_what_gets_reported() {
    assert_eq!(resolved_capture_fps(Some(30), "test"), 30);
    assert_eq!(resolved_capture_fps(Some(60), "test"), 60);
    assert_eq!(resolved_capture_fps(None, "test"), 60);
    assert_eq!(resolved_capture_fps(Some(144), "test"), 60);
  }

  #[test]
  fn minimum_update_interval_falls_back_to_60fps_for_unsupported_values() {
    assert_eq!(
      minimum_update_interval_for_fps(resolved_capture_fps(Some(24), "test")),
      custom_interval_for_fps(60)
    );
    assert_eq!(
      minimum_update_interval_for_fps(resolved_capture_fps(Some(0), "test")),
      custom_interval_for_fps(60)
    );
    assert_eq!(
      minimum_update_interval_for_fps(resolved_capture_fps(Some(144), "test")),
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

#[cfg(test)]
mod pcm_mixing_scenarios {
  use super::*;

  fn pcm(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
  }

  fn decode(bytes: &[u8]) -> Vec<i16> {
    // `as_chunks` to match what `mix_pcm_into` itself uses, so the test reads
    // the stream back exactly the way the mixer read it.
    bytes.as_chunks::<2>().0.iter().copied().map(i16::from_le_bytes).collect()
  }

  #[test]
  fn mixing_nothing_leaves_the_accumulator_alone() {
    let mut acc = vec![5i32, 6, 7];
    mix_pcm_into(&mut acc, &[]);
    assert_eq!(acc, vec![5, 6, 7]);
  }

  #[test]
  fn one_source_passes_through_unchanged() {
    let mut acc = vec![0i32; 4];
    mix_pcm_into(&mut acc, &pcm(&[100, -100, 0, 32767]));
    assert_eq!(acc, vec![100, -100, 0, 32767]);
  }

  #[test]
  fn two_sources_are_summed_not_averaged() {
    // Two people talking should not each get quieter because the other exists.
    let mut acc = vec![0i32; 2];
    mix_pcm_into(&mut acc, &pcm(&[1000, 2000]));
    mix_pcm_into(&mut acc, &pcm(&[3000, 4000]));
    assert_eq!(acc, vec![4000, 6000]);
  }

  #[test]
  fn many_sources_all_contribute() {
    let mut acc = vec![0i32; 2];
    for _ in 0..8 {
      mix_pcm_into(&mut acc, &pcm(&[1000, -500]));
    }
    assert_eq!(acc, vec![8000, -4000]);
  }

  #[test]
  fn mixing_is_order_independent() {
    let mut a = vec![0i32; 2];
    mix_pcm_into(&mut a, &pcm(&[100, 200]));
    mix_pcm_into(&mut a, &pcm(&[-50, 400]));
    let mut b = vec![0i32; 2];
    mix_pcm_into(&mut b, &pcm(&[-50, 400]));
    mix_pcm_into(&mut b, &pcm(&[100, 200]));
    assert_eq!(a, b);
  }

  #[test]
  fn the_accumulator_holds_more_than_an_i16_so_the_sum_does_not_clip_early() {
    // Clipping happens once, at the end, in `pcm_from_accumulator`.
    let mut acc = vec![0i32; 1];
    for _ in 0..4 {
      mix_pcm_into(&mut acc, &pcm(&[30000]));
    }
    assert_eq!(acc[0], 120_000);
  }

  #[test]
  fn a_source_that_ran_short_leaves_the_rest_alone() {
    let mut acc = vec![7i32; 4];
    mix_pcm_into(&mut acc, &pcm(&[1, 2]));
    assert_eq!(acc, vec![8, 9, 7, 7]);
  }

  #[test]
  fn a_source_longer_than_the_frame_is_truncated_rather_than_overrunning() {
    let mut acc = vec![0i32; 2];
    mix_pcm_into(&mut acc, &pcm(&[1, 2, 3, 4, 5]));
    assert_eq!(acc, vec![1, 2]);
  }

  #[test]
  fn a_trailing_odd_byte_is_ignored_rather_than_shifting_the_stream() {
    // Half a sample carried forward swaps the channels for the rest of the
    // recording, which is far worse than losing one byte.
    let mut acc = vec![0i32; 3];
    let mut bytes = pcm(&[100, 200]);
    bytes.push(0xff);
    mix_pcm_into(&mut acc, &bytes);
    assert_eq!(acc, vec![100, 200, 0]);
  }

  #[test]
  fn negative_samples_are_read_as_negative() {
    let mut acc = vec![0i32; 2];
    mix_pcm_into(&mut acc, &pcm(&[i16::MIN, -1]));
    assert_eq!(acc, vec![i16::MIN as i32, -1]);
  }

  #[test]
  fn an_empty_accumulator_swallows_any_source() {
    let mut acc: Vec<i32> = Vec::new();
    mix_pcm_into(&mut acc, &pcm(&[1, 2, 3]));
    assert!(acc.is_empty());
  }

  #[test]
  fn writing_back_a_quiet_mix_returns_what_went_in() {
    let mut acc = vec![0i32; 4];
    mix_pcm_into(&mut acc, &pcm(&[100, -100, 0, 500]));
    assert_eq!(decode(&pcm_from_accumulator(&acc)), vec![100, -100, 0, 500]);
  }

  #[test]
  fn a_loud_moment_clips_rather_than_wrapping() {
    // An i32 sum past 32767 truncated to i16 flips sign, which comes out as a
    // burst of noise instead of a loud moment.
    let bytes = pcm_from_accumulator(&[120_000, -120_000]);
    assert_eq!(decode(&bytes), vec![i16::MAX, i16::MIN]);
  }

  #[test]
  fn clipping_happens_at_exactly_the_i16_limits() {
    let bytes = pcm_from_accumulator(&[32_767, 32_768, -32_768, -32_769]);
    assert_eq!(
      decode(&bytes),
      vec![i16::MAX, i16::MAX, i16::MIN, i16::MIN]
    );
  }

  #[test]
  fn writing_back_produces_two_bytes_a_sample() {
    for len in [0usize, 1, 2, 480, 4800] {
      assert_eq!(pcm_from_accumulator(&vec![0i32; len]).len(), len * 2);
    }
  }

  #[test]
  fn writing_back_is_little_endian() {
    // Which is what WASAPI and the encoder both expect.
    assert_eq!(pcm_from_accumulator(&[0x0102]), vec![0x02, 0x01]);
  }

  #[test]
  fn an_empty_mix_writes_no_bytes() {
    assert!(pcm_from_accumulator(&[]).is_empty());
  }

  #[test]
  fn a_full_round_trip_through_the_mixer_preserves_a_quiet_signal() {
    let source: Vec<i16> = (0..480).map(|i| (i as i16).wrapping_mul(3)).collect();
    let mut acc = vec![0i32; source.len()];
    mix_pcm_into(&mut acc, &pcm(&source));
    assert_eq!(decode(&pcm_from_accumulator(&acc)), source);
  }
}

#[cfg(test)]
mod capture_rate_scenarios {
  use super::*;

  fn nanos(settings: &MinimumUpdateIntervalSettings) -> u128 {
    match settings {
      MinimumUpdateIntervalSettings::Custom(duration) => duration.as_nanos(),
      _ => panic!("expected a custom interval"),
    }
  }

  #[test]
  fn asking_for_nothing_gives_60() {
    assert_eq!(resolved_capture_fps(None, "test"), 60);
  }

  #[test]
  fn the_two_supported_rates_are_honoured() {
    assert_eq!(resolved_capture_fps(Some(30), "test"), 30);
    assert_eq!(resolved_capture_fps(Some(60), "test"), 60);
  }

  #[test]
  fn anything_else_falls_back_to_60() {
    for fps in [0u32, 1, 24, 25, 45, 90, 144, u32::MAX] {
      assert_eq!(resolved_capture_fps(Some(fps), "test"), 60, "{fps}");
    }
  }

  #[test]
  fn the_reported_rate_is_always_one_windows_was_actually_asked_for() {
    for fps in [None, Some(0), Some(30), Some(60), Some(1000)] {
      assert!(matches!(resolved_capture_fps(fps, "test"), 30 | 60), "{fps:?}");
    }
  }

  #[test]
  fn the_interval_is_the_reciprocal_of_the_rate() {
    assert_eq!(nanos(&minimum_update_interval_for_fps(60)), 16_666_666);
    assert_eq!(nanos(&minimum_update_interval_for_fps(30)), 33_333_333);
  }

  #[test]
  fn a_faster_rate_means_a_shorter_interval() {
    let mut last = u128::MAX;
    for fps in [1u32, 24, 30, 60, 120, 240] {
      let interval = nanos(&minimum_update_interval_for_fps(fps));
      assert!(interval < last, "{fps}");
      last = interval;
    }
  }

  #[test]
  fn a_zero_rate_does_not_divide_by_zero() {
    assert_eq!(nanos(&minimum_update_interval_for_fps(0)), 1_000_000_000);
  }

  #[test]
  fn the_interval_is_never_zero() {
    // A zero minimum interval asks Windows for every frame it can produce,
    // which is not what "unsupported rate" should mean.
    for fps in [0u32, 1, 60, 1_000_000_000, u32::MAX] {
      assert!(nanos(&minimum_update_interval_for_fps(fps)) >= 1, "{fps}");
    }
  }

  #[test]
  fn the_resolved_rate_and_the_interval_agree() {
    for requested in [None, Some(30), Some(60), Some(99)] {
      let fps = resolved_capture_fps(requested, "test");
      let interval = nanos(&minimum_update_interval_for_fps(fps));
      let implied = 1_000_000_000u128 / interval;
      assert_eq!(implied as u32, fps, "{requested:?}");
    }
  }
}

#[cfg(test)]
mod audio_source_scenarios {
  use super::*;
  use std::sync::mpsc::channel;

  fn source() -> (AudioSource, std::sync::mpsc::Sender<Vec<u8>>) {
    let (tx, rx) = channel::<Vec<u8>>();
    (
      AudioSource {
        label: "test",
        rx,
        thread: None,
        stop: Arc::new(AtomicBool::new(false)),
        pending: VecDeque::new(),
        live: true,
      },
      tx,
    )
  }

  #[test]
  fn draining_an_idle_source_finds_nothing() {
    let (mut s, _tx) = source();
    s.drain();
    assert!(s.pending.is_empty());
    assert!(s.live);
  }

  #[test]
  fn draining_moves_what_the_capture_thread_produced() {
    let (mut s, tx) = source();
    tx.send(vec![1, 2, 3, 4]).unwrap();
    s.drain();
    assert_eq!(s.pending.len(), 4);
  }

  #[test]
  fn draining_collects_every_chunk_waiting() {
    let (mut s, tx) = source();
    for _ in 0..5 {
      tx.send(vec![0; 4]).unwrap();
    }
    s.drain();
    assert_eq!(s.pending.len(), 20);
  }

  #[test]
  fn draining_keeps_the_chunks_in_order() {
    let (mut s, tx) = source();
    tx.send(vec![1, 2]).unwrap();
    tx.send(vec![3, 4]).unwrap();
    s.drain();
    assert_eq!(s.pending.iter().copied().collect::<Vec<u8>>(), vec![1, 2, 3, 4]);
  }

  #[test]
  fn a_source_whose_thread_has_gone_stops_being_live() {
    // A dead source stops being mixed rather than contributing silence for the
    // rest of the take.
    let (mut s, tx) = source();
    drop(tx);
    s.drain();
    assert!(!s.live);
  }

  #[test]
  fn a_dying_source_still_hands_over_what_it_had_already_sent() {
    let (mut s, tx) = source();
    tx.send(vec![7, 8]).unwrap();
    drop(tx);
    s.drain();
    assert_eq!(s.pending.len(), 2);
    assert!(!s.live);
  }

  #[test]
  fn a_backlog_past_the_limit_is_trimmed_from_the_oldest_end() {
    let (mut s, tx) = source();
    let excess = MAX_AUDIO_BACKLOG_BYTES + AUDIO_BLOCK_ALIGN * 10;
    tx.send(vec![0u8; excess]).unwrap();
    s.drain();
    assert!(s.pending.len() <= MAX_AUDIO_BACKLOG_BYTES);
  }

  #[test]
  fn trimming_a_backlog_drops_whole_frames() {
    // Half a sample dropped swaps the channels for the rest of the recording,
    // so the amount removed is rounded down to a frame boundary.
    let (mut s, tx) = source();
    let sent = MAX_AUDIO_BACKLOG_BYTES + AUDIO_BLOCK_ALIGN * 10 + 2;
    tx.send(vec![0u8; sent]).unwrap();
    s.drain();
    assert_eq!((sent - s.pending.len()) % AUDIO_BLOCK_ALIGN, 0);
  }

  #[test]
  fn an_aligned_backlog_stays_aligned_through_a_trim() {
    // The capture device never hands over a partial frame, so this is the case
    // that actually happens -- and the one the channel phase depends on.
    let (mut s, tx) = source();
    tx.send(vec![0u8; MAX_AUDIO_BACKLOG_BYTES + AUDIO_BLOCK_ALIGN * 10])
      .unwrap();
    s.drain();
    assert_eq!(s.pending.len() % AUDIO_BLOCK_ALIGN, 0);
    assert!(s.pending.len() <= MAX_AUDIO_BACKLOG_BYTES);
  }

  #[test]
  fn a_backlog_under_the_limit_is_left_alone() {
    let (mut s, tx) = source();
    tx.send(vec![0u8; 1024]).unwrap();
    s.drain();
    assert_eq!(s.pending.len(), 1024);
  }

  #[test]
  fn taking_from_an_empty_source_gives_silence() {
    let (mut s, _tx) = source();
    let (buffer, captured) = s.take(16);
    assert_eq!(buffer, vec![0u8; 16]);
    assert_eq!(captured, 0);
  }

  #[test]
  fn taking_returns_exactly_what_was_asked_for() {
    let (mut s, _tx) = source();
    s.pending.extend([1, 2, 3]);
    for wanted in [0usize, 1, 3, 8, 100] {
      let (buffer, _) = s.take(wanted);
      assert_eq!(buffer.len(), wanted, "{wanted}");
    }
  }

  #[test]
  fn taking_reports_how_many_bytes_were_real() {
    // The padding keeps the buffer aligned to the frame cadence; only the real
    // bytes count as captured audio.
    let (mut s, _tx) = source();
    s.pending.extend([1, 2, 3]);
    let (buffer, captured) = s.take(8);
    assert_eq!(captured, 3);
    assert_eq!(&buffer[..3], &[1, 2, 3]);
    assert_eq!(&buffer[3..], &[0, 0, 0, 0, 0]);
  }

  #[test]
  fn taking_consumes_what_it_returned() {
    let (mut s, _tx) = source();
    s.pending.extend([1, 2, 3, 4]);
    let (first, _) = s.take(2);
    let (second, _) = s.take(2);
    assert_eq!(first, vec![1, 2]);
    assert_eq!(second, vec![3, 4]);
    assert!(s.pending.is_empty());
  }

  #[test]
  fn taking_everything_available_reports_all_of_it_as_real() {
    let (mut s, _tx) = source();
    s.pending.extend([1, 2, 3, 4]);
    let (_, captured) = s.take(4);
    assert_eq!(captured, 4);
  }

  #[test]
  fn taking_nothing_takes_nothing() {
    let (mut s, _tx) = source();
    s.pending.extend([1, 2]);
    let (buffer, captured) = s.take(0);
    assert!(buffer.is_empty());
    assert_eq!(captured, 0);
    assert_eq!(s.pending.len(), 2);
  }
}

#[cfg(test)]
mod pcm_matrix {
  use super::*;

  fn pcm(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
  }

  fn decode(bytes: &[u8]) -> Vec<i16> {
    bytes
      .as_chunks::<2>()
      .0
      .iter()
      .copied()
      .map(i16::from_le_bytes)
      .collect()
  }

  /// Signal shapes a real capture produces.
  fn shapes() -> Vec<(&'static str, Vec<i16>)> {
    vec![
      ("silence", vec![0; 16]),
      ("quiet", (0..16).map(|i| i * 3).collect()),
      ("loud", (0..16).map(|i| i * 2000).collect()),
      ("full scale", vec![i16::MAX; 16]),
      ("full negative", vec![i16::MIN; 16]),
      (
        "alternating",
        (0..16)
          .map(|i| if i % 2 == 0 { 20_000 } else { -20_000 })
          .collect(),
      ),
      ("ramp down", (0..16).map(|i| 16_000 - i * 2_000).collect()),
    ]
  }

  #[test]
  fn one_source_passes_through_unchanged_for_every_shape() {
    for (name, samples) in shapes() {
      let mut acc = vec![0i32; samples.len()];
      mix_pcm_into(&mut acc, &pcm(&samples));
      let out = decode(&pcm_from_accumulator(&acc));
      assert_eq!(out, samples, "{name}");
    }
  }

  #[test]
  fn mixing_is_commutative_for_every_pair_of_shapes() {
    for (a_name, a) in shapes() {
      for (b_name, b) in shapes() {
        let mut forward = vec![0i32; 16];
        mix_pcm_into(&mut forward, &pcm(&a));
        mix_pcm_into(&mut forward, &pcm(&b));
        let mut backward = vec![0i32; 16];
        mix_pcm_into(&mut backward, &pcm(&b));
        mix_pcm_into(&mut backward, &pcm(&a));
        assert_eq!(forward, backward, "{a_name} + {b_name}");
      }
    }
  }

  #[test]
  fn mixing_sums_rather_than_averaging_for_every_pair_of_shapes() {
    // Two people talking must not each get quieter because the other exists.
    for (a_name, a) in shapes() {
      for (b_name, b) in shapes() {
        let mut acc = vec![0i32; 16];
        mix_pcm_into(&mut acc, &pcm(&a));
        mix_pcm_into(&mut acc, &pcm(&b));
        for (i, (mixed, (left, right))) in acc.iter().zip(a.iter().zip(b.iter())).enumerate() {
          assert_eq!(
            *mixed,
            *left as i32 + *right as i32,
            "{a_name} + {b_name} at {i}"
          );
        }
      }
    }
  }

  #[test]
  fn mixing_silence_changes_nothing_for_every_shape() {
    for (name, samples) in shapes() {
      let mut with = vec![0i32; 16];
      mix_pcm_into(&mut with, &pcm(&samples));
      mix_pcm_into(&mut with, &pcm(&[0i16; 16]));
      let mut without = vec![0i32; 16];
      mix_pcm_into(&mut without, &pcm(&samples));
      assert_eq!(with, without, "{name}");
    }
  }

  #[test]
  fn the_accumulator_never_overflows_for_a_realistic_number_of_sources() {
    // Eight full-scale sources is far more than the two the recorder mixes,
    // and an i32 still has room -- which is why clipping happens once, at the
    // end, rather than at every sum.
    let mut acc = vec![0i32; 16];
    for _ in 0..8 {
      mix_pcm_into(&mut acc, &pcm(&[i16::MAX; 16]));
    }
    assert_eq!(acc[0], i16::MAX as i32 * 8);
    let out = decode(&pcm_from_accumulator(&acc));
    assert_eq!(out[0], i16::MAX);
  }

  #[test]
  fn a_source_shorter_than_the_frame_leaves_the_rest_alone_at_every_length() {
    for len in 0..=16usize {
      let mut acc = vec![7i32; 16];
      mix_pcm_into(&mut acc, &pcm(&vec![1i16; len]));
      for (i, mixed) in acc.iter().enumerate() {
        let expected = if i < len { 8 } else { 7 };
        assert_eq!(*mixed, expected, "len {len} at {i}");
      }
    }
  }

  #[test]
  fn a_source_longer_than_the_frame_is_truncated_at_every_length() {
    for len in 16..=32usize {
      let mut acc = vec![0i32; 16];
      mix_pcm_into(&mut acc, &pcm(&vec![1i16; len]));
      assert_eq!(acc.len(), 16, "len {len}");
      assert!(acc.iter().all(|s| *s == 1), "len {len}");
    }
  }

  #[test]
  fn a_trailing_odd_byte_is_ignored_at_every_length() {
    // Half a sample carried forward swaps the channels for the rest of the
    // recording, which is far worse than losing one byte.
    for len in 0..=8usize {
      let mut acc = vec![0i32; 16];
      let mut bytes = pcm(&vec![100i16; len]);
      bytes.push(0xff);
      mix_pcm_into(&mut acc, &bytes);
      for (i, mixed) in acc.iter().enumerate() {
        let expected = if i < len { 100 } else { 0 };
        assert_eq!(*mixed, expected, "len {len} at {i}");
      }
    }
  }

  #[test]
  fn clipping_is_symmetric_and_saturating_across_the_range() {
    let cases: [(i32, i16); 9] = [
      (0, 0),
      (1, 1),
      (-1, -1),
      (32_766, 32_766),
      (32_767, i16::MAX),
      (32_768, i16::MAX),
      (-32_768, i16::MIN),
      (-32_769, i16::MIN),
      (i32::MAX, i16::MAX),
    ];
    for (input, expected) in cases {
      let out = decode(&pcm_from_accumulator(&[input]));
      assert_eq!(out[0], expected, "{input}");
    }
    assert_eq!(decode(&pcm_from_accumulator(&[i32::MIN]))[0], i16::MIN);
  }

  #[test]
  fn writing_back_is_two_little_endian_bytes_a_sample_at_every_length() {
    for len in [0usize, 1, 2, 16, 480, 4_800] {
      let acc: Vec<i32> = (0..len).map(|i| (i % 1000) as i32).collect();
      let bytes = pcm_from_accumulator(&acc);
      assert_eq!(bytes.len(), len * 2, "len {len}");
      for (i, sample) in acc.iter().enumerate() {
        let pair = [bytes[i * 2], bytes[i * 2 + 1]];
        assert_eq!(i16::from_le_bytes(pair) as i32, *sample, "len {len} at {i}");
      }
    }
  }

  #[test]
  fn a_full_round_trip_preserves_any_unclipped_mix() {
    for (name, samples) in shapes() {
      if samples.iter().any(|s| *s == i16::MIN || *s == i16::MAX) {
        // Full-scale shapes clip when summed; covered separately.
        continue;
      }
      let mut acc = vec![0i32; samples.len()];
      mix_pcm_into(&mut acc, &pcm(&samples));
      assert_eq!(decode(&pcm_from_accumulator(&acc)), samples, "{name}");
    }
  }

  #[test]
  fn an_empty_accumulator_or_source_is_always_survivable() {
    let mut empty: Vec<i32> = Vec::new();
    for (name, samples) in shapes() {
      mix_pcm_into(&mut empty, &pcm(&samples));
      assert!(empty.is_empty(), "{name}");
    }
    let mut acc = vec![5i32; 4];
    mix_pcm_into(&mut acc, &[]);
    assert_eq!(acc, vec![5, 5, 5, 5]);
    assert!(pcm_from_accumulator(&[]).is_empty());
  }
}

#[cfg(test)]
mod capture_rate_matrix {
  use super::*;

  const REQUESTS: [Option<u32>; 12] = [
    None,
    Some(0),
    Some(1),
    Some(15),
    Some(24),
    Some(25),
    Some(29),
    Some(30),
    Some(31),
    Some(60),
    Some(120),
    Some(u32::MAX),
  ];

  fn nanos(settings: &MinimumUpdateIntervalSettings) -> u128 {
    match settings {
      MinimumUpdateIntervalSettings::Custom(duration) => duration.as_nanos(),
      _ => panic!("expected a custom interval"),
    }
  }

  #[test]
  fn every_request_resolves_to_a_supported_rate() {
    for request in REQUESTS {
      let fps = resolved_capture_fps(request, "test");
      assert!(matches!(fps, 30 | 60), "{request:?} -> {fps}");
    }
  }

  #[test]
  fn only_the_two_supported_rates_are_honoured_exactly() {
    for request in REQUESTS {
      let fps = resolved_capture_fps(request, "test");
      match request {
        Some(30) => assert_eq!(fps, 30, "{request:?}"),
        _ => assert_eq!(fps, 60, "{request:?}"),
      }
    }
  }

  #[test]
  fn the_interval_matches_the_resolved_rate_for_every_request() {
    for request in REQUESTS {
      let fps = resolved_capture_fps(request, "test");
      let implied = 1_000_000_000u128 / nanos(&minimum_update_interval_for_fps(fps));
      assert_eq!(implied as u32, fps, "{request:?}");
    }
  }

  #[test]
  fn the_interval_is_never_zero_for_any_rate() {
    for fps in [0u32, 1, 24, 30, 60, 120, 240, 1_000_000_000, u32::MAX] {
      assert!(nanos(&minimum_update_interval_for_fps(fps)) >= 1, "{fps}");
    }
  }

  #[test]
  fn a_faster_rate_always_means_a_shorter_interval() {
    let mut last = u128::MAX;
    for fps in [1u32, 5, 24, 25, 30, 50, 60, 120, 240] {
      let interval = nanos(&minimum_update_interval_for_fps(fps));
      assert!(interval < last, "{fps}");
      last = interval;
    }
  }

  #[test]
  fn the_interval_is_within_a_nanosecond_of_the_ideal_for_every_rate() {
    for fps in [1u32, 24, 25, 30, 50, 60, 120, 240] {
      let ideal = 1_000_000_000u128 / fps as u128;
      let got = nanos(&minimum_update_interval_for_fps(fps));
      assert!(got.abs_diff(ideal) <= 1, "{fps}: {got} vs {ideal}");
    }
  }

  #[test]
  fn the_resolved_rate_and_the_clock_period_describe_the_same_cadence() {
    use crate::singular_clock::fps_to_period_100ns;
    for request in REQUESTS {
      let fps = resolved_capture_fps(request, "test");
      let period_ns = fps_to_period_100ns(fps) as u128 * 100;
      let interval_ns = nanos(&minimum_update_interval_for_fps(fps));
      // Both are the same cadence expressed in different units, to within the
      // rounding each one does.
      assert!(
        period_ns.abs_diff(interval_ns) < 1_000,
        "{request:?}: {period_ns} vs {interval_ns}"
      );
    }
  }
}

#[cfg(test)]
mod audio_backlog_matrix {
  use super::*;
  use std::sync::mpsc::channel;

  fn source() -> (AudioSource, std::sync::mpsc::Sender<Vec<u8>>) {
    let (tx, rx) = channel::<Vec<u8>>();
    (
      AudioSource {
        label: "test",
        rx,
        thread: None,
        stop: Arc::new(AtomicBool::new(false)),
        pending: VecDeque::new(),
        live: true,
      },
      tx,
    )
  }

  #[test]
  fn taking_always_returns_exactly_what_was_asked_for() {
    for available in [0usize, 1, 4, 100, 4_000] {
      for wanted in [0usize, 1, 4, 100, 4_000] {
        let (mut s, _tx) = source();
        s.pending.extend(std::iter::repeat_n(7u8, available));
        let (buffer, captured) = s.take(wanted);
        let label = format!("{available} available, {wanted} wanted");
        assert_eq!(buffer.len(), wanted, "{label}");
        assert_eq!(captured as usize, available.min(wanted), "{label}");
      }
    }
  }

  #[test]
  fn the_padding_is_always_silence_and_the_real_bytes_come_first() {
    for available in [0usize, 1, 4, 17] {
      let wanted = 32usize;
      let (mut s, _tx) = source();
      s.pending.extend((0..available).map(|i| (i + 1) as u8));
      let (buffer, captured) = s.take(wanted);
      let label = format!("{available} available");
      assert_eq!(captured as usize, available, "{label}");
      for (i, byte) in buffer.iter().enumerate() {
        let expected = if i < available { (i + 1) as u8 } else { 0 };
        assert_eq!(*byte, expected, "{label} at {i}");
      }
    }
  }

  #[test]
  fn taking_consumes_exactly_what_it_reported_as_real() {
    for available in [0usize, 1, 4, 100] {
      for wanted in [0usize, 1, 4, 100] {
        let (mut s, _tx) = source();
        s.pending.extend(std::iter::repeat_n(1u8, available));
        let (_, captured) = s.take(wanted);
        assert_eq!(
          s.pending.len(),
          available - captured as usize,
          "{available} available, {wanted} wanted"
        );
      }
    }
  }

  #[test]
  fn repeated_takes_drain_the_queue_in_order() {
    for chunk in [1usize, 3, 4, 16] {
      let (mut s, _tx) = source();
      let total = 64usize;
      s.pending.extend((0..total).map(|i| i as u8));
      let mut seen = Vec::new();
      loop {
        let (buffer, captured) = s.take(chunk);
        if captured == 0 {
          break;
        }
        seen.extend_from_slice(&buffer[..captured as usize]);
      }
      let expected: Vec<u8> = (0..total).map(|i| i as u8).collect();
      assert_eq!(seen, expected, "chunk {chunk}");
    }
  }

  #[test]
  fn a_backlog_is_trimmed_to_the_limit_for_every_overflow() {
    for extra in [0usize, 1, AUDIO_BLOCK_ALIGN, AUDIO_BLOCK_ALIGN * 100, 100_000] {
      let (mut s, tx) = source();
      tx.send(vec![0u8; MAX_AUDIO_BACKLOG_BYTES + extra]).unwrap();
      s.drain();
      assert!(
        s.pending.len() <= MAX_AUDIO_BACKLOG_BYTES + AUDIO_BLOCK_ALIGN,
        "extra {extra}: {}",
        s.pending.len()
      );
    }
  }

  #[test]
  fn an_aligned_backlog_stays_aligned_through_every_trim() {
    // The capture device never hands over a partial frame, so this is the case
    // that happens -- and the one the channel phase depends on.
    for extra in [0usize, AUDIO_BLOCK_ALIGN, AUDIO_BLOCK_ALIGN * 7, AUDIO_BLOCK_ALIGN * 5_000] {
      let (mut s, tx) = source();
      tx.send(vec![0u8; MAX_AUDIO_BACKLOG_BYTES + extra]).unwrap();
      s.drain();
      assert_eq!(s.pending.len() % AUDIO_BLOCK_ALIGN, 0, "extra {extra}");
    }
  }

  #[test]
  fn a_backlog_under_the_limit_is_never_trimmed() {
    for size in [0usize, 1, 1_024, MAX_AUDIO_BACKLOG_BYTES] {
      let (mut s, tx) = source();
      if size > 0 {
        tx.send(vec![0u8; size]).unwrap();
      }
      s.drain();
      assert_eq!(s.pending.len(), size, "size {size}");
    }
  }

  #[test]
  fn draining_preserves_order_across_any_number_of_chunks() {
    for chunks in [1usize, 2, 8, 64] {
      let (mut s, tx) = source();
      for i in 0..chunks {
        tx.send(vec![i as u8; 4]).unwrap();
      }
      s.drain();
      assert_eq!(s.pending.len(), chunks * 4, "chunks {chunks}");
      for i in 0..chunks {
        assert_eq!(s.pending[i * 4], i as u8, "chunks {chunks} at {i}");
      }
    }
  }

  #[test]
  fn a_source_stays_live_until_its_sender_is_gone() {
    for chunks in [0usize, 1, 8] {
      let (mut s, tx) = source();
      for _ in 0..chunks {
        tx.send(vec![0u8; 4]).unwrap();
      }
      s.drain();
      assert!(s.live, "chunks {chunks} should still be live");
      drop(tx);
      s.drain();
      assert!(!s.live, "chunks {chunks} should have died");
    }
  }

  #[test]
  fn a_dead_source_still_hands_over_everything_it_had_sent() {
    for chunks in [1usize, 4, 32] {
      let (mut s, tx) = source();
      for _ in 0..chunks {
        tx.send(vec![9u8; 4]).unwrap();
      }
      drop(tx);
      s.drain();
      assert_eq!(s.pending.len(), chunks * 4, "chunks {chunks}");
      assert!(!s.live, "chunks {chunks}");
    }
  }

  #[test]
  fn the_frame_budget_and_the_take_agree_for_every_frame_rate() {
    use crate::singular_clock::{expected_audio_bytes, fps_to_period_100ns};
    for fps in [24u32, 30, 60, 120] {
      let period = fps_to_period_100ns(fps);
      let (mut s, tx) = source();
      tx.send(vec![1u8; 192_000]).unwrap();
      s.drain();
      let mut carry = 0.0;
      for step in 0..10 {
        let (wanted, next) =
          expected_audio_bytes(period, AUDIO_BYTES_PER_SECOND, AUDIO_BLOCK_ALIGN, carry);
        carry = next;
        let (buffer, _) = s.take(wanted);
        assert_eq!(buffer.len(), wanted, "{fps}fps step {step}");
        assert_eq!(buffer.len() % AUDIO_BLOCK_ALIGN, 0, "{fps}fps step {step}");
      }
    }
  }
}
