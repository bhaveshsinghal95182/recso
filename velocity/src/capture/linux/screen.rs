//! Screen and window recording on Linux.
//!
//! The portal grants a PipeWire node, the stream copies each frame off the
//! compositor's buffer, and an encoder thread writes them to MP4. The copy is
//! the seam: the PipeWire callback must return quickly, and encoding a frame
//! does not, so the two run on different threads with a short queue between
//! them. When the encoder falls behind, frames are dropped at the queue rather
//! than held -- the same trade the Windows capture makes.
//!
//! Frames are written as they arrive, so a still screen produces a still
//! stretch of video with no frames in it, exactly as on Windows.

use std::path::PathBuf;
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use super::super::recording_info::RecordingStats;
use super::super::stopper::Stopper;
use super::audio::{self, AudioCapture, AudioRequest};
use super::encoder::{AudioSettings, Mp4Recorder, PixelOrder, VideoSettings};
use super::pipewire_stream::{self, Frame, NodeSource, NodeStream};
use super::portal::{self, Session};
use crate::cursor::HardwareCursor;

/// A frame copied off the PipeWire buffer, waiting for the encoder.
struct OwnedFrame {
  pixels: Vec<u8>,
  width: u32,
  height: u32,
  stride: usize,
  order: PixelOrder,
  pts_100ns: i64,
}

/// Frames that may wait for the encoder before new ones are dropped.
const FRAME_QUEUE: usize = 2;

/// How often the encoder thread checks for a stop between frames.
const STOP_POLL: Duration = Duration::from_millis(50);

/// The clock every Linux capture stamps against, in 100 ns units.
///
/// Monotonic and shared by the process, so a second capture started later in
/// the same recording (the webcam, the microphone) lands on the same timeline.
pub(crate) fn now_100ns(at: Instant) -> i64 {
  static ORIGIN: OnceLock<Instant> = OnceLock::new();
  let origin = *ORIGIN.get_or_init(Instant::now);
  (at.saturating_duration_since(origin).as_nanos() / 100) as i64
}

fn resolved_fps(target_fps: Option<u32>) -> u32 {
  match target_fps {
    Some(30) => 30,
    _ => 60,
  }
}

pub(crate) fn start_monitor_recording_with_target_fps(
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  include_microphone: Option<bool>,
  microphone_device_id: Option<String>,
  target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  let system_audio = include_system_audio.unwrap_or(false);
  let microphone = include_microphone.unwrap_or(false);
  let audio = (system_audio || microphone).then_some(AudioRequest {
    system_audio,
    microphone,
    microphone_node: microphone_device_id,
  });
  start(output_path, bitrate, target_fps, audio).map_err(napi::Error::from_reason)
}

/// There is no window list to pick from on Wayland, so the title is not
/// used: the portal's picker offers windows as well as screens.
pub(crate) fn start_window_recording_with_target_fps(
  _window_title: String,
  output_path: String,
  bitrate: u32,
  include_system_audio: Option<bool>,
  include_microphone: Option<bool>,
  microphone_device_id: Option<String>,
  target_fps: Option<u32>,
) -> napi::Result<Stopper> {
  start_monitor_recording_with_target_fps(
    output_path,
    bitrate,
    include_system_audio,
    include_microphone,
    microphone_device_id,
    target_fps,
  )
}

/// Record this PipeWire node instead of asking the portal. For testing the
/// whole app unattended -- the portal's picker needs a person to click it.
const TEST_NODE_VARIABLE: &str = "VELOCITY_TEST_PIPEWIRE_NODE";

