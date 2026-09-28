//! Audio from PipeWire sources for the Linux recording's Opus track.
//!
//! Each requested device has its own PipeWire loop and bounded sample queue.
//! A separate mixer follows the recording clock, combines those queues, and
//! emits one Opus packet for every 20 ms of elapsed recording time.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::properties::properties;
use pw::spa;
use spa::param::audio::{AudioFormat, AudioInfoRaw};
use spa::pod::Pod;

use crate::capture::devices::AudioDeviceInfo;

const SAMPLE_RATE: u32 = 48_000;
const PACKET_FRAMES: usize = 960;
const PACKET_DURATION: Duration = Duration::from_millis(20);
const PACKET_TICKS: i64 = 200_000;
/// Half a second of stereo frames; excess frames are dropped from the front.
const MAX_BACKLOG_FRAMES: usize = 24_000;
const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(5);

type SampleQueue = Arc<Mutex<VecDeque<f32>>>;

/// Which PipeWire inputs should feed the recording's single audio track.
pub(crate) struct AudioRequest {
  pub(crate) system_audio: bool,
  pub(crate) microphone: bool,
  /// PipeWire node id as a decimal string; None selects the default source.
  pub(crate) microphone_node: Option<String>,
}

/// Running source loops and their shared-clock Opus mixer.
pub(crate) struct AudioCapture {
  streams: Vec<DeviceStream>,
  mixer_stop: SyncSender<Instant>,
  mixer: JoinHandle<Result<AudioSummary, String>>,
}

/// Audio written and real device data consumed by the mixer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct AudioSummary {
  pub(crate) packets: u64,
  /// Device frames in 16-bit stereo equivalent bytes; silence is excluded.
  pub(crate) captured_bytes: u64,
}

struct DeviceStream {
  quit: pw::channel::Sender<()>,
  thread: JoinHandle<Result<(), String>>,
}

impl DeviceStream {
  fn stop(self) -> Result<(), String> {
    let _ = self.quit.send(());
    self.thread.join().unwrap_or_else(|_| Err("PipeWire audio thread panicked".to_string()))
  }
}

/// Open each source, then start packet timing only after all formats agree.
pub(crate) fn start<C, P>(request: AudioRequest, now_100ns: C, on_packet: P) -> Result<AudioCapture, String>
where
  C: Fn(Instant) -> i64 + Send + 'static,
  P: FnMut(&[u8], i64) + Send + 'static,
{
  if !request.system_audio && !request.microphone {
    return Err("select a microphone or system audio to record".to_string());
  }
  let microphone_id = match request.microphone_node {
    Some(id) if request.microphone => Some(id.parse::<u32>().map_err(|_| "the selected microphone has an invalid PipeWire node id".to_string())?),
    _ => None,
  };
  let mut streams = Vec::new();
  let mut queues = Vec::new();
  for (wanted, sink, target) in [(request.system_audio, true, None), (request.microphone, false, microphone_id)] {
    if !wanted { continue; }
    let queue = Arc::new(Mutex::new(VecDeque::new()));
    match start_stream(sink, target, queue.clone()) {
      Ok(stream) => {
        streams.push(stream);
        queues.push(queue);
      }
      Err(error) => {
        for stream in streams { let _ = stream.stop(); }
        return Err(error);
      }
    }
  }
  let encoder = match OpusEncoder::new() {
    Ok(encoder) => encoder,
    Err(error) => {
      for stream in streams { let _ = stream.stop(); }
      return Err(error);
    }
  };
  let origin = Instant::now();
  let t0 = now_100ns(origin);
  let (stop_tx, stop_rx) = sync_channel(1);
  let mixer = match thread::Builder::new().name("velocity-audio-mixer".to_string()).spawn(move || {
    run_mixer(queues, encoder, origin, t0, stop_rx, on_packet)
  }) {
    Ok(mixer) => mixer,
    Err(error) => {
      for stream in streams { let _ = stream.stop(); }
      return Err(format!("could not start the audio mixer: {error}"));
    }
  };
  Ok(AudioCapture { streams, mixer_stop: stop_tx, mixer })
}

