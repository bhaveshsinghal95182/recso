use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, RgbaImage};
use napi_derive::napi;
use std::io::Cursor;
use std::sync::mpsc::{channel, Sender};
use std::time::Duration;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetClientRect, GetWindowLongW, GetWindowRect, IsWindowVisible,
    GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

const THUMBNAIL_MAX_WIDTH: u32 = 320;
const THUMBNAIL_MAX_HEIGHT: u32 = 180;
const THUMBNAIL_CAPTURE_TIMEOUT_MS: u64 = 180;

struct SnapshotFrame {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
    color_format: ColorFormat,
}

struct SnapshotCapture {
    tx: Option<Sender<Result<SnapshotFrame, String>>>,
}

impl GraphicsCaptureApiHandler for SnapshotCapture {
    type Flags = Sender<Result<SnapshotFrame, String>>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: Some(ctx.flags),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = self.tx.take() {
            let snapshot: Result<SnapshotFrame, String> = (|| {
                let color_format = frame.color_format();
                let buffer = frame
                    .buffer()
                    .map_err(|err| format!("Failed to read frame buffer: {:?}", err))?;
                let width = buffer.width();
                let height = buffer.height();
                // windows-capture 2.x unpads into a caller-supplied scratch buffer and
                // borrows from it, so `scratch` must outlive `raw_pixels`.
                let mut scratch = Vec::new();
                let raw_pixels = buffer.as_nopadding_buffer(&mut scratch);

                Ok(SnapshotFrame {
                    pixels: raw_pixels.to_vec(),
                    width,
                    height,
                    color_format,
                })
            })();

            let _ = tx.send(snapshot);
        }

        capture_control.stop();
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Err("Capture source closed before first frame arrived".to_string()));
        }
        Ok(())
    }
}

fn fit_thumbnail_dimensions(
    src_width: u32,
    src_height: u32,
    max_width: u32,
    max_height: u32,
) -> (u32, u32) {
    if src_width == 0 || src_height == 0 {
        return (1, 1);
    }

    if src_width <= max_width && src_height <= max_height {
        return (src_width, src_height);
    }

    let width_limited_height = ((src_height as u64 * max_width as u64) / src_width as u64) as u32;
    if width_limited_height <= max_height {
        return (max_width.max(1), width_limited_height.max(1));
    }

    let height_limited_width = ((src_width as u64 * max_height as u64) / src_height as u64) as u32;
    (height_limited_width.max(1), max_height.max(1))
}

fn convert_to_rgba(mut pixels: Vec<u8>, color_format: ColorFormat) -> Option<Vec<u8>> {
    match color_format {
        ColorFormat::Rgba8 => Some(pixels),
        ColorFormat::Bgra8 => {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel.swap(0, 2);
            }
            Some(pixels)
        }
        _ => None,
    }
}

fn encode_snapshot_as_data_url(snapshot: SnapshotFrame) -> Result<String, String> {
    let rgba_pixels = convert_to_rgba(snapshot.pixels, snapshot.color_format)
        .ok_or_else(|| format!("Unsupported color format: {:?}", snapshot.color_format))?;

    let image = RgbaImage::from_raw(snapshot.width, snapshot.height, rgba_pixels)
        .ok_or_else(|| "Invalid frame dimensions for RGBA thumbnail".to_string())?;

    let (target_width, target_height) = fit_thumbnail_dimensions(
        snapshot.width,
        snapshot.height,
        THUMBNAIL_MAX_WIDTH,
        THUMBNAIL_MAX_HEIGHT,
    );

    let resized = if target_width != snapshot.width || target_height != snapshot.height {
        DynamicImage::ImageRgba8(image)
            .resize(target_width, target_height, FilterType::Triangle)
            .to_rgba8()
    } else {
        image
    };

    let mut encoded = Vec::new();
    let mut cursor = Cursor::new(&mut encoded);
    DynamicImage::ImageRgba8(resized)
        .write_to(&mut cursor, ImageFormat::Jpeg)
        .map_err(|err| format!("Failed to encode JPEG thumbnail: {:?}", err))?;

    Ok(format!(
        "data:image/jpeg;base64,{}",
        BASE64_STANDARD.encode(encoded)
    ))
}