fn start(
  output_path: String,
  bitrate: u32,
  target_fps: Option<u32>,
  audio: Option<AudioRequest>,
) -> Result<Stopper, String> {
  let fps = resolved_fps(target_fps);

  if let Some(node_id) = std::env::var(TEST_NODE_VARIABLE)
    .ok()
    .and_then(|value| value.parse::<u32>().ok())
  {
    eprintln!("[velocity] {TEST_NODE_VARIABLE}={node_id}: recording that node, not asking the portal");
    let source = NodeSource {
      remote: None,
      node_id,
    };
    return record(source, PathBuf::from(&output_path), fps, bitrate, audio)
      .map(|recording| recording.into_stopper(None));
  }

  // Before the picker, so the very first frame is already free of it.
  let cursor = HardwareCursor::acquire();
  let (grant, session) = portal::open(true)?;
  let source = NodeSource {
    remote: Some(grant.remote),
    node_id: grant.node_id,
  };
  match record(source, PathBuf::from(&output_path), fps, bitrate, audio) {
    Ok(recording) => Ok(recording.into_stopper(Some((session, cursor)))),
    Err(error) => {
      session.close();
      Err(error)
    }
  }
}

/// A recording whose stream is running but whose encoder thread has not been
/// handed the portal session yet.
struct Recording {
  stream: NodeStream,
  frames: Receiver<OwnedFrame>,
  audio: Option<AudioCapture>,
  packets: Receiver<(Vec<u8>, i64)>,
  stats: Arc<RecordingStats>,
  path: PathBuf,
  fps: u32,
  bitrate: u32,
}

/// Start the stream. Split from `start` so tests can record from a node that
/// did not come through the portal.
fn record(
  source: NodeSource,
  path: PathBuf,
  fps: u32,
  bitrate: u32,
  audio: Option<AudioRequest>,
) -> Result<Recording, String> {
  let stats = Arc::new(RecordingStats::new(
    path.to_string_lossy().into_owned(),
    "screen",
    fps,
    bitrate,
    "h264",
  ));
  let (frame_tx, frame_rx) = sync_channel::<OwnedFrame>(FRAME_QUEUE);

  let stream = pipewire_stream::start(source, fps, move |frame: Frame<'_>| {
    let owned = OwnedFrame {
      pixels: frame.pixels.to_vec(),
      width: frame.width,
      height: frame.height,
      stride: frame.stride,
      order: frame.order,
      pts_100ns: now_100ns(frame.received),
    };
    // Full means the encoder is behind; this frame is the one that goes.
    let _ = frame_tx.try_send(owned);
  })?;

  // Audio starts after the picture so its first packet is never older than
  // the first frame; the recorder drops audio from before the first frame.
  let (packet_tx, packet_rx) = channel::<(Vec<u8>, i64)>();
  let audio = match audio {
    Some(request) => match audio::start(request, now_100ns, move |packet: &[u8], pts: i64| {
      let _ = packet_tx.send((packet.to_vec(), pts));
    }) {
      Ok(capture) => Some(capture),
      Err(error) => {
        let _ = stream.stop();
        return Err(error);
      }
    },
    None => None,
  };

  Ok(Recording {
    stream,
    frames: frame_rx,
    audio,
    packets: packet_rx,
    stats,
    path,
    fps,
    bitrate,
  })
}

impl Recording {
  /// `portal` is the grant to close once the stream is done, and the cursor
  /// setting to hand back with it; tests that record a node directly have
  /// neither.
  fn into_stopper(self, portal: Option<(Session, HardwareCursor)>) -> Stopper {
    let stats = self.stats.clone();
    let (stop_tx, stop_rx) = channel::<()>();
    let (done_tx, done_rx) = channel::<()>();
    thread::Builder::new()
      .name("velocity-linux-encoder".to_string())
      .spawn(move || {
        let result = self.run(stop_rx);
        if let Err(error) = result {
          eprintln!("[velocity] Linux screen recording failed: {error}");
        }
        if let Some((session, cursor)) = portal {
          session.close();
          drop(cursor);
        }
        let _ = done_tx.send(());
      })
      .map(|_| ())
      .unwrap_or_else(|error| eprintln!("[velocity] could not start the encoder thread: {error}"));
    Stopper::with_stats(stop_tx, done_rx, stats)
  }

