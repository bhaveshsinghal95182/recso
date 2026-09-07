//! What the recorder knows about what it just wrote.
//!
//! The encoder configures the geometry, the codec and the bitrate, and the
//! capture handler sees every frame timestamp and every audio byte. All of
//! that used to be thrown away and then reconstructed afterwards by demuxing
//! the finished file with mediabunny -- which is slower, less accurate, and in
//! one case simply could not answer the question:
//!
//! - **fps** was not recoverable at all, so the editor hardcoded 30. Screen
//!   capture is variable-rate (Windows only delivers a frame when something
//!   changes), so the container's nominal rate is not the real one either.
//!   Frames over elapsed time is.
//! - **has audio** needed a whole demux pass, because windows-capture always
//!   writes an AAC track even when audio is off, so track presence means
//!   nothing and only a sample count distinguishes real audio from the stub.
//!   Here it is just "did we ever hand the encoder a byte we actually
//!   captured".
//! - **duration** came from `computeDuration()` over the whole file, after
//!   reading it into memory.
//!
//! Collected into an `Arc` the capture handler writes and the `Stopper` reads
//! once the encoder has been finalised.

use std::fs;
use std::sync::Mutex;
use std::time::Instant;

use napi_derive::napi;

/// Everything the editor needs about a finished recording.
///
/// Deliberately a plain snapshot rather than a handle: it crosses into JS once,
/// at stop, and is then persisted with the project.
#[napi(object)]
pub struct RecordingMediaInfo {
  pub output_path: String,
  /// `screen` or `webcam`. One recording can produce both.
  pub role: String,
  /// Encoder geometry, taken from the first frame that arrived.
  pub width: u32,
  pub height: u32,
  /// Frames actually handed to the encoder.
  pub frames: u32,
  /// How long capture actually ran: first frame to stop signal, on the wall
  /// clock. Frame timestamps cannot give this -- a static screen delivers no
  /// frames, and nothing in the stream says how long the last one stayed up.
  pub duration_ms: f64,
  /// Frames over `duration_ms`. Screen capture is variable-rate, so on a quiet
  /// desktop this is legitimately a fraction of `configured_fps`. It is an
  /// average, not a cadence: for anything frame-exact use `frames` with
  /// `duration_ms`.
  pub fps: f64,
  /// The capture rate we asked Windows for.
  pub configured_fps: u32,
  pub bitrate: u32,
  pub codec: String,
  /// True only when captured audio bytes actually reached the encoder. The
  /// file always contains an AAC track regardless; this is the one that says
  /// whether it carries anything.
  pub has_audio: bool,
  /// Bytes on disk, read after the encoder was finalised.
  pub file_size: f64,
  /// False when the capture produced no frames at all -- a failed recording
  /// that still wrote a container header.
  pub usable: bool,
}

struct Inner {
  width: u32,
  height: u32,
  frames: u64,
  first_timestamp_100ns: Option<i64>,
  last_timestamp_100ns: Option<i64>,
  captured_audio_bytes: u64,
  /// Wall clock at the first frame, and at the moment capture was told to
  /// stop. Frame timestamps alone cannot give the real length: on a static
  /// screen the last frame can sit there for most of a second, and nothing in
  /// the timestamps says how long it stayed.
  first_frame_at: Option<Instant>,
  stopped_at: Option<Instant>,
}

/// Shared between the capture thread and whoever stops it.
pub struct RecordingStats {
  output_path: String,
  role: &'static str,
  configured_fps: u32,
  bitrate: u32,
  codec: &'static str,
  inner: Mutex<Inner>,
}

impl RecordingStats {
  pub fn new(
    output_path: String,
    role: &'static str,
    configured_fps: u32,
    bitrate: u32,
    codec: &'static str,
  ) -> Self {
    Self {
      output_path,
      role,
      configured_fps,
      bitrate,
      codec,
      inner: Mutex::new(Inner {
        width: 0,
        height: 0,
        frames: 0,
        first_timestamp_100ns: None,
        last_timestamp_100ns: None,
        captured_audio_bytes: 0,
        first_frame_at: None,
        stopped_at: None,
      }),
    }
  }

