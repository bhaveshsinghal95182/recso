#![deny(clippy::all)]

use napi_derive::napi;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};
use windows_capture::graphics_capture_api::GraphicsCaptureApi;
use windows_capture::window::Window;

#[napi]
pub fn is_cursor_settings_supported() -> napi::Result<bool> {
    Ok(GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false))
}

#[napi(object)]
pub struct WindowInfo {
    pub title: String,
    pub class_name: String,
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
                let mut rect = windows::Win32::Foundation::RECT::default();
                let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect) };
                if rect.right == 0 || rect.bottom == 0 { continue; }

                let mut cloaked_val: u32 = 0;
                let hr = unsafe {
                    DwmGetWindowAttribute(
                        hwnd,
                        DWMWA_CLOAKED,
                        &mut cloaked_val as *mut _ as *mut _,
                        std::mem::size_of::<u32>() as u32,
                    )
                };

                // Only ignore DWM_CLOAKED_APP (1), allow DWM_CLOAKED_SHELL (2) for virtual desktops
                if hr.is_ok() && cloaked_val == 1 {
                    continue;
                }

                let mut class_name_buf = [0u16; 256];
                let len = unsafe { windows::Win32::UI::WindowsAndMessaging::GetClassNameW(hwnd, &mut class_name_buf) };
                let class_name = String::from_utf16_lossy(&class_name_buf[..len as usize]);

                // 5. Filter out specific system classes that act as background helpers
                let class_str = class_name.as_str();
                if class_str == "Windows.UI.Core.CoreWindow" 
                    || class_str == "WorkerW" 
                    || class_str == "Progman" {
                    continue;
                }

                result.push(WindowInfo { title, class_name });
            }
        }
    }
    Ok(result)
}