fn capture_window_thumbnail_data_url(window: Window) -> Option<String> {
    let (tx, rx) = channel::<Result<SnapshotFrame, String>>();

    let settings = Settings::new(
        window,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        tx,
    );

    let capture_control = SnapshotCapture::start_free_threaded(settings).ok()?;
    let received = rx.recv_timeout(Duration::from_millis(THUMBNAIL_CAPTURE_TIMEOUT_MS));
    let _ = capture_control.stop();

    let snapshot = match received {
        Ok(Ok(snapshot)) => snapshot,
        _ => return None,
    };

    encode_snapshot_as_data_url(snapshot).ok()
}

#[napi(object)]
pub struct WindowInfo {
    pub title: String,
    pub class_name: String,
    pub thumbnail_data_url: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[napi]
pub fn list_available_windows() -> napi::Result<Vec<WindowInfo>> {
    let windows = Window::enumerate()
        .map_err(|e| napi::Error::from_reason(format!("Failed to enumerate windows: {:?}", e)))?;

    let mut result = Vec::new();
    for window in windows {
        if let Ok(title) = window.title() {
            if !title.is_empty() {
                let hwnd = HWND(window.as_raw_hwnd() as *mut _);

                let is_visible = unsafe { IsWindowVisible(hwnd).as_bool() };
                if !is_visible { continue; }

                let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 };
                if (ex_style & WS_EX_TOOLWINDOW.0) != 0 { continue; }

                // 4. Filter empty/purely transparent overlay rectangles
                let mut client_rect = RECT::default();
                let has_client_rect = unsafe { GetClientRect(hwnd, &mut client_rect).is_ok() };
                if !has_client_rect { continue; }

                if client_rect.right <= client_rect.left || client_rect.bottom <= client_rect.top {
                    continue;
                }

                let mut window_rect = RECT::default();
                let has_window_rect = unsafe { GetWindowRect(hwnd, &mut window_rect).is_ok() };
                if !has_window_rect {
                    continue;
                }

                let window_width = (window_rect.right - window_rect.left).max(1) as u32;
                let window_height = (window_rect.bottom - window_rect.top).max(1) as u32;

                let mut cloaked_val: u32 = 0;
                let hr = unsafe {
                    DwmGetWindowAttribute(
                        hwnd,
                        DWMWA_CLOAKED,
                        &mut cloaked_val as *mut _ as *mut _,
                        std::mem::size_of::<u32>() as u32,
                    )
                };

                // Block ALL cloaked windows, because if it's on another virtual desktop (Shell cloaked),
                // Windows suspends its rendering and we will receive 0 frames during capture.
                if hr.is_ok() && cloaked_val != 0 {
                    continue;
                }

                let mut class_name_buf = [0u16; 256];
                let len = unsafe { GetClassNameW(hwnd, &mut class_name_buf) };
                let class_name = String::from_utf16_lossy(&class_name_buf[..len as usize]);

                // 5. Filter out specific system classes that act as background helpers
                let class_str = class_name.as_str();
                if class_str == "Windows.UI.Core.CoreWindow" 
                    || class_str == "WorkerW" 
                    || class_str == "Progman" {
                    continue;
                }

                let thumbnail_data_url = capture_window_thumbnail_data_url(window);

                result.push(WindowInfo {
                    title,
                    class_name,
                    thumbnail_data_url,
                    x: window_rect.left,
                    y: window_rect.top,
                    width: window_width,
                    height: window_height,
                });
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod thumbnail_scenarios {
    use super::*;

    #[test]
    fn a_window_already_small_enough_is_not_touched() {
        assert_eq!(fit_thumbnail_dimensions(200, 100, 320, 240), (200, 100));
    }

    #[test]
    fn a_window_exactly_at_the_limit_is_not_touched() {
        assert_eq!(fit_thumbnail_dimensions(320, 240, 320, 240), (320, 240));
    }

    #[test]
    fn a_wide_window_is_limited_by_its_width() {
        assert_eq!(fit_thumbnail_dimensions(1920, 1080, 320, 320), (320, 180));
    }

    #[test]
    fn a_tall_window_is_limited_by_its_height() {
        assert_eq!(fit_thumbnail_dimensions(1080, 1920, 320, 320), (180, 320));
    }

    #[test]
    fn the_aspect_ratio_survives_the_shrink() {
        for (w, h) in [(1920u32, 1080u32), (1080, 1920), (800, 600), (1000, 137)] {
            let (tw, th) = fit_thumbnail_dimensions(w, h, 320, 240);
            let before = w as f64 / h as f64;
            let after = tw as f64 / th as f64;
            // Integer rounding, so this is close rather than exact.
            assert!(
                (before - after).abs() / before < 0.05,
                "{w}x{h} -> {tw}x{th}"
            );
        }
    }

    #[test]
    fn the_result_always_fits_inside_the_box() {
        for (w, h) in [
            (1920u32, 1080u32),
            (1080, 1920),
            (4000, 10),
            (10, 4000),
            (321, 241),
        ] {
            let (tw, th) = fit_thumbnail_dimensions(w, h, 320, 240);
            assert!(tw <= 320, "{w}x{h} -> {tw}x{th}");
            assert!(th <= 240, "{w}x{h} -> {tw}x{th}");
        }
    }

    #[test]
    fn the_result_never_has_a_zero_side() {
        // A zero-sided thumbnail cannot be encoded, so an extreme aspect ratio
        // has to round up to one pixel rather than down to none.
        for (w, h) in [(4000u32, 1u32), (1, 4000), (10_000, 3), (3, 10_000)] {
            let (tw, th) = fit_thumbnail_dimensions(w, h, 320, 240);
            assert!(tw >= 1 && th >= 1, "{w}x{h} -> {tw}x{th}");
        }
    }

    #[test]
    fn a_window_with_no_pixels_gives_a_single_pixel() {
        assert_eq!(fit_thumbnail_dimensions(0, 0, 320, 240), (1, 1));
        assert_eq!(fit_thumbnail_dimensions(0, 1080, 320, 240), (1, 1));
        assert_eq!(fit_thumbnail_dimensions(1920, 0, 320, 240), (1, 1));
    }

    #[test]
    fn a_box_with_no_room_still_yields_something_drawable() {
        let (tw, th) = fit_thumbnail_dimensions(1920, 1080, 0, 0);
        assert!(tw >= 1 && th >= 1, "{tw}x{th}");
    }

    #[test]
    fn shrinking_never_grows_a_window() {
        for (w, h) in [(1920u32, 1080u32), (100, 100), (400, 50)] {
            let (tw, th) = fit_thumbnail_dimensions(w, h, 320, 240);
            assert!(tw <= w.max(1), "{w}x{h}");
            assert!(th <= h.max(1), "{w}x{h}");
        }
    }

    #[test]
    fn a_square_window_stays_square() {
        assert_eq!(fit_thumbnail_dimensions(1000, 1000, 320, 240), (240, 240));
    }

    #[test]
    fn a_huge_window_does_not_overflow_the_intermediate_multiply() {
        // The scale is worked out in u64 for exactly this reason.
        let (tw, th) = fit_thumbnail_dimensions(u32::MAX, u32::MAX, 320, 240);
        assert!(tw <= 320 && th <= 240);
        assert!(tw >= 1 && th >= 1);
    }

    #[test]
    fn a_bigger_box_gives_a_bigger_thumbnail() {
        let small = fit_thumbnail_dimensions(1920, 1080, 160, 160);
        let large = fit_thumbnail_dimensions(1920, 1080, 640, 640);
        assert!(large.0 > small.0);
        assert!(large.1 > small.1);
    }

    #[test]
    fn fitting_twice_changes_nothing_the_second_time() {
        let once = fit_thumbnail_dimensions(1920, 1080, 320, 240);
        assert_eq!(fit_thumbnail_dimensions(once.0, once.1, 320, 240), once);
    }
}

#[cfg(test)]
mod colour_format_scenarios {
    use super::*;

    #[test]
    fn rgba_is_passed_straight_through() {
        let pixels = vec![1, 2, 3, 4, 5, 6, 7, 8];
        assert_eq!(
            convert_to_rgba(pixels.clone(), ColorFormat::Rgba8),
            Some(pixels)
        );
    }

    #[test]
    fn bgra_has_its_red_and_blue_swapped() {
        let out = convert_to_rgba(vec![10, 20, 30, 40], ColorFormat::Bgra8).unwrap();
        assert_eq!(out, vec![30, 20, 10, 40]);
    }

    #[test]
    fn swapping_leaves_green_and_alpha_where_they_were() {
        let out = convert_to_rgba(vec![1, 99, 2, 77], ColorFormat::Bgra8).unwrap();
        assert_eq!(out[1], 99);
        assert_eq!(out[3], 77);
    }

    #[test]
    fn every_pixel_in_a_run_is_swapped() {
        let pixels: Vec<u8> = (0..16).collect();
        let out = convert_to_rgba(pixels, ColorFormat::Bgra8).unwrap();
        for i in (0..16).step_by(4) {
            assert_eq!(out[i], (i + 2) as u8, "pixel at {i}");
            assert_eq!(out[i + 2], i as u8, "pixel at {i}");
        }
    }

    #[test]
    fn swapping_twice_returns_the_original() {
        let pixels: Vec<u8> = (0..32).collect();
        let once = convert_to_rgba(pixels.clone(), ColorFormat::Bgra8).unwrap();
        let twice = convert_to_rgba(once, ColorFormat::Bgra8).unwrap();
        assert_eq!(twice, pixels);
    }

    #[test]
    fn a_trailing_partial_pixel_is_left_alone_rather_than_read_past() {
        // `chunks_exact_mut` stops at the last whole pixel.
        let out = convert_to_rgba(vec![1, 2, 3, 4, 9, 9], ColorFormat::Bgra8).unwrap();
        assert_eq!(out, vec![3, 2, 1, 4, 9, 9]);
    }

    #[test]
    fn an_empty_buffer_converts_to_an_empty_buffer() {
        assert_eq!(convert_to_rgba(Vec::new(), ColorFormat::Bgra8), Some(vec![]));
        assert_eq!(convert_to_rgba(Vec::new(), ColorFormat::Rgba8), Some(vec![]));
    }

    #[test]
    fn a_format_the_encoder_cannot_take_is_refused_rather_than_guessed() {
        // Half-float RGBA would need a tone map, not a channel swap.
        assert_eq!(convert_to_rgba(vec![0; 8], ColorFormat::Rgba16F), None);
    }

    #[test]
    fn conversion_never_changes_the_buffer_length() {
        for format in [ColorFormat::Rgba8, ColorFormat::Bgra8] {
            let out = convert_to_rgba(vec![0; 64], format).unwrap();
            assert_eq!(out.len(), 64, "{format:?}");
        }
    }

    #[test]
    fn a_full_frame_converts_without_losing_a_pixel() {
        let pixels = vec![0u8; 320 * 240 * 4];
        let out = convert_to_rgba(pixels, ColorFormat::Bgra8).unwrap();
        assert_eq!(out.len(), 320 * 240 * 4);
    }
}

#[cfg(test)]
mod thumbnail_matrix {
    use super::*;

    /// Window sizes a desktop actually reports, plus the degenerate ones.
    const WINDOWS: [(u32, u32); 14] = [
        (1920, 1080),
        (1280, 720),
        (3840, 2160),
        (1080, 1920),
        (800, 600),
        (640, 480),
        (320, 240),
        (200, 100),
        (100, 200),
        (1, 1),
        (4000, 3),
        (3, 4000),
        (0, 0),
        (u32::MAX, u32::MAX),
    ];

    const BOXES: [(u32, u32); 6] = [
        (320, 240),
        (160, 160),
        (640, 640),
        (1, 1),
        (0, 0),
        (1920, 1080),
    ];

    #[test]
    fn the_result_always_fits_inside_the_box() {
        for (w, h) in WINDOWS {
            for (bw, bh) in BOXES {
                let (tw, th) = fit_thumbnail_dimensions(w, h, bw, bh);
                let label = format!("{w}x{h} into {bw}x{bh}");
                // A one-pixel floor can exceed a zero-sized box; that is the
                // documented behaviour and the only exception.
                assert!(tw <= bw.max(1), "{label}: {tw}x{th}");
                assert!(th <= bh.max(1), "{label}: {tw}x{th}");
            }
        }
    }

    #[test]
    fn the_result_never_has_a_zero_side() {
        // A zero-sided thumbnail cannot be encoded at all.
        for (w, h) in WINDOWS {
            for (bw, bh) in BOXES {
                let (tw, th) = fit_thumbnail_dimensions(w, h, bw, bh);
                assert!(tw >= 1, "{w}x{h} into {bw}x{bh}: {tw}x{th}");
                assert!(th >= 1, "{w}x{h} into {bw}x{bh}: {tw}x{th}");
            }
        }
    }

    #[test]
    fn shrinking_never_grows_a_window() {
        for (w, h) in WINDOWS {
            for (bw, bh) in BOXES {
                let (tw, th) = fit_thumbnail_dimensions(w, h, bw, bh);
                assert!(tw <= w.max(1), "{w}x{h} into {bw}x{bh}");
                assert!(th <= h.max(1), "{w}x{h} into {bw}x{bh}");
            }
        }
    }

    #[test]
    fn a_window_already_small_enough_is_never_touched() {
        for (bw, bh) in BOXES {
            for (w, h) in WINDOWS {
                if w == 0 || h == 0 || w > bw || h > bh {
                    continue;
                }
                assert_eq!(
                    fit_thumbnail_dimensions(w, h, bw, bh),
                    (w, h),
                    "{w}x{h} into {bw}x{bh}"
                );
            }
        }
    }

    #[test]
    fn the_aspect_ratio_survives_for_every_window_that_has_one() {
        for (w, h) in WINDOWS {
            if w == 0 || h == 0 {
                continue;
            }
            for (bw, bh) in [(320u32, 240u32), (640, 640), (1920, 1080)] {
                let (tw, th) = fit_thumbnail_dimensions(w, h, bw, bh);
                if tw < 4 || th < 4 {
                    // Integer rounding dominates below a few pixels.
                    continue;
                }
                let before = w as f64 / h as f64;
                let after = tw as f64 / th as f64;
                assert!(
                    (before / after - 1.0).abs() < 0.05,
                    "{w}x{h} into {bw}x{bh}: {before} vs {after}"
                );
            }
        }
    }

    #[test]
    fn a_window_with_no_pixels_always_gives_a_single_pixel() {
        for (bw, bh) in BOXES {
            for (w, h) in [(0u32, 0u32), (0, 1080), (1920, 0)] {
                assert_eq!(
                    fit_thumbnail_dimensions(w, h, bw, bh),
                    (1, 1),
                    "{w}x{h} into {bw}x{bh}"
                );
            }
        }
    }

    #[test]
    fn a_huge_window_never_overflows_the_intermediate_multiply() {
        // The scale is worked out in u64 for exactly this reason.
        for (bw, bh) in BOXES {
            for (w, h) in [(u32::MAX, u32::MAX), (u32::MAX, 1), (1, u32::MAX)] {
                let (tw, th) = fit_thumbnail_dimensions(w, h, bw, bh);
                assert!(tw >= 1 && th >= 1, "{w}x{h} into {bw}x{bh}");
                assert!(tw <= bw.max(1) && th <= bh.max(1), "{w}x{h} into {bw}x{bh}");
            }
        }
    }

    #[test]
    fn fitting_is_idempotent_for_every_window_and_box() {
        for (w, h) in WINDOWS {
            for (bw, bh) in BOXES {
                let once = fit_thumbnail_dimensions(w, h, bw, bh);
                let twice = fit_thumbnail_dimensions(once.0, once.1, bw, bh);
                assert_eq!(once, twice, "{w}x{h} into {bw}x{bh}");
            }
        }
    }

    #[test]
    fn a_bigger_box_never_gives_a_smaller_thumbnail() {
        for (w, h) in WINDOWS {
            if w == 0 || h == 0 {
                continue;
            }
            let mut last = (0u32, 0u32);
            for size in [1u32, 80, 160, 320, 640, 1_280] {
                let (tw, th) = fit_thumbnail_dimensions(w, h, size, size);
                assert!(tw >= last.0, "{w}x{h} at {size}");
                assert!(th >= last.1, "{w}x{h} at {size}");
                last = (tw, th);
            }
        }
    }

    #[test]
    fn a_square_window_always_stays_square() {
        for size in [1u32, 100, 1_000, 4_000] {
            for (bw, bh) in [(320u32, 240u32), (240, 320), (640, 640)] {
                let (tw, th) = fit_thumbnail_dimensions(size, size, bw, bh);
                assert_eq!(tw, th, "{size} into {bw}x{bh}");
            }
        }
    }

    #[test]
    fn the_limiting_axis_is_always_the_one_that_had_the_least_room() {
        for (w, h) in [(1920u32, 1080u32), (1080, 1920), (4000, 3), (3, 4000)] {
            let (tw, th) = fit_thumbnail_dimensions(w, h, 320, 320);
            // Whichever side was longer in the source is the one that hits the
            // box first.
            if w > h {
                assert_eq!(tw, 320, "{w}x{h}");
            } else if h > w {
                assert_eq!(th, 320, "{w}x{h}");
            }
        }
    }
}

#[cfg(test)]
mod colour_format_matrix {
    use super::*;

    const SIZES: [usize; 8] = [0, 1, 2, 3, 4, 8, 64, 320 * 240 * 4];

    fn ramp(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn rgba_is_passed_through_untouched_at_every_length() {
        for len in SIZES {
            let pixels = ramp(len);
            assert_eq!(
                convert_to_rgba(pixels.clone(), ColorFormat::Rgba8),
                Some(pixels),
                "len {len}"
            );
        }
    }

    #[test]
    fn bgra_swaps_red_and_blue_at_every_length() {
        for len in SIZES {
            let pixels = ramp(len);
            let out = convert_to_rgba(pixels.clone(), ColorFormat::Bgra8).unwrap();
            assert_eq!(out.len(), len, "len {len}");
            for i in (0..len.saturating_sub(3)).step_by(4) {
                assert_eq!(out[i], pixels[i + 2], "len {len} at {i}");
                assert_eq!(out[i + 1], pixels[i + 1], "len {len} at {i}");
                assert_eq!(out[i + 2], pixels[i], "len {len} at {i}");
                assert_eq!(out[i + 3], pixels[i + 3], "len {len} at {i}");
            }
        }
    }

    #[test]
    fn swapping_twice_returns_the_original_at_every_length() {
        for len in SIZES {
            let pixels = ramp(len);
            let once = convert_to_rgba(pixels.clone(), ColorFormat::Bgra8).unwrap();
            let twice = convert_to_rgba(once, ColorFormat::Bgra8).unwrap();
            assert_eq!(twice, pixels, "len {len}");
        }
    }

    #[test]
    fn conversion_never_changes_the_length_for_any_supported_format() {
        for len in SIZES {
            for format in [ColorFormat::Rgba8, ColorFormat::Bgra8] {
                let out = convert_to_rgba(ramp(len), format).unwrap();
                assert_eq!(out.len(), len, "len {len} {format:?}");
            }
        }
    }

    #[test]
    fn a_trailing_partial_pixel_is_left_alone_at_every_length() {
        // `chunks_exact_mut` stops at the last whole pixel rather than reading
        // past the end.
        for whole in [0usize, 1, 2, 16] {
            for extra in [1usize, 2, 3] {
                let len = whole * 4 + extra;
                let pixels = ramp(len);
                let out = convert_to_rgba(pixels.clone(), ColorFormat::Bgra8).unwrap();
                assert_eq!(&out[whole * 4..], &pixels[whole * 4..], "{whole}+{extra}");
            }
        }
    }

    #[test]
    fn an_unsupported_format_is_always_refused_rather_than_guessed() {
        // Half-float RGBA needs a tone map, not a channel swap.
        for len in SIZES {
            assert_eq!(convert_to_rgba(ramp(len), ColorFormat::Rgba16F), None, "len {len}");
        }
    }

    #[test]
    fn conversion_is_deterministic_for_every_format_and_length() {
        for len in SIZES {
            for format in [ColorFormat::Rgba8, ColorFormat::Bgra8] {
                assert_eq!(
                    convert_to_rgba(ramp(len), format),
                    convert_to_rgba(ramp(len), format),
                    "len {len} {format:?}"
                );
            }
        }
    }

    #[test]
    fn the_alpha_channel_is_never_disturbed_by_a_swap() {
        for alpha in [0u8, 1, 127, 255] {
            let pixels = vec![10, 20, 30, alpha, 40, 50, 60, alpha];
            let out = convert_to_rgba(pixels, ColorFormat::Bgra8).unwrap();
            assert_eq!(out[3], alpha, "{alpha}");
            assert_eq!(out[7], alpha, "{alpha}");
        }
    }
}
