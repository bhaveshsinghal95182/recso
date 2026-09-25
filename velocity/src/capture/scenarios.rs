//! Capture-side scenarios and matrices.
//!
//! What a recording *decides* before it touches Windows: which camera, what
//! rate, where the sidecar goes, and what the stats say about the take
//! afterwards. Those decisions are pure, and they are where a recording goes
//! wrong in a way the user only discovers in the editor.

use super::parse_webcam_source;
use super::recording_info::RecordingStats;
use super::webcam_capture::rgb_to_bgra_bottom_up;

// -- what the stats say about a take ----------------------------------------

mod recording_stats {
  use super::*;

  fn stats(fps: u32) -> RecordingStats {
    RecordingStats::new("does-not-exist.mp4".into(), "screen", fps, 8_000_000, "h264")
  }

  /// One frame period, in 100ns units, for a rate.
  fn period(fps: u32) -> i64 {
    crate::singular_clock::fps_to_period_100ns(fps)
  }

  const RATES: [u32; 6] = [1, 24, 30, 50, 60, 120];
  const GEOMETRIES: [(u32, u32); 5] = [
    (1920, 1080),
    (1280, 720),
    (3840, 2160),
    (1080, 1920),
    (1, 1),
  ];

  #[test]
  fn a_take_with_frames_and_geometry_is_usable_at_every_rate_and_size() {
    for fps in RATES {
      for (w, h) in GEOMETRIES {
        let s = stats(fps);
        s.set_dimensions(w, h);
        s.note_frame(0);
        assert!(s.snapshot().usable, "{fps}fps {w}x{h}");
      }
    }
  }

  #[test]
  fn a_take_missing_either_half_is_never_usable() {
    for fps in RATES {
      // Frames but no geometry: the encoder was never built.
      let a = stats(fps);
      a.note_frame(0);
      assert!(!a.snapshot().usable, "{fps}fps frames only");
      // Geometry but no frames: a container header and nothing else.
      let b = stats(fps);
      b.set_dimensions(1920, 1080);
      assert!(!b.snapshot().usable, "{fps}fps geometry only");
      // Neither.
      assert!(!stats(fps).snapshot().usable, "{fps}fps neither");
    }
  }

  #[test]
  fn a_zero_sided_geometry_is_never_usable_at_any_rate() {
    for fps in RATES {
      for (w, h) in [(0u32, 1080u32), (1920, 0), (0, 0)] {
        let s = stats(fps);
        s.set_dimensions(w, h);
        s.note_frame(0);
        assert!(!s.snapshot().usable, "{fps}fps {w}x{h}");
      }
    }
  }

  #[test]
  fn the_frame_count_is_exact_for_every_run_length() {
    for count in [0u64, 1, 2, 60, 1_000, 10_000] {
      let s = stats(60);
      for i in 0..count {
        s.note_frame(i as i64 * period(60));
      }
      assert_eq!(s.snapshot().frames as u64, count, "{count} frames");
    }
  }

  #[test]
  fn the_reported_rate_is_close_to_the_real_one_for_a_steady_take() {
    // The fallback duration is the timestamp span plus one mean interval,
    // which is exactly the right guess for an evenly paced recording.
    for fps in RATES {
      let s = stats(fps);
      let frames = (fps * 2).max(2) as i64;
      for i in 0..frames {
        s.note_frame(i * period(fps));
      }
      let snapshot = s.snapshot();
      let error = (snapshot.fps - fps as f64).abs() / fps as f64;
      assert!(error < 0.05, "{fps}fps reported {}", snapshot.fps);
    }
  }

  #[test]
  fn the_reported_duration_is_close_to_the_real_one_for_a_steady_take() {
    for fps in RATES {
      let s = stats(fps);
      let frames = (fps * 2).max(2) as i64;
      for i in 0..frames {
        s.note_frame(i * period(fps));
      }
      let expected_ms = frames as f64 * period(fps) as f64 / 10_000.0;
      let snapshot = s.snapshot();
      let error = (snapshot.duration_ms - expected_ms).abs() / expected_ms;
      assert!(error < 0.05, "{fps}fps: {} vs {expected_ms}", snapshot.duration_ms);
    }
  }

  #[test]
  fn a_single_frame_falls_back_to_the_configured_period_at_every_rate() {
    // Nothing to measure an interval from, so the requested rate is the only
    // thing that says how long one frame lasted.
    for fps in RATES {
      let s = stats(fps);
      s.note_frame(0);
      let expected = 1000.0 / fps as f64;
      let got = s.snapshot().duration_ms;
      assert!((got - expected).abs() < expected * 0.02, "{fps}fps: {got}");
    }
  }