impl AudioCapture {
  /// Stop the inputs, finish elapsed audio with silence padding, and join all threads.
  pub(crate) fn stop(self) -> Result<AudioSummary, String> {
    let mut first_error = None;
    for stream in self.streams {
      if let Err(error) = stream.stop() { if first_error.is_none() { first_error = Some(error); } }
    }
    let _ = self.mixer_stop.send(Instant::now());
    let summary = self.mixer.join().unwrap_or_else(|_| Err("audio mixer thread panicked".to_string()));
    if let Some(error) = first_error { return Err(error); }
    summary
  }
}

struct StreamState {
  queue: SampleQueue,
  info: AudioInfoRaw,
  channels: usize,
  ready: Option<SyncSender<Result<(), String>>>,
  failure: Rc<RefCell<Option<String>>>,
}

impl StreamState {
  fn report(&mut self, result: Result<(), String>) {
    if let Some(ready) = self.ready.take() { let _ = ready.send(result); }
  }
  fn fail(&mut self, message: String) {
    self.report(Err(message.clone()));
    *self.failure.borrow_mut() = Some(message);
  }
}

fn start_stream(sink: bool, target: Option<u32>, queue: SampleQueue) -> Result<DeviceStream, String> {
  let (ready_tx, ready_rx) = sync_channel(1);
  let (quit_tx, quit_rx) = pw::channel::channel();
  let thread = thread::Builder::new().name("velocity-pipewire-audio".to_string())
    .spawn(move || run_stream(sink, target, queue, ready_tx, quit_rx))
    .map_err(|error| format!("could not start the PipeWire audio thread: {error}"))?;
  match ready_rx.recv_timeout(NEGOTIATION_TIMEOUT) {
    Ok(Ok(())) => Ok(DeviceStream { quit: quit_tx, thread }),
    Ok(Err(error)) => { let _ = quit_tx.send(()); let _ = thread.join(); Err(error) }
    Err(_) => {
      let _ = quit_tx.send(());
      let _ = thread.join();
      Err("the PipeWire audio stream did not agree a format in time".to_string())
    }
  }
}

