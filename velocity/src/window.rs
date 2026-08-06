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
