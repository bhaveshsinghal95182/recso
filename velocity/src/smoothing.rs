//! # Mouse Smoothing Algorithms
//!
//! This module provides algorithms for processing raw mouse input into smooth,
//! interpolated paths suitable for video rendering.
//!
//! ## Features
//!
//! - **Catmull-Rom Spline Interpolation**: Uses the `splines` crate for high-quality curves
//! - **Jitter Removal**: Filters out small, unintentional movements
//! - **Frame Upsampling**: Interpolates positions to match target FPS
//!
//! ## Example
//!
//! ```javascript
//! import { processMousePath } from 'velocity';
//!
//! const smoothed = processMousePath(rawEvents, {
//!   targetFps: 60,
//!   tension: 0.5,
//!   jitterThreshold: 2.0,
//!   removeJitter: true,
//! });
//! ```

use crate::types::{RawMouseEvent, SmoothedPoint, SmoothingEventType, SmoothingOptions};
use napi_derive::napi;
use splines::{Interpolation, Key, Spline};

/// Remove jitter (small unintentional movements) from a list of events.
///
/// This filters out mouse movements smaller than the threshold distance,
/// which helps create cleaner cursor paths for video export.
///
/// Non-move events (clicks, scrolls) are always preserved.
fn remove_jitter_internal(events: Vec<RawMouseEvent>, threshold: f64) -> Vec<RawMouseEvent> {
    if events.len() < 2 {
        return events;
    }

    let mut filtered: Vec<RawMouseEvent> = Vec::with_capacity(events.len());
    filtered.push(events[0].clone());
    let mut last_kept = &events[0];

    for event in events.iter().skip(1) {
        // Always keep non-move events (clicks, scrolls)
        if event.event_type != SmoothingEventType::Move && event.event_type != SmoothingEventType::Drag {
            filtered.push(event.clone());
            continue;
        }

        // Calculate distance from last kept position
        let dx = event.x - last_kept.x;
        let dy = event.y - last_kept.y;
        let distance = (dx * dx + dy * dy).sqrt();

        // Only keep if moved more than threshold
        if distance >= threshold {
            filtered.push(event.clone());
            last_kept = event;
        }
    }

    filtered
}

/// Convert raw events to SmoothedPoint without any processing.
fn events_to_smoothed(events: Vec<RawMouseEvent>) -> Vec<SmoothedPoint> {
    events
        .into_iter()
        .map(|e| {
            let event_type_str = match e.event_type {
                SmoothingEventType::Move => "move",
                SmoothingEventType::Drag => "drag",
                SmoothingEventType::Click => "click",
                SmoothingEventType::Scroll => "scroll",
            }
            .to_string();

            SmoothedPoint {
                recording_id: e.recording_id,
                timestamp_ms: e.timestamp_ms,
                x: e.x,
                y: e.y,
                event_type: event_type_str,
                button: e.button,
                is_interpolated: false,
            }
        })
        .collect()
}