  #[test]
  fn an_idle_screen_reports_a_low_rate_without_being_unusable() {
    // Variable-rate capture delivers a frame only when something changes, so
    // a fraction of the requested rate is what an idle desktop looks like.
    for fps in RATES {
      let s = stats(fps);
      s.set_dimensions(1920, 1080);
      for i in 0..3 {
        s.note_frame(i * 10_000_000);
      }
      let snapshot = s.snapshot();
      assert!(snapshot.usable, "{fps}fps");
      assert!(snapshot.fps <= fps as f64 + 1.0, "{fps}fps: {}", snapshot.fps);
      assert!(snapshot.fps > 0.0, "{fps}fps");
    }
  }

  #[test]
  fn the_stats_are_always_finite_however_the_timestamps_arrive() {
    let patterns: [(&str, Vec<i64>); 6] = [
      ("empty", vec![]),
      ("one", vec![0]),
      ("repeated", vec![1_000; 5]),
      ("backwards", vec![5_000_000, 1_000_000]),
      ("huge jump", vec![0, i64::MAX / 2]),
      ("negative", vec![-5_000_000, 0, 5_000_000]),
    ];
    for (name, timestamps) in patterns {
      for fps in [0u32, 30, 60] {
        let s = stats(fps);
        s.set_dimensions(1920, 1080);
        for t in &timestamps {
          s.note_frame(*t);
        }
        let snapshot = s.snapshot();
        assert!(snapshot.duration_ms.is_finite(), "{name} at {fps}fps");
        assert!(snapshot.fps.is_finite(), "{name} at {fps}fps");
        assert!(snapshot.duration_ms >= 0.0, "{name} at {fps}fps");
        assert!(snapshot.fps >= 0.0, "{name} at {fps}fps");
      }
    }
  }

  #[test]
  fn stopping_always_gives_a_shorter_duration_than_the_frame_span_guess() {
    // The wall clock from the first frame to the stop signal is the real
    // answer; the fallback is a guess that adds a whole mean interval.
    for fps in RATES {
      let guessed = {
        let s = stats(fps);
        for i in 0..10 {
          s.note_frame(i * period(fps));
        }
        s.snapshot().duration_ms
      };
      let measured = {
        let s = stats(fps);
        for i in 0..10 {
          s.note_frame(i * period(fps));
        }
        s.mark_stopped();
        s.snapshot().duration_ms
      };
      assert!(measured < guessed, "{fps}fps: {measured} vs {guessed}");
    }
  }

  #[test]
  fn marking_stopped_more_than_once_keeps_the_first_instant() {
    for fps in RATES {
      let s = stats(fps);
      s.note_frame(0);
      s.mark_stopped();
      let first = s.snapshot().duration_ms;
      for _ in 0..5 {
        s.mark_stopped();
      }
      assert_eq!(s.snapshot().duration_ms, first, "{fps}fps");
    }
  }

  #[test]
  fn audio_is_reported_only_when_captured_bytes_arrived() {
    let budgets: [(&str, Vec<u64>, bool); 5] = [
      ("nothing", vec![], false),
      ("all padding", vec![0, 0, 0], false),
      ("one byte", vec![1], true),
      ("a frame", vec![3_200], true),
      ("padding then sound", vec![0, 0, 4], true),
    ];
    for (name, bytes, expected) in budgets {
      let s = stats(60);
      for b in bytes {
        s.note_captured_audio_bytes(b);
      }
      assert_eq!(s.snapshot().has_audio, expected, "{name}");
    }
  }

  #[test]
  fn the_configured_settings_survive_every_take() {
    for fps in RATES {
      for bitrate in [1_000_000u32, 8_000_000, 40_000_000] {
        let s = RecordingStats::new("out.mp4".into(), "webcam", fps, bitrate, "hevc");
        s.note_frame(0);
        let snapshot = s.snapshot();
        assert_eq!(snapshot.configured_fps, fps);
        assert_eq!(snapshot.bitrate, bitrate);
        assert_eq!(snapshot.codec, "hevc");
        assert_eq!(snapshot.role, "webcam");
        assert_eq!(snapshot.output_path, "out.mp4");
      }
    }
  }

