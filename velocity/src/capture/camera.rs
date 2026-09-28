//! The camera track's file and timeline, shared by every webcam backend: where
//! the sidecar is written, what rate it records at, and how its frames are
//! stamped against the screen's clock so the two files line up.

use std::path::Path;

pub(crate) fn camera_sidecar_path(output_path: &str) -> String {
  let source = Path::new(output_path);
  let parent = source.parent().unwrap_or_else(|| Path::new(""));
  let stem = source
    .file_stem()
    .and_then(|value| value.to_str())
    .unwrap_or("recording");
  let ext = source
    .extension()
    .and_then(|value| value.to_str())
    .filter(|value| !value.is_empty())
    .unwrap_or("mp4");

  parent
    .join(format!("{}_camera.{}", stem, ext))
    .to_string_lossy()
    .to_string()
}

pub(crate) fn target_webcam_fps(target_fps: Option<u32>) -> u32 {
  match target_fps {
    Some(30) => 30,
    Some(60) | None => 60,
    Some(other) => {
      eprintln!(
        "[VelocityCapture] Requested unsupported webcam target_fps={other}. Falling back to 60 fps."
      );
      60
    }
  }
}

/// The timestamp for the next sidecar frame.
///
/// One frame period on from the last, but never behind the wall clock.
///
/// The period alone is what the loop used to do, and it is right only while the
/// loop actually hits its rate. When it cannot -- a busy machine, a software
/// encoder asked for 60fps of 720p -- the stamps keep advancing as though it
/// did, so N frames written over a longer T seconds get labelled N/fps seconds.
/// The camera track then comes out shorter than the recording and drifts
/// steadily ahead of the picture, which looks like the webcam running early
/// rather than like dropped frames.
///
/// Taking the clock as a floor keeps the original intent -- stamps advance even
/// when a frame fails, so the two tracks end the same length -- and adds the
/// part that was missing: they cannot advance faster than time did.
pub(crate) fn advance_stamp(current_100ns: i64, period_100ns: i64, elapsed_100ns: i64) -> i64 {
  current_100ns
    .saturating_add(period_100ns)
    .max(elapsed_100ns)
}

pub(crate) fn webcam_stamp(screen_origin: i64, received: i64, previous: i64) -> i64 {
  advance_stamp(previous, 1, received.saturating_sub(screen_origin).max(0))
}

#[cfg(test)]
mod sidecar_path_scenarios {
  use super::*;

  fn normalised(path: &str) -> String {
    camera_sidecar_path(path).replace('\\', "/")
  }

  #[test]
  fn the_camera_suffix_goes_before_the_extension() {
    assert_eq!(
      normalised("C:/takes/recording.mp4"),
      "C:/takes/recording_camera.mp4"
    );
  }

  #[test]
  fn the_directory_is_kept() {
    assert!(normalised("C:/a/b/c/take.mp4").starts_with("C:/a/b/c/"));
  }

  #[test]
  fn a_bare_filename_stays_bare() {
    assert_eq!(normalised("take.mp4"), "take_camera.mp4");
  }

  #[test]
  fn a_missing_extension_defaults_to_mp4() {
    // The sidecar is written by the same encoder as the screen track, so it is
    // an MP4 whatever the caller called the main file.
    assert_eq!(
      normalised("C:/takes/recording"),
      "C:/takes/recording_camera.mp4"
    );
  }

  #[test]
  fn an_empty_extension_defaults_to_mp4() {
    assert_eq!(
      normalised("C:/takes/recording."),
      "C:/takes/recording_camera.mp4"
    );
  }

  #[test]
  fn a_non_mp4_extension_is_preserved() {
    assert_eq!(normalised("C:/takes/take.mkv"), "C:/takes/take_camera.mkv");
    assert_eq!(
      normalised("C:/takes/take.webm"),
      "C:/takes/take_camera.webm"
    );
  }

  #[test]
  fn only_the_last_extension_counts() {
    assert_eq!(
      normalised("C:/takes/take.2024.mp4"),
      "C:/takes/take.2024_camera.mp4"
    );
  }

  #[test]
  fn a_name_with_spaces_survives() {
    assert_eq!(
      normalised("C:/my takes/screen recording.mp4"),
      "C:/my takes/screen recording_camera.mp4"
    );
  }

  #[test]
  fn a_dotfile_style_name_is_treated_as_a_stem() {
    // `.mp4` has no extension by `Path`'s reckoning, so the whole thing is the
    // stem and the default extension applies.
    assert!(normalised(".mp4").ends_with("_camera.mp4"));
  }

  #[test]
  fn an_empty_path_falls_back_to_a_named_recording() {
    assert_eq!(normalised(""), "recording_camera.mp4");
  }

  #[test]
  fn a_path_with_no_file_name_falls_back_to_a_named_recording() {
    assert!(normalised("C:/takes/").ends_with("_camera.mp4"));
  }