/// Process and smooth a mouse path.
///
/// Takes raw mouse events and returns smoothed, upsampled points ready for
/// video rendering. This includes:
///
/// 1. Optional jitter removal
/// 2. Catmull-Rom spline interpolation for smooth curves (using `splines` crate)
/// 3. Frame upsampling to match target FPS
///
/// Click and scroll events are passed through unchanged.
#[napi]
pub fn process_mouse_path(
    events: Vec<RawMouseEvent>,
    options: SmoothingOptions,
) -> Vec<SmoothedPoint> {
    let target_fps = options.target_fps.unwrap_or(60.0);
    let _tension = options.tension.unwrap_or(0.5); // Not used by splines crate standard CatmullRom
    let jitter_threshold = options.jitter_threshold.unwrap_or(2.0);
    let should_remove_jitter = options.remove_jitter.unwrap_or(true);

    // Early return for insufficient data
    if events.len() < 2 {
        return events_to_smoothed(events);
    }

    // Apply jitter removal if enabled
    let events = if should_remove_jitter {
        remove_jitter_internal(events, jitter_threshold)
    } else {
        events
    };

    // Separate move/drag events from click/scroll events
    let move_events: Vec<&RawMouseEvent> = events
        .iter()
        .filter(|e| e.event_type == SmoothingEventType::Move || e.event_type == SmoothingEventType::Drag)
        .collect();

    let other_events: Vec<SmoothedPoint> = events
        .iter()
        .filter(|e| e.event_type != SmoothingEventType::Move && e.event_type != SmoothingEventType::Drag)
        .map(|e| {
            // Convert Enum back to string for output SmoothedPoint
            let event_type_str = match e.event_type {
                SmoothingEventType::Move => "move",
                SmoothingEventType::Drag => "drag",
                SmoothingEventType::Click => "click",
                SmoothingEventType::Scroll => "scroll",
            }
            .to_string();

            SmoothedPoint {
                recording_id: e.recording_id.clone(),
                timestamp_ms: e.timestamp_ms,
                x: e.x,
                y: e.y,
                event_type: event_type_str,
                button: e.button.clone(),
                is_interpolated: false,
            }
        })
        .collect();

    // If not enough move events, return without smoothing
    if move_events.len() < 2 {
        return events_to_smoothed(events);
    }

    // Create keys for splines
    let mut x_keys = Vec::with_capacity(move_events.len() + 2);
    let mut y_keys = Vec::with_capacity(move_events.len() + 2);

    // Padding start key for Catmull-Rom
    // We duplicate the first point slightly before the start time
    let first = move_events[0];
    x_keys.push(Key::new(
        first.timestamp_ms - 1.0,
        first.x,
        Interpolation::CatmullRom,
    ));
    y_keys.push(Key::new(
        first.timestamp_ms - 1.0,
        first.y,
        Interpolation::CatmullRom,
    ));

    for event in &move_events {
        x_keys.push(Key::new(
            event.timestamp_ms,
            event.x,
            Interpolation::CatmullRom,
        ));
        y_keys.push(Key::new(
            event.timestamp_ms,
            event.y,
            Interpolation::CatmullRom,
        ));
    }

    // Padding end key for Catmull-Rom
    // We duplicate the last point slightly after the end time
    let last = move_events[move_events.len() - 1];
    x_keys.push(Key::new(
        last.timestamp_ms + 1.0,
        last.x,
        Interpolation::CatmullRom,
    ));
    y_keys.push(Key::new(
        last.timestamp_ms + 1.0,
        last.y,
        Interpolation::CatmullRom,
    ));

    // Create splines
    let x_spline = Spline::from_vec(x_keys);
    let y_spline = Spline::from_vec(y_keys);

    let start_time = first.timestamp_ms;
    let end_time = last.timestamp_ms;
    let frame_time_ms = 1000.0 / target_fps;
    
    // Calculate number of frames needed
    let duration = end_time - start_time;
    let num_frames = (duration / frame_time_ms).ceil() as usize;

    let mut smoothed_moves = Vec::with_capacity(num_frames + 1);

    // Sample the spline at target FPS intervals
    for i in 0..=num_frames {
        let t = start_time + (i as f64 * frame_time_ms);
        
        // Don't go past the end time
        if t > end_time {
            break;
        }

        let x = x_spline.sample(t).unwrap_or(first.x); // Should stay within bounds due to padding
        let y = y_spline.sample(t).unwrap_or(first.y);

        smoothed_moves.push(SmoothedPoint {
            recording_id: first.recording_id.clone(),
            timestamp_ms: t.round(),
            x: x.round(),
            y: y.round(),
            event_type: "move".to_string(),
            button: None,
            is_interpolated: true,
        });
    }

    // Ensure the exact last point is included for accuracy
    if smoothed_moves.last().map_or(true, |p| p.timestamp_ms < end_time) {
        let event_type_str = match last.event_type {
            SmoothingEventType::Move => "move",
            SmoothingEventType::Drag => "drag",
            SmoothingEventType::Click => "click",
            SmoothingEventType::Scroll => "scroll",
        }
        .to_string();

        smoothed_moves.push(SmoothedPoint {
            recording_id: last.recording_id.clone(),
            timestamp_ms: last.timestamp_ms,
            x: last.x,
            y: last.y,
            event_type: event_type_str,
            button: last.button.clone(),
            is_interpolated: false,
        });
    }

    // Merge smoothed moves with click/scroll events, sorted by timestamp
    let mut all_events: Vec<SmoothedPoint> = smoothed_moves;
    all_events.extend(other_events);

    // Sort by timestamp, handling NaN gracefully by treating them as equal
    all_events.sort_by(|a, b| {
        a.timestamp_ms
            .partial_cmp(&b.timestamp_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    all_events
}

/// Get interpolated mouse position at a specific timestamp.
///
/// This performs linear interpolation between surrounding events to find
/// the cursor position at an arbitrary point in time. Useful for syncing
/// cursor position with video frames.
///
/// Returns `None` if the events list is empty or contains no move events.
#[napi]
pub fn interpolate_position_at(
    events: Vec<RawMouseEvent>,
    timestamp_ms: f64,
) -> Option<SmoothedPoint> {
    if events.is_empty() {
        return None;
    }

    let move_events: Vec<&RawMouseEvent> = events
        .iter()
        .filter(|e| e.event_type == SmoothingEventType::Move || e.event_type == SmoothingEventType::Drag)
        .collect();

    if move_events.is_empty() {
        return None;
    }

    // Before first event - clamp to first position
    if timestamp_ms <= move_events[0].timestamp_ms {
        return Some(SmoothedPoint {
            recording_id: move_events[0].recording_id.clone(),
            timestamp_ms,
            x: move_events[0].x,
            y: move_events[0].y,
            event_type: "move".to_string(),
            button: None,
            is_interpolated: true,
        });
    }

    // Safe: checked move_events.is_empty() above
    let last = move_events.last()?;
    
    // After last event - clamp to last position
    if timestamp_ms >= last.timestamp_ms {
        return Some(SmoothedPoint {
            recording_id: last.recording_id.clone(),
            timestamp_ms,
            x: last.x,
            y: last.y,
            event_type: "move".to_string(),
            button: None,
            is_interpolated: true,
        });
    }

    // Find surrounding events and interpolate
    for i in 0..move_events.len() - 1 {
        let prev = move_events[i];
        let next = move_events[i + 1];

        if prev.timestamp_ms <= timestamp_ms && next.timestamp_ms >= timestamp_ms {
            // Avoid division by zero
            let time_span = next.timestamp_ms - prev.timestamp_ms;
            if time_span == 0.0 {
                return Some(SmoothedPoint {
                    recording_id: prev.recording_id.clone(),
                    timestamp_ms,
                    x: prev.x,
                    y: prev.y,
                    event_type: "move".to_string(),
                    button: None,
                    is_interpolated: true,
                });
            }

            let t = (timestamp_ms - prev.timestamp_ms) / time_span;

            return Some(SmoothedPoint {
                recording_id: prev.recording_id.clone(),
                timestamp_ms,
                x: (prev.x + (next.x - prev.x) * t).round(),
                y: (prev.y + (next.y - prev.y) * t).round(),
                event_type: "move".to_string(),
                button: None,
                is_interpolated: true,
            });
        }
    }

    None
}