fn run_stream(
  sink: bool, target: Option<u32>, queue: SampleQueue,
  ready: SyncSender<Result<(), String>>, quit: pw::channel::Receiver<()>,
) -> Result<(), String> {
  let fail = |message: String| { let _ = ready.send(Err(message.clone())); message };
  pw::init();
  let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|error| format!("PipeWire main loop: {error}"))
    .map_err(|error| fail(error))?;
  let context = pw::context::ContextRc::new(&mainloop, None).map_err(|error| format!("PipeWire context: {error}"))
    .map_err(|error| fail(error))?;
  let core = context.connect_rc(None).map_err(|error| format!("could not connect to PipeWire: {error}"))
    .map_err(|error| fail(error))?;
  let mut props = properties! {
    *pw::keys::MEDIA_TYPE => "Audio",
    *pw::keys::MEDIA_CATEGORY => "Capture",
    *pw::keys::MEDIA_ROLE => if sink { "Music" } else { "Communication" },
  };
  if sink { props.insert(*pw::keys::STREAM_CAPTURE_SINK, "true"); }
  let stream = pw::stream::StreamBox::new(&core, "velocity-audio-capture", props)
    .map_err(|error| format!("PipeWire audio stream: {error}")).map_err(|error| fail(error))?;
  let failure = Rc::new(RefCell::new(None));
  let state = StreamState { queue, info: AudioInfoRaw::default(), channels: 0, ready: Some(ready.clone()), failure: failure.clone() };
  let _quit = quit.attach(mainloop.loop_(), { let mainloop = mainloop.clone(); move |()| mainloop.quit() });
  let listener = stream.add_local_listener_with_user_data(state)
    .state_changed({ let mainloop = mainloop.clone(); move |_, state, _, new| {
      if let pw::stream::StreamState::Error(message) = new {
        state.fail(format!("PipeWire audio stream failed: {message}"));
        mainloop.quit();
      }
    }})
    .param_changed({ let mainloop = mainloop.clone(); move |_, state, id, param| {
      if id != spa::param::ParamType::Format.as_raw() { return; }
      let Some(param) = param else { return; };
      if state.info.parse(param).is_err() {
        state.fail("PipeWire sent an audio format it could not describe".to_string());
        mainloop.quit();
        return;
      }
      let channels = state.info.channels();
      if state.info.format() != AudioFormat::F32LE || state.info.rate() != SAMPLE_RATE || !(channels == 1 || channels == 2) {
        state.fail(format!("PipeWire audio must be F32LE mono or stereo at 48000 Hz; this device offered {} channels at {} Hz", channels, state.info.rate()));
        mainloop.quit();
        return;
      }
      state.channels = channels as usize;
      state.report(Ok(()));
    }})
    .process(|stream, state| {
      if state.channels == 0 { return; }
      let Some(mut buffer) = stream.dequeue_buffer() else { return };
      let Some(data) = buffer.datas_mut().first_mut() else { return };
      let offset = data.chunk().offset() as usize;
      let size = data.chunk().size() as usize;
      let Some(bytes) = data.data().and_then(|bytes| bytes.get(offset..offset.saturating_add(size))) else { return };
      let samples = bytes.chunks_exact(4).map(|byte| f32::from_le_bytes([byte[0], byte[1], byte[2], byte[3]]));
      if let Ok(mut pending) = state.queue.lock() { append_samples(&mut pending, samples, state.channels); }
    })
    .register().map_err(|error| format!("PipeWire audio listener: {error}")).map_err(|error| fail(error))?;
  let _listener = listener;
  let format = format_params().map_err(|error| fail(error))?;
  let pod = Pod::from_bytes(&format).ok_or_else(|| "could not build the PipeWire audio format request".to_string())
    .map_err(|error| fail(error))?;
  let mut params = [pod];
  stream.connect(spa::utils::Direction::Input, target,
    pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS | pw::stream::StreamFlags::RT_PROCESS,
    &mut params).map_err(|error| format!("could not connect the PipeWire audio stream: {error}"))
    .map_err(|error| fail(error))?;
  mainloop.run();
  let _ = stream.disconnect();
  let result = failure.borrow_mut().take();
  match result { Some(error) => Err(error), None => Ok(()) }
}

fn format_params() -> Result<Vec<u8>, String> {
  let mut info = AudioInfoRaw::new();
  info.set_format(AudioFormat::F32LE);
  info.set_rate(SAMPLE_RATE);
  info.set_channels(2);
  let object = spa::pod::Object {
    type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
    id: spa::param::ParamType::EnumFormat.as_raw(),
    properties: info.into(),
  };
  spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &spa::pod::Value::Object(object))
    .map(|(cursor, _)| cursor.into_inner())
    .map_err(|error| format!("could not encode the PipeWire audio format request: {error:?}"))
}

fn append_samples(queue: &mut VecDeque<f32>, samples: impl Iterator<Item = f32>, channels: usize) {
  if channels == 1 {
    for sample in samples { queue.push_back(sample); queue.push_back(sample); }
  } else {
    queue.extend(samples);
  }
  // Keep complete stereo frames, including when a malformed chunk ends mid-frame.
  if queue.len() % 2 != 0 { queue.pop_back(); }
  let excess_frames = queue.len() / 2 - (queue.len() / 2).min(MAX_BACKLOG_FRAMES);
  queue.drain(..excess_frames * 2);
}

fn mix_packet(queues: &[SampleQueue]) -> ([f32; PACKET_FRAMES * 2], u64) {
  let mut pcm = [0.0; PACKET_FRAMES * 2];
  let mut frames = 0;
  for queue in queues {
    if let Ok(mut pending) = queue.lock() {
      let count = (pending.len() / 2).min(PACKET_FRAMES);
      frames += count as u64;
      for slot in pcm.iter_mut().take(count * 2) {
        if let Some(sample) = pending.pop_front() { *slot += sample; }
      }
    }
  }
  for sample in &mut pcm { *sample = sample.clamp(-1.0, 1.0); }
  (pcm, frames * 4)
}

fn packet_pts(t0: i64, index: u64) -> i64 { t0.saturating_add((index as i64).saturating_mul(PACKET_TICKS)) }