  /// Encode until told to stop, then shut down stream-first so no frame
  /// arrives after the file is finalised.
  fn run(self, stop: Receiver<()>) -> Result<(), String> {
    let Recording {
      stream,
      frames,
      audio,
      packets,
      stats,
      path,
      fps,
      bitrate,
    } = self;
    let mut recorder: Option<Mp4Recorder> = None;

    let with_audio = audio.is_some();
    let encode = |frame: OwnedFrame, recorder: &mut Option<Mp4Recorder>| -> Result<(), String> {
      if recorder.is_none() {
        let created = Mp4Recorder::create(
          &path,
          VideoSettings {
            width: frame.width,
            height: frame.height,
            fps,
            bitrate,
          },
          with_audio.then_some(AudioSettings { channels: 2 }),
        )?;
        *recorder = Some(created);
      }
      let Some(active) = recorder.as_mut() else {
        return Ok(());
      };
      active.push_frame(
        &frame.pixels,
        frame.width,
        frame.height,
        frame.stride,
        frame.order,
        frame.pts_100ns,
      )?;
      stats.note_frame(frame.pts_100ns);
      Ok(())
    };

    // Audio packets go in between frames. Before the first frame there is no
    // recorder yet, and the recorder would drop them anyway: audio cannot
    // start before the picture does.
    let drain_audio = |recorder: &mut Option<Mp4Recorder>| -> Result<(), String> {
      while let Ok((packet, pts)) = packets.try_recv() {
        if let Some(active) = recorder.as_mut() {
          active.push_audio_packet(&packet, pts)?;
        }
      }
      Ok(())
    };

    let mut failure = None;
    loop {
      match stop.try_recv() {
        Ok(()) | Err(TryRecvError::Disconnected) => break,
        Err(TryRecvError::Empty) => {}
      }
      let step = match frames.recv_timeout(STOP_POLL) {
        Ok(frame) => encode(frame, &mut recorder),
        Err(RecvTimeoutError::Timeout) => Ok(()),
        Err(RecvTimeoutError::Disconnected) => break,
      }
      .and_then(|()| drain_audio(&mut recorder));
      if let Err(error) = step {
        failure = Some(error);
        break;
      }
    }

    // Picture first, then sound, so neither outlives the other by more than
    // the time it takes to stop.
    let stream_result = stream.stop();
    let audio_result = audio.map(AudioCapture::stop).transpose();
    if failure.is_none() {
      while let Ok(frame) = frames.try_recv() {
        if let Err(error) = encode(frame, &mut recorder) {
          failure = Some(error);
          break;
        }
      }
    }
    if failure.is_none() {
      if let Err(error) = drain_audio(&mut recorder) {
        failure = Some(error);
      }
    }

    if let Some(recorder) = recorder {
      let summary = recorder.finish()?;
      stats.set_dimensions(summary.width, summary.height);
    }

    match audio_result {
      Ok(Some(summary)) => stats.note_captured_audio_bytes(summary.captured_bytes),
      Ok(None) => {}
      Err(error) => failure = failure.or(Some(error)),
    }

    match failure {
      Some(error) => Err(error),
      None => stream_result,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::process::{Child, Command, Stdio};

  /// A GStreamer test pattern published as a PipeWire video node -- a
  /// development tool standing in for the node the portal would grant, so the
  /// whole path runs without a person at the picker.
  struct TestSource(Child);

  impl Drop for TestSource {
    fn drop(&mut self) {
      let _ = self.0.kill();
      let _ = self.0.wait();
    }
  }

  fn test_source(name: &str) -> (TestSource, u32) {
    let child = Command::new("gst-launch-1.0")
      .args([
        "-q",
        "videotestsrc",
        "is-live=true",
        "pattern=ball",
        "!",
        "video/x-raw,format=BGRx,width=640,height=480,framerate=30/1",
        "!",
        "pipewiresink",
        "mode=provide",
        &format!("stream-properties=p,media.class=Video/Source,node.name={name}"),
      ])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .expect("gst-launch-1.0 (dev tool) must be installed for this test");
    let source = TestSource(child);
    for _ in 0..50 {
      let dump = Command::new("pw-dump").output().expect("pw-dump");
      let nodes: serde_json::Value = serde_json::from_slice(&dump.stdout).unwrap_or_default();
      let id = nodes.as_array().and_then(|nodes| {
        nodes.iter().find_map(|node| {
          (node.pointer("/info/props/node.name")?.as_str()? == name)
            .then(|| node.get("id")?.as_u64())
            .flatten()
        })
      });
      if let Some(id) = id {
        return (source, id as u32);
      }
      thread::sleep(Duration::from_millis(100));
    }
    panic!("the test source never appeared in PipeWire");
  }

  #[test]
  #[ignore = "needs PipeWire and GStreamer (dev tools); run with --ignored"]
  fn records_a_pipewire_node_to_a_playable_mp4() {
    let (_source, node_id) = test_source("velocity-screen-test");
    let path = std::env::temp_dir().join("velocity-screen-test.mp4");
    let _ = std::fs::remove_file(&path);

    let recording = record(
      NodeSource {
        remote: None,
        node_id,
      },
      path.clone(),
      30,
      4_000_000,
      None,
    )
    .expect("stream starts");
    let mut stopper = recording.into_stopper(None);
    thread::sleep(Duration::from_secs(2));
    let info = stopper.stop();

    assert_eq!(info.len(), 1);
    let screen = &info[0];
    assert_eq!((screen.width, screen.height), (640, 480));
    assert!(screen.frames >= 45, "only {} frames in 2 s at 30 fps", screen.frames);
    assert!(screen.file_size > 0.0);

    let file = std::fs::File::open(&path).expect("recording exists");
    let size = file.metadata().expect("metadata").len();
    let mp4 = mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).expect("valid mp4");
    let video = mp4.tracks().values().next().expect("a video track");
    assert_eq!((video.width(), video.height()), (640, 480));
    assert!(video.sample_count() >= 45);
  }

  #[test]
  #[ignore = "needs PipeWire and GStreamer (dev tools); run with --ignored"]
  fn records_system_audio_alongside_the_picture() {
    let (_source, node_id) = test_source("velocity-screen-audio-test");
    let path = std::env::temp_dir().join("velocity-screen-audio-test.mp4");
    let _ = std::fs::remove_file(&path);

    let recording = record(
      NodeSource {
        remote: None,
        node_id,
      },
      path.clone(),
      30,
      4_000_000,
      Some(AudioRequest {
        system_audio: true,
        microphone: false,
        microphone_node: None,
      }),
    )
    .expect("stream and audio start");
    let mut stopper = recording.into_stopper(None);
    thread::sleep(Duration::from_secs(2));
    let info = stopper.stop();
    assert_eq!(info.len(), 1);

    let file = std::fs::File::open(&path).expect("recording exists");
    let size = file.metadata().expect("metadata").len();
    let mp4 = mp4::Mp4Reader::read_header(std::io::BufReader::new(file), size).expect("valid mp4");
    let kinds: Vec<_> = mp4
      .tracks()
      .values()
      .map(|track| track.track_type().ok())
      .collect();
    assert!(kinds.contains(&Some(mp4::TrackType::Video)), "tracks: {kinds:?}");
    assert!(kinds.contains(&Some(mp4::TrackType::Audio)), "tracks: {kinds:?}");
    let audio = mp4
      .tracks()
      .values()
      .find(|track| track.track_type().ok() == Some(mp4::TrackType::Audio))
      .expect("audio track");
    // 20 ms packets over about two seconds, less the start-up before the
    // first frame.
    assert!(audio.sample_count() >= 60, "only {} audio packets", audio.sample_count());
  }
}