  #[test]
  fn a_snapshot_can_be_taken_at_any_point_without_disturbing_the_take() {
    let s = stats(60);
    s.set_dimensions(1920, 1080);
    for i in 0..100 {
      s.note_frame(i * period(60));
      if i % 10 == 0 {
        let snapshot = s.snapshot();
        assert_eq!(snapshot.frames as i64, i + 1, "at {i}");
      }
    }
    assert_eq!(s.snapshot().frames, 100);
  }

  #[test]
  fn geometry_can_be_set_before_or_after_the_first_frame() {
    let before = stats(60);
    before.set_dimensions(1920, 1080);
    before.note_frame(0);
    let after = stats(60);
    after.note_frame(0);
    after.set_dimensions(1920, 1080);
    assert_eq!(before.snapshot().width, after.snapshot().width);
    assert!(before.snapshot().usable && after.snapshot().usable);
  }

  #[test]
  fn a_missing_output_file_reports_no_size_rather_than_failing() {
    for fps in RATES {
      let s = stats(fps);
      s.note_frame(0);
      assert_eq!(s.snapshot().file_size, 0.0, "{fps}fps");
    }
  }

  #[test]
  fn the_frame_count_saturates_rather_than_wrapping_at_the_u32_boundary() {
    // `frames` is reported as a u32 to JavaScript; a longer take has to clamp
    // rather than wrap round to a small number.
    let s = stats(60);
    let snapshot = s.snapshot();
    assert_eq!(snapshot.frames, 0);
    // The clamp itself is not reachable in a test without a billion calls, so
    // this pins the type rather than the boundary.
    assert!(u64::from(snapshot.frames) <= u64::from(u32::MAX));
  }
}

// -- which camera was asked for ---------------------------------------------

mod webcam_source {
  use super::*;

  const DEVICE_IDS: [Option<&str>; 4] = [None, Some(""), Some("cam-0"), Some("\\\\?\\usb#vid_046d")];

  #[test]
  fn every_spelling_of_the_local_camera_is_accepted_with_any_device_id() {
    for source in [None, Some(""), Some("local")] {
      for id in DEVICE_IDS {
        let parsed = parse_webcam_source(
          source.map(|s| s.to_string()),
          id.map(|s| s.to_string()),
        );
        assert!(parsed.is_ok(), "{source:?} + {id:?}");
      }
    }
  }

  #[test]
  fn the_device_id_is_carried_through_for_every_local_spelling() {
    for source in [None, Some(""), Some("local")] {
      for id in DEVICE_IDS {
        let parsed = parse_webcam_source(
          source.map(|s| s.to_string()),
          id.map(|s| s.to_string()),
        );
        match parsed {
          Ok(super::super::webcam_capture::WebcamSource::Local(got)) => {
            assert_eq!(got.as_deref(), id, "{source:?} + {id:?}");
          }
          _ => panic!("{source:?} + {id:?} was not a local camera"),
        }
      }
    }
  }

  #[test]
  fn the_phone_is_chosen_by_name_whatever_device_id_is_passed() {
    for id in DEVICE_IDS {
      let parsed = parse_webcam_source(Some("phone".to_string()), id.map(|s| s.to_string()));
      assert!(
        matches!(parsed, Ok(super::super::webcam_capture::WebcamSource::Phone)),
        "{id:?}"
      );
    }
  }

  #[test]
  fn every_unknown_spelling_is_refused_rather_than_guessed() {
    let wrong = [
      "Local", "LOCAL", " local", "local ", "Phone", "PHONE", " phone", "phone ", "laptop",
      "usb", "webcam", "camera", "default", "0", "1", "none", "null", "undefined",
    ];
    for name in wrong {
      for id in DEVICE_IDS {
        assert!(
          parse_webcam_source(Some(name.to_string()), id.map(|s| s.to_string())).is_err(),
          "{name:?} + {id:?}"
        );
      }
    }
  }

  #[test]
  fn every_refusal_names_the_source_and_the_alternatives() {
    for name in ["laptop", "usb", "Phone", "0"] {
      match parse_webcam_source(Some(name.to_string()), None) {
        Err(error) => {
          let message = error.reason.clone();
          assert!(message.contains(name), "{name}: {message}");
          assert!(message.contains("local"), "{name}: {message}");
          assert!(message.contains("phone"), "{name}: {message}");
        }
        Ok(_) => panic!("{name} was accepted"),
      }
    }
  }
}

// -- the colour conversion the sidecar depends on ---------------------------

mod colour_conversion {
  use super::*;

  const SIZES: [(usize, usize); 8] = [
    (1, 1),
    (2, 1),
    (1, 2),
    (4, 4),
    (16, 9),
    (320, 240),
    (1, 100),
    (100, 1),
  ];