  /// Geometry is not known until the first frame arrives -- the encoder is
  /// built from it precisely so the two cannot disagree.
  pub fn set_dimensions(&self, width: u32, height: u32) {
    if let Ok(mut inner) = self.inner.lock() {
      inner.width = width;
      inner.height = height;
    }
  }

  pub fn note_frame(&self, timestamp_100ns: i64) {
    if let Ok(mut inner) = self.inner.lock() {
      inner.frames += 1;
      if inner.first_timestamp_100ns.is_none() {
        inner.first_timestamp_100ns = Some(timestamp_100ns);
        inner.first_frame_at = Some(Instant::now());
      }
      inner.last_timestamp_100ns = Some(timestamp_100ns);
    }
  }

  /// Mark the moment capture was told to stop.
  ///
  /// Call this as the stop signal goes out, not after waiting for the encoder
  /// to finalise -- flushing an MP4 takes long enough to show up in the
  /// duration.
  pub fn mark_stopped(&self) {
    if let Ok(mut inner) = self.inner.lock() {
      inner.stopped_at.get_or_insert_with(Instant::now);
    }
  }

  /// Bytes that came from the capture device, not the zero padding used to
  /// keep the audio buffer aligned to the frame cadence.
  pub fn note_captured_audio_bytes(&self, bytes: u64) {
    if bytes == 0 {
      return;
    }
    if let Ok(mut inner) = self.inner.lock() {
      inner.captured_audio_bytes += bytes;
    }
  }