fn run_mixer<P>(
  queues: Vec<SampleQueue>, encoder: OpusEncoder, origin: Instant, t0: i64,
  stop: std::sync::mpsc::Receiver<Instant>, mut on_packet: P,
) -> Result<AudioSummary, String>
where P: FnMut(&[u8], i64),
{
  let mut summary = AudioSummary { packets: 0, captured_bytes: 0 };
  loop {
    let stopping = stop.try_recv().ok();
    let elapsed = stopping.unwrap_or_else(Instant::now).saturating_duration_since(origin);
    let due = elapsed.as_millis() / 20;
    let final_count = if stopping.is_some() && elapsed.as_nanos() % PACKET_DURATION.as_nanos() != 0 { due + 1 } else { due };
    while (summary.packets as u128) < final_count {
      let (pcm, real_bytes) = mix_packet(&queues);
      let packet = encoder.encode(&pcm)?;
      on_packet(&packet, packet_pts(t0, summary.packets));
      summary.packets += 1;
      summary.captured_bytes += real_bytes;
    }
    if stopping.is_some() { return Ok(summary); }
    thread::sleep(Duration::from_millis(10));
  }
}

struct OpusEncoder(*mut opusic_sys::OpusEncoder);

// SAFETY: The encoder moves to one mixer thread and is never shared or called concurrently.
unsafe impl Send for OpusEncoder {}

impl OpusEncoder {
  fn new() -> Result<Self, String> {
    let mut code = 0;
    // SAFETY: `code` is writable and the arguments are valid libopus parameters.
    let ptr = unsafe { opusic_sys::opus_encoder_create(SAMPLE_RATE as i32, 2, opusic_sys::OPUS_APPLICATION_AUDIO, &mut code) };
    if code != opusic_sys::OPUS_OK || ptr.is_null() { return Err(format!("could not create the Opus audio encoder (libopus error {code})")); }
    let encoder = Self(ptr);
    // SAFETY: The encoder pointer is live, and this control request takes an i32 bitrate.
    let code = unsafe { opusic_sys::opus_encoder_ctl(encoder.0, opusic_sys::OPUS_SET_BITRATE_REQUEST, 128_000i32) };
    if code != opusic_sys::OPUS_OK { return Err(format!("could not set the Opus audio bitrate (libopus error {code})")); }
    Ok(encoder)
  }
  fn encode(&self, pcm: &[f32; PACKET_FRAMES * 2]) -> Result<Vec<u8>, String> {
    let mut output = [0u8; 4000];
    // SAFETY: Both buffers are valid for 960 stereo frames and 4000 output bytes.
    let len = unsafe { opusic_sys::opus_encode_float(self.0, pcm.as_ptr(), PACKET_FRAMES as i32, output.as_mut_ptr(), output.len() as i32) };
    if len < 0 { return Err(format!("could not encode an Opus audio packet (libopus error {len})")); }
    Ok(output[..len as usize].to_vec())
  }
}

impl Drop for OpusEncoder {
  fn drop(&mut self) {
    // SAFETY: This pointer was created by libopus and is destroyed exactly once here.
    unsafe { opusic_sys::opus_encoder_destroy(self.0) };
  }
}

/// List microphone nodes for the recorder's device picker, with a bounded wait.
pub(crate) fn list_audio_capture_devices() -> Vec<AudioDeviceInfo> {
  let (tx, rx) = sync_channel(1);
  if thread::Builder::new().name("velocity-audio-devices".to_string()).spawn(move || { let _ = tx.send(list_devices()); }).is_err() {
    return Vec::new();
  }
  rx.recv_timeout(Duration::from_secs(2)).ok().and_then(Result::ok).unwrap_or_default()
}