  #[test]
  fn the_result_always_carries_the_camera_marker() {
    for path in [
      "take.mp4",
      "C:/a/take.mp4",
      "C:/a/take",
      "",
      "C:/a/take.mkv",
      "weird name.with.dots.mp4",
    ] {
      assert!(normalised(path).contains("_camera."), "{path}");
    }
  }

  #[test]
  fn the_sidecar_never_collides_with_the_recording_it_accompanies() {
    for path in ["take.mp4", "C:/a/take.mp4", "C:/a/take.mkv"] {
      assert_ne!(normalised(path), path.replace('\\', "/"), "{path}");
    }
  }

  #[test]
  fn the_same_input_always_gives_the_same_sidecar() {
    assert_eq!(normalised("C:/a/take.mp4"), normalised("C:/a/take.mp4"));
  }
}

#[cfg(test)]
mod webcam_fps_scenarios {
  use super::*;

  #[test]
  fn asking_for_nothing_gives_60() {
    assert_eq!(target_webcam_fps(None), 60);
  }

  #[test]
  fn the_two_supported_rates_are_honoured() {
    assert_eq!(target_webcam_fps(Some(30)), 30);
    assert_eq!(target_webcam_fps(Some(60)), 60);
  }

  #[test]
  fn anything_else_falls_back_to_60() {
    for fps in [0u32, 1, 24, 25, 29, 31, 59, 61, 120, 144, u32::MAX] {
      assert_eq!(target_webcam_fps(Some(fps)), 60, "{fps}");
    }
  }

  #[test]
  fn the_result_is_always_a_rate_the_encoder_accepts() {
    for fps in [None, Some(0), Some(30), Some(60), Some(90), Some(u32::MAX)] {
      assert!(matches!(target_webcam_fps(fps), 30 | 60), "{fps:?}");
    }
  }
}

#[cfg(test)]
mod stamp_scenarios {
  use super::*;

  const PERIOD: i64 = 166_667;

  #[test]
  fn stamps_advance_by_one_period_when_the_loop_keeps_up() {
    // The clock has not run past the next stamp, so the period wins.
    assert_eq!(advance_stamp(0, PERIOD, 100), PERIOD);
    assert_eq!(advance_stamp(PERIOD, PERIOD, PERIOD + 10), PERIOD * 2);
  }

  #[test]
  fn stamps_catch_up_to_the_clock_when_the_encoder_falls_behind() {
    // Otherwise N frames written over a longer T get labelled N/fps seconds,
    // and the camera track comes out short and drifting ahead of the picture.
    assert_eq!(advance_stamp(0, PERIOD, 5_000_000), 5_000_000);
  }

  #[test]
  fn stamps_never_go_backwards() {
    let mut stamp = 0;
    for step in 0..100 {
      let elapsed = if step % 7 == 0 { 0 } else { step * 100_000 };
      let next = advance_stamp(stamp, PERIOD, elapsed);
      assert!(next > stamp, "step {step}");
      stamp = next;
    }
  }

  #[test]
  fn a_clock_behind_the_stamp_does_not_pull_it_back() {
    // Stamps advance even when a frame fails, so the two tracks end the same
    // length -- an elapsed reading behind the last stamp must not undo that.
    assert_eq!(advance_stamp(10_000_000, PERIOD, 0), 10_000_000 + PERIOD);
  }

  #[test]
  fn the_stamp_moves_by_at_least_a_period_every_time() {
    for elapsed in [0i64, 1, 100_000, 166_667, 5_000_000] {
      let next = advance_stamp(1_000_000, PERIOD, elapsed);
      assert!(next >= 1_000_000 + PERIOD || next == elapsed, "{elapsed}");
      assert!(next > 1_000_000, "{elapsed}");
    }
  }

  #[test]
  fn a_steady_loop_produces_evenly_spaced_stamps() {
    let mut stamp = 0;
    let mut stamps = Vec::new();
    for frame in 0..60 {
      // The clock keeps pace exactly, so the period is always the floor.
      stamp = advance_stamp(stamp, PERIOD, frame * PERIOD);
      stamps.push(stamp);
    }
    for pair in stamps.windows(2) {
      assert_eq!(pair[1] - pair[0], PERIOD);
    }
  }

  #[test]
  fn a_stalled_loop_still_ends_where_the_clock_did() {
    // Sixty frames' worth of wall time but only ten writes: the last stamp has
    // to reflect the wall clock, not ten periods.
    let mut stamp = 0;
    for frame in 1..=10i64 {
      stamp = advance_stamp(stamp, PERIOD, frame * PERIOD * 6);
    }
    assert_eq!(stamp, PERIOD * 60);
  }

  #[test]
  fn a_stamp_near_the_top_of_the_range_saturates_rather_than_wrapping() {
    assert_eq!(advance_stamp(i64::MAX, PERIOD, 0), i64::MAX);
  }

  #[test]
  fn a_zero_period_still_moves_when_the_clock_does() {
    assert_eq!(advance_stamp(0, 0, 5_000), 5_000);
  }
}