  /// Read the file size too, so call this after the encoder is finalised.
  pub fn snapshot(&self) -> RecordingMediaInfo {
    let inner = match self.inner.lock() {
      Ok(inner) => inner,
      Err(poisoned) => poisoned.into_inner(),
    };

    let span_100ns = match (inner.first_timestamp_100ns, inner.last_timestamp_100ns) {
      (Some(first), Some(last)) if last > first => (last - first) as f64,
      _ => 0.0,
    };

    // How long the recording actually ran.
    //
    // Frame timestamps mark when each frame *starts*, so the span from first to
    // last is short by however long the final frame stayed on screen -- and on
    // a static desktop that can be most of a second, because Windows only
    // delivers a frame when something changes. Wall clock from the first frame
    // to the stop signal is the only thing that knows.
    //
    // Falls back to the timestamp span plus one average interval when the stop
    // instant is missing, which is the best guess available.
    let duration_ms = match (inner.first_frame_at, inner.stopped_at) {
      (Some(first), Some(stopped)) if stopped > first => stopped.duration_since(first).as_secs_f64() * 1000.0,
      _ if inner.frames == 0 => 0.0,
      _ => {
        let intervals = inner.frames.saturating_sub(1) as f64;
        let mean_interval_100ns = if intervals > 0.0 && span_100ns > 0.0 {
          span_100ns / intervals
        } else if self.configured_fps > 0 {
          10_000_000.0 / f64::from(self.configured_fps)
        } else {
          0.0
        };
        (span_100ns + mean_interval_100ns) / 10_000.0
      }
    };

    // Frames over how long we were recording. On an idle screen this is
    // legitimately tiny -- 1.4fps against a requested 60 is not a bug, it is
    // what variable-rate capture does when nothing moves.
    let fps = if duration_ms > 0.0 && inner.frames > 0 {
      inner.frames as f64 / (duration_ms / 1000.0)
    } else {
      0.0
    };

    let file_size = fs::metadata(&self.output_path)
      .map(|meta| meta.len() as f64)
      .unwrap_or(0.0);

    RecordingMediaInfo {
      output_path: self.output_path.clone(),
      role: self.role.to_string(),
      width: inner.width,
      height: inner.height,
      frames: inner.frames.min(u64::from(u32::MAX)) as u32,
      duration_ms,
      fps,
      configured_fps: self.configured_fps,
      bitrate: self.bitrate,
      codec: self.codec.to_string(),
      has_audio: inner.captured_audio_bytes > 0,
      file_size,
      usable: inner.frames > 0 && inner.width > 0 && inner.height > 0,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn stats() -> RecordingStats {
    RecordingStats::new("does-not-exist.mp4".into(), "screen", 60, 8_000_000, "h264")
  }

  #[test]
  fn a_recording_with_no_frames_is_not_usable() {
    let snapshot = stats().snapshot();
    assert!(!snapshot.usable);
    assert_eq!(snapshot.frames, 0);
    assert_eq!(snapshot.duration_ms, 0.0);
  }

  /// Without a stop instant there is nothing but the timestamps, so the old
  /// estimate stands in: the span plus one average interval.
  #[test]
  fn duration_falls_back_to_the_timestamp_span_when_capture_never_stopped() {
    let stats = stats();
    stats.set_dimensions(1920, 1080);

    // 5 frames, 20ms apart.
    for index in 0..5 {
      stats.note_frame(index * 200_000);
    }

    let snapshot = stats.snapshot();
    assert_eq!(snapshot.frames, 5);
    assert_eq!(snapshot.configured_fps, 60);
    // 4 intervals of 20ms, plus one interval of tail.
    assert!(
      (snapshot.duration_ms - 100.0).abs() < 0.001,
      "duration was {}",
      snapshot.duration_ms
    );
    assert!(snapshot.usable);
  }

  /// The real path. Duration is wall clock, and fps follows from it -- not from
  /// the frame timestamps, which say nothing about how long the last frame
  /// stayed on a screen that stopped changing.
  #[test]
  fn duration_is_wall_clock_from_first_frame_to_stop() {
    let stats = stats();
    stats.set_dimensions(1920, 1080);
    stats.note_frame(0);
    std::thread::sleep(std::time::Duration::from_millis(60));
    stats.note_frame(200_000);
    stats.mark_stopped();

    let snapshot = stats.snapshot();
    assert_eq!(snapshot.frames, 2);
    assert!(
      snapshot.duration_ms >= 55.0 && snapshot.duration_ms < 400.0,
      "duration was {}",
      snapshot.duration_ms
    );
    // 2 frames over ~60ms is roughly 33fps, nowhere near the requested 60.
    let expected_fps = 2.0 / (snapshot.duration_ms / 1000.0);
    assert!((snapshot.fps - expected_fps).abs() < 0.001, "fps was {}", snapshot.fps);
  }

  /// A single frame held for a long time is the case that broke the old
  /// estimate: it invented one frame interval of duration and undercounted by
  /// however long the screen sat still.
  #[test]
  fn a_single_frame_held_for_a_while_reports_the_time_it_was_held() {
    let stats = stats();
    stats.set_dimensions(1280, 720);
    stats.note_frame(1_000_000);
    std::thread::sleep(std::time::Duration::from_millis(80));
    stats.mark_stopped();

    let snapshot = stats.snapshot();
    assert_eq!(snapshot.frames, 1);
    // Not 1000/60 = 16.7ms, which is what assuming one frame of tail gave.
    assert!(
      snapshot.duration_ms >= 75.0,
      "duration was {}, should reflect the time the frame was held",
      snapshot.duration_ms
    );
  }

  #[test]
  fn audio_is_reported_only_when_captured_bytes_arrived() {
    let stats = stats();
    assert!(!stats.snapshot().has_audio);

    // Padding must not count -- every video-only recording writes an AAC track.
    stats.note_captured_audio_bytes(0);
    assert!(!stats.snapshot().has_audio);

    stats.note_captured_audio_bytes(4);
    assert!(stats.snapshot().has_audio);
  }
}

#[cfg(test)]
mod usability_scenarios {
  use super::*;

  fn stats() -> RecordingStats {
    RecordingStats::new("does-not-exist.mp4".into(), "screen", 60, 8_000_000, "h264")
  }

  #[test]
  fn a_recording_with_frames_and_geometry_is_usable() {
    let s = stats();
    s.set_dimensions(1920, 1080);
    s.note_frame(0);
    assert!(s.snapshot().usable);
  }

  #[test]
  fn frames_without_geometry_are_not_usable() {
    // A capture that produced frames but never told us how big they were means
    // the encoder was never built, so the container is a header and nothing.
    let s = stats();
    s.note_frame(0);
    assert!(!s.snapshot().usable);
  }

  #[test]
  fn geometry_without_frames_is_not_usable() {
    let s = stats();
    s.set_dimensions(1920, 1080);
    assert!(!s.snapshot().usable);
  }

  #[test]
  fn a_zero_sided_geometry_is_not_usable() {
    for (w, h) in [(0u32, 1080u32), (1920, 0), (0, 0)] {
      let s = stats();
      s.set_dimensions(w, h);
      s.note_frame(0);
      assert!(!s.snapshot().usable, "{w}x{h}");
    }
  }

  #[test]
  fn geometry_is_reported_as_it_was_set() {
    let s = stats();
    s.set_dimensions(1280, 720);
    let snapshot = s.snapshot();
    assert_eq!(snapshot.width, 1280);
    assert_eq!(snapshot.height, 720);
  }

  #[test]
  fn a_later_geometry_replaces_an_earlier_one() {
    let s = stats();
    s.set_dimensions(640, 480);
    s.set_dimensions(1920, 1080);
    let snapshot = s.snapshot();
    assert_eq!((snapshot.width, snapshot.height), (1920, 1080));
  }

  #[test]
  fn frames_are_counted() {
    let s = stats();
    for i in 0..37 {
      s.note_frame(i * 166_667);
    }
    assert_eq!(s.snapshot().frames, 37);
  }

  #[test]
  fn the_configured_settings_are_reported_back_unchanged() {
    let snapshot = stats().snapshot();
    assert_eq!(snapshot.configured_fps, 60);
    assert_eq!(snapshot.bitrate, 8_000_000);
    assert_eq!(snapshot.codec, "h264");
    assert_eq!(snapshot.role, "screen");
    assert_eq!(snapshot.output_path, "does-not-exist.mp4");
  }

  #[test]
  fn a_webcam_recording_reports_its_own_role() {
    let s = RecordingStats::new("cam.mp4".into(), "webcam", 30, 4_000_000, "h264");
    assert_eq!(s.snapshot().role, "webcam");
  }

  #[test]
  fn a_missing_file_reports_no_size_rather_than_failing() {
    assert_eq!(stats().snapshot().file_size, 0.0);
  }
}

#[cfg(test)]
mod audio_reporting_scenarios {
  use super::*;

  fn stats() -> RecordingStats {
    RecordingStats::new("does-not-exist.mp4".into(), "screen", 60, 8_000_000, "h264")
  }

  #[test]
  fn a_recording_with_no_audio_bytes_reports_no_audio() {
    // The file always contains an AAC track; this is the flag that says
    // whether it carries anything.
    assert!(!stats().snapshot().has_audio);
  }

  #[test]
  fn captured_bytes_turn_the_audio_flag_on() {
    let s = stats();
    s.note_captured_audio_bytes(192_000);
    assert!(s.snapshot().has_audio);
  }

  #[test]
  fn a_single_captured_byte_counts() {
    let s = stats();
    s.note_captured_audio_bytes(1);
    assert!(s.snapshot().has_audio);
  }

  #[test]
  fn zero_padding_does_not_count_as_audio() {
    // The frame buffer is zero-padded to stay aligned to the cadence; that
    // padding is not sound and must not make a silent take look recorded.
    let s = stats();
    for _ in 0..100 {
      s.note_captured_audio_bytes(0);
    }
    assert!(!s.snapshot().has_audio);
  }

  #[test]
  fn captured_bytes_accumulate_across_frames() {
    let s = stats();
    for _ in 0..10 {
      s.note_captured_audio_bytes(3200);
    }
    assert!(s.snapshot().has_audio);
  }

  #[test]
  fn a_late_burst_of_audio_still_registers() {
    let s = stats();
    s.note_captured_audio_bytes(0);
    s.note_captured_audio_bytes(0);
    s.note_captured_audio_bytes(4);
    assert!(s.snapshot().has_audio);
  }
}

#[cfg(test)]
mod rate_scenarios {
  use super::*;

  fn stats() -> RecordingStats {
    RecordingStats::new("does-not-exist.mp4".into(), "screen", 60, 8_000_000, "h264")
  }

  #[test]
  fn a_recording_with_no_frames_reports_no_rate() {
    let snapshot = stats().snapshot();
    assert_eq!(snapshot.fps, 0.0);
    assert_eq!(snapshot.duration_ms, 0.0);
  }

  #[test]
  fn the_duration_falls_back_to_the_timestamp_span_plus_one_interval() {
    // No stop instant, so the best guess available: the span the frames cover
    // plus how long the last one probably stayed up.
    let s = stats();
    s.note_frame(0);
    s.note_frame(1_000_000);
    s.note_frame(2_000_000);
    let snapshot = s.snapshot();
    // Two intervals of 100ms each, plus one more for the final frame.
    assert!((snapshot.duration_ms - 300.0).abs() < 1.0, "{}", snapshot.duration_ms);
  }

  #[test]
  fn a_single_frame_falls_back_to_the_configured_frame_period() {
    // Nothing to measure an interval from, so the requested rate is the only
    // thing that says how long one frame lasts.
    let s = stats();
    s.note_frame(0);
    let snapshot = s.snapshot();
    assert!((snapshot.duration_ms - 1000.0 / 60.0).abs() < 0.1, "{}", snapshot.duration_ms);
  }

  #[test]
  fn a_single_frame_with_no_configured_rate_reports_no_duration() {
    let s = RecordingStats::new("does-not-exist.mp4".into(), "screen", 0, 1, "h264");
    s.note_frame(0);
    assert_eq!(s.snapshot().duration_ms, 0.0);
  }

  #[test]
  fn the_rate_is_frames_over_the_duration() {
    let s = stats();
    // Ten frames spanning 900ms, so the fallback duration is 1000ms.
    for i in 0..10 {
      s.note_frame(i * 1_000_000);
    }
    let snapshot = s.snapshot();
    assert!((snapshot.fps - 10.0).abs() < 0.2, "{}", snapshot.fps);
  }

  #[test]
  fn an_idle_screen_reporting_a_low_rate_is_not_treated_as_a_failure() {
    // Variable-rate capture delivers a frame only when something changes, so
    // 1.4fps against a requested 60 is what an idle desktop looks like.
    let s = stats();
    s.set_dimensions(1920, 1080);
    for i in 0..3 {
      s.note_frame(i * 10_000_000);
    }
    let snapshot = s.snapshot();
    assert!(snapshot.usable);
    assert!(snapshot.fps < 5.0, "{}", snapshot.fps);
  }

  #[test]
  fn frames_arriving_with_the_same_timestamp_do_not_divide_by_zero() {
    let s = stats();
    for _ in 0..5 {
      s.note_frame(1000);
    }
    let snapshot = s.snapshot();
    assert!(snapshot.fps.is_finite());
    assert!(snapshot.duration_ms.is_finite());
  }

  #[test]
  fn a_timestamp_going_backwards_does_not_produce_a_negative_span() {
    let s = stats();
    s.note_frame(5_000_000);
    s.note_frame(1_000_000);
    let snapshot = s.snapshot();
    assert!(snapshot.duration_ms >= 0.0, "{}", snapshot.duration_ms);
    assert!(snapshot.fps >= 0.0);
  }

  #[test]
  fn marking_stopped_switches_the_duration_to_the_wall_clock() {
    let s = stats();
    s.note_frame(0);
    s.mark_stopped();
    let snapshot = s.snapshot();
    // Wall clock from the first frame to the stop signal, which here is a
    // sliver rather than the configured frame period.
    assert!(snapshot.duration_ms < 1000.0 / 60.0, "{}", snapshot.duration_ms);
  }

  #[test]
  fn marking_stopped_twice_keeps_the_first_instant() {
    // Called as the stop signal goes out, not after the encoder finalises --
    // flushing an MP4 takes long enough to show up in the duration.
    let s = stats();
    s.note_frame(0);
    s.mark_stopped();
    let first = s.snapshot().duration_ms;
    s.mark_stopped();
    assert_eq!(s.snapshot().duration_ms, first);
  }

  #[test]
  fn stopping_without_ever_seeing_a_frame_still_reports_nothing() {
    let s = stats();
    s.mark_stopped();
    let snapshot = s.snapshot();
    assert_eq!(snapshot.duration_ms, 0.0);
    assert_eq!(snapshot.frames, 0);
  }

  #[test]
  fn a_snapshot_can_be_taken_more_than_once() {
    let s = stats();
    s.set_dimensions(1920, 1080);
    s.note_frame(0);
    let first = s.snapshot();
    let second = s.snapshot();
    assert_eq!(first.frames, second.frames);
    assert_eq!(first.width, second.width);
  }

  #[test]
  fn a_snapshot_does_not_consume_the_stats() {
    let s = stats();
    s.note_frame(0);
    let _ = s.snapshot();
    s.note_frame(1_000_000);
    assert_eq!(s.snapshot().frames, 2);
  }
}