fn list_devices() -> Result<Vec<AudioDeviceInfo>, String> {
  pw::init();
  let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|error| error.to_string())?;
  let context = pw::context::ContextRc::new(&mainloop, None).map_err(|error| error.to_string())?;
  let core = context.connect_rc(None).map_err(|error| error.to_string())?;
  let registry = core.get_registry_rc().map_err(|error| error.to_string())?;
  let devices = Rc::new(RefCell::new(Vec::<AudioDeviceInfo>::new()));
  let devices_for_event = devices.clone();
  let _registry_listener = registry.add_listener_local().global(move |global| {
    if global.type_ != pw::types::ObjectType::Node { return; }
    let Some(props) = &global.props else { return; };
    if props.get("media.class") != Some("Audio/Source") { return; }
    let label = props.get("node.description").or_else(|| props.get("node.name")).unwrap_or("Audio source");
    devices_for_event.borrow_mut().push(AudioDeviceInfo { id: global.id.to_string(), label: label.to_string(), is_default: false });
  }).register();
  let pending = core.sync(0).map_err(|error| error.to_string())?;
  let done = Rc::new(Cell::new(false));
  let done_for_event = done.clone();
  let _core_listener = core.add_listener_local().done({ let mainloop = mainloop.clone(); move |id, seq| {
    if id == pw::core::PW_ID_CORE && seq == pending { done_for_event.set(true); mainloop.quit(); }
  }}).register();
  let (timeout_tx, timeout_rx) = pw::channel::channel();
  let _timeout = timeout_rx.attach(mainloop.loop_(), { let mainloop = mainloop.clone(); move |()| mainloop.quit() });
  thread::spawn(move || { thread::sleep(Duration::from_millis(1800)); let _ = timeout_tx.send(()); });
  mainloop.run();
  if !done.get() { return Err("PipeWire audio device listing timed out".to_string()); }
  let mut result = devices.borrow_mut().drain(..).collect::<Vec<_>>();
  if let Some(first) = result.first_mut() { first.is_default = true; }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn queue(samples: &[f32]) -> SampleQueue { Arc::new(Mutex::new(samples.iter().copied().collect())) }

  #[test]
  fn mixes_and_clamps() {
    let (pcm, bytes) = mix_packet(&[queue(&[0.8, -0.8]), queue(&[0.7, -0.7])]);
    assert_eq!(&pcm[..2], &[1.0, -1.0]);
    assert_eq!(bytes, 8);
  }

  #[test]
  fn short_queue_is_silent_and_only_real_frames_count() {
    let (pcm, bytes) = mix_packet(&[queue(&[0.25, 0.5])]);
    assert_eq!(&pcm[..4], &[0.25, 0.5, 0.0, 0.0]);
    assert_eq!(bytes, 4);
  }

  #[test]
  fn backlog_drops_oldest_frames() {
    let mut pending = VecDeque::new();
    append_samples(&mut pending, (0..(MAX_BACKLOG_FRAMES + 1) * 2).map(|v| v as f32), 2);
    assert_eq!(pending.len(), MAX_BACKLOG_FRAMES * 2);
    assert_eq!(pending.front().copied(), Some(2.0));
  }

  #[test]
  fn packet_timestamps_have_twenty_millisecond_cadence() {
    assert_eq!(packet_pts(1234, 7), 1_401_234);
  }

  #[test]
  fn mono_duplicates_each_sample() {
    let mut pending = VecDeque::new();
    append_samples(&mut pending, [0.25, -0.5].into_iter(), 1);
    assert_eq!(pending.into_iter().collect::<Vec<_>>(), vec![0.25, 0.25, -0.5, -0.5]);
  }

  #[test]
  fn opus_encodes_silence_and_tone() {
    let encoder = OpusEncoder::new().unwrap();
    let silence = [0.0; PACKET_FRAMES * 2];
    assert!(!encoder.encode(&silence).unwrap().is_empty());
    let tone = std::array::from_fn(|i| ((i / 2) as f32 * 440.0 * std::f32::consts::TAU / SAMPLE_RATE as f32).sin() * 0.5);
    assert!(!encoder.encode(&tone).unwrap().is_empty());
  }

  #[test]
  #[ignore]
  fn captures_the_default_sink_monitor_for_a_second() {
    let capture = start(AudioRequest { system_audio: true, microphone: false, microphone_node: None }, |_| 0, |_, _| {}).unwrap();
    thread::sleep(Duration::from_secs(1));
    let summary = capture.stop().unwrap();
    assert!(summary.packets >= 45, "only {} audio packets", summary.packets);
  }
}
