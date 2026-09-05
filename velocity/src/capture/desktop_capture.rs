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
const DEFAULT_CAPTURE_FPS: u32 = 60;

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
    // The v1 entry point predates microphone capture and its callers have no
    // way to ask for it.
    None,
    None,
    MinimumUpdateIntervalSettings::Default,
    DEFAULT_CAPTURE_FPS,
  )
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
    None,
    None,
    MinimumUpdateIntervalSettings::Default,
    DEFAULT_CAPTURE_FPS,
  )
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