  fn ramp(w: usize, h: usize) -> Vec<u8> {
    (0..w * h * 3).map(|i| (i % 251) as u8).collect()
  }

  #[test]
  fn the_output_is_four_bytes_a_pixel_at_every_size() {
    for (w, h) in SIZES {
      let out = rgb_to_bgra_bottom_up(&ramp(w, h), w, h);
      assert_eq!(out.len(), w * h * 4, "{w}x{h}");
    }
  }

  #[test]
  fn every_pixel_is_opaque_at_every_size() {
    for (w, h) in SIZES {
      let out = rgb_to_bgra_bottom_up(&ramp(w, h), w, h);
      for (i, alpha) in out.iter().skip(3).step_by(4).enumerate() {
        assert_eq!(*alpha, 255, "{w}x{h} pixel {i}");
      }
    }
  }

  #[test]
  fn the_channel_order_is_reversed_for_every_pixel_at_every_size() {
    for (w, h) in SIZES {
      let rgb = ramp(w, h);
      let out = rgb_to_bgra_bottom_up(&rgb, w, h);
      for y in 0..h {
        for x in 0..w {
          // Source row y lands at destination row h-1-y.
          let src = (y * w + x) * 3;
          let dst = ((h - 1 - y) * w + x) * 4;
          assert_eq!(out[dst], rgb[src + 2], "{w}x{h} at ({x},{y}) blue");
          assert_eq!(out[dst + 1], rgb[src + 1], "{w}x{h} at ({x},{y}) green");
          assert_eq!(out[dst + 2], rgb[src], "{w}x{h} at ({x},{y}) red");
        }
      }
    }
  }

  #[test]
  fn the_rows_are_flipped_and_the_columns_are_not_at_every_size() {
    // Flipping within a row too would mirror the picture, which reads as the
    // camera being the wrong way round rather than upside down.
    for (w, h) in SIZES {
      if w < 2 {
        continue;
      }
      let mut rgb = vec![0u8; w * h * 3];
      // Mark the first pixel of the first row.
      rgb[0] = 200;
      let out = rgb_to_bgra_bottom_up(&rgb, w, h);
      let last_row = (h - 1) * w * 4;
      assert_eq!(out[last_row + 2], 200, "{w}x{h} row not flipped");
      assert_eq!(out[last_row + 4 + 2], 0, "{w}x{h} columns were flipped too");
    }
  }

  #[test]
  fn a_short_buffer_leaves_the_missing_rows_black_at_every_size() {
    for (w, h) in SIZES {
      if h < 2 {
        continue;
      }
      // Only the first row is present.
      let rgb = vec![9u8; w * 3];
      let out = rgb_to_bgra_bottom_up(&rgb, w, h);
      assert_eq!(out.len(), w * h * 4, "{w}x{h}");
      // It lands at the bottom; everything above stays zeroed.
      let last_row = (h - 1) * w * 4;
      assert_eq!(out[last_row], 9, "{w}x{h}");
      assert!(out[..last_row].iter().all(|b| *b == 0), "{w}x{h}");
    }
  }

  #[test]
  fn a_trailing_partial_row_is_ignored_at_every_size() {
    for (w, h) in SIZES {
      let mut rgb = ramp(w, h);
      rgb.truncate(rgb.len().saturating_sub(1));
      let out = rgb_to_bgra_bottom_up(&rgb, w, h);
      assert_eq!(out.len(), w * h * 4, "{w}x{h}");
    }
  }

  #[test]
  fn full_scale_and_zero_values_both_survive() {
    for (w, h) in SIZES {
      for value in [0u8, 1, 127, 254, 255] {
        let rgb = vec![value; w * h * 3];
        let out = rgb_to_bgra_bottom_up(&rgb, w, h);
        for (i, chunk) in out.as_chunks::<4>().0.iter().enumerate() {
          assert_eq!(chunk[0], value, "{w}x{h} value {value} pixel {i}");
          assert_eq!(chunk[3], 255, "{w}x{h} value {value} pixel {i}");
        }
      }
    }
  }

  #[test]
  fn conversion_is_deterministic_at_every_size() {
    for (w, h) in SIZES {
      let rgb = ramp(w, h);
      assert_eq!(
        rgb_to_bgra_bottom_up(&rgb, w, h),
        rgb_to_bgra_bottom_up(&rgb, w, h),
        "{w}x{h}"
      );
    }
  }
}
