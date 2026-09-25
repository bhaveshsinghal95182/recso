use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use image::{DynamicImage, ImageFormat, RgbaImage};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{io::Cursor, mem::size_of, ptr};

use napi_derive::napi;
use serde_json::{json, Value};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Gdi::{
  BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
  DIB_RGB_COLORS, DeleteDC, DeleteObject, GetObjectW, HBITMAP, HGDIOBJ, SelectObject,
};
use windows::Win32::UI::WindowsAndMessaging::{
  CURSORINFO, CURSOR_SHOWING, CURSOR_SUPPRESSED, GetClassNameW, GetCursorInfo, GetCursorPos,
  GetIconInfo, GetWindowTextW, GetWindowThreadProcessId, HCURSOR, HICON, ICONINFO,
  IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_NO, IDC_SIZEALL,
  IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_UPARROW, IDC_WAIT, LoadCursorW,
  WindowFromPoint, DI_NORMAL, DrawIconEx,
};
use windows_capture::graphics_capture_api::GraphicsCaptureApi;

#[napi]
pub fn is_cursor_settings_supported() -> napi::Result<bool> {
  Ok(GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false))
}

fn now_epoch_ms() -> u64 {
  match SystemTime::now().duration_since(UNIX_EPOCH) {
    Ok(duration) => duration.as_millis().try_into().unwrap_or(u64::MAX),
    Err(_) => 0,
  }
}

fn wide_buf_to_string(buffer: &[u16]) -> String {
  let len = buffer.iter().position(|&value| value == 0).unwrap_or(buffer.len());
  String::from_utf16_lossy(&buffer[..len])
}

fn hwnd_to_u64(hwnd: HWND) -> u64 {
  hwnd.0 as usize as u64
}

fn hcursor_to_u64(cursor: HCURSOR) -> u64 {
  cursor.0 as usize as u64
}

fn classify_system_cursor(cursor: HCURSOR) -> Option<&'static str> {
  let candidates: [(&str, _); 13] = [
    ("arrow", IDC_ARROW),
    ("ibeam", IDC_IBEAM),
    ("wait", IDC_WAIT),
    ("cross", IDC_CROSS),
    ("uparrow", IDC_UPARROW),
    ("size_nwse", IDC_SIZENWSE),
    ("size_nesw", IDC_SIZENESW),
    ("size_we", IDC_SIZEWE),
    ("size_ns", IDC_SIZENS),
    ("size_all", IDC_SIZEALL),
    ("no", IDC_NO),
    ("hand", IDC_HAND),
    ("app_starting", IDC_APPSTARTING),
  ];

  for (name, id) in candidates {
    if let Ok(system_cursor) = unsafe { LoadCursorW(None, id) } {
      if system_cursor == cursor {
        return Some(name);
      }
    }
  }

  if let Ok(help_cursor) = unsafe { LoadCursorW(None, IDC_HELP) } {
    if help_cursor == cursor {
      return Some("help");
    }
  }

  None
}

fn delete_gdi_bitmap(bitmap: HBITMAP) {
  if !bitmap.0.is_null() {
    unsafe {
      let _ = DeleteObject(HGDIOBJ(bitmap.0));
    }
  }
}

fn resolve_cursor_dimensions(icon_info: &ICONINFO) -> (i32, i32) {
  let mut bitmap = BITMAP::default();

  if !icon_info.hbmColor.0.is_null() {
    let read = unsafe {
      GetObjectW(
        HGDIOBJ(icon_info.hbmColor.0),
        size_of::<BITMAP>() as i32,
        Some((&mut bitmap as *mut BITMAP).cast()),
      )
    };
    if read > 0 {
      return (bitmap.bmWidth.max(1), bitmap.bmHeight.abs().max(1));
    }
  }

  if !icon_info.hbmMask.0.is_null() {
    let read = unsafe {
      GetObjectW(
        HGDIOBJ(icon_info.hbmMask.0),
        size_of::<BITMAP>() as i32,
        Some((&mut bitmap as *mut BITMAP).cast()),
      )
    };
    if read > 0 {
      let width = bitmap.bmWidth.max(1);
      let mut height = bitmap.bmHeight.abs().max(1);
      if icon_info.hbmColor.0.is_null() {
        height = (height / 2).max(1);
      }
      return (width, height);
    }
  }

  (32, 32)
}

fn capture_cursor_image_json(cursor: HCURSOR) -> Value {
  let mut icon_info = ICONINFO::default();
  let icon_handle = HICON(cursor.0);

  if let Err(err) = unsafe { GetIconInfo(icon_handle, &mut icon_info as *mut ICONINFO) } {
    return json!({
      "ok": false,
      "error": format!("{err:?}"),
      "dataUrl": null,
      "hotspotX": null,
      "hotspotY": null,
      "width": null,
      "height": null,
    });
  }

  let (icon_width, icon_height) = resolve_cursor_dimensions(&icon_info);
  let hotspot_x = icon_info.xHotspot;
  let hotspot_y = icon_info.yHotspot;

  let image_result: Result<String, String> = (|| {
    let hdc = unsafe { CreateCompatibleDC(None) };
    if hdc.0.is_null() {
      return Err("CreateCompatibleDC returned null HDC".to_string());
    }

    let mut bitmap_info = BITMAPINFO::default();
    bitmap_info.bmiHeader = BITMAPINFOHEADER {
      biSize: size_of::<BITMAPINFOHEADER>() as u32,
      biWidth: icon_width,
      // Negative height requests a top-down DIB so rows are already upright.
      biHeight: -icon_height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB.0,
      biSizeImage: (icon_width * icon_height * 4).max(0) as u32,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };

    let mut bits_ptr: *mut core::ffi::c_void = ptr::null_mut();
    let dib = unsafe {
      CreateDIBSection(
        Some(hdc),
        &bitmap_info as *const BITMAPINFO,
        DIB_RGB_COLORS,
        &mut bits_ptr as *mut *mut core::ffi::c_void,
        None,
        0,
      )
    }
    .map_err(|err| format!("CreateDIBSection failed: {err:?}"))?;

    if bits_ptr.is_null() {
      unsafe {
        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(hdc);
      }
      return Err("CreateDIBSection returned null pixel buffer".to_string());
    }

    let previous_object = unsafe { SelectObject(hdc, HGDIOBJ(dib.0)) };
    let draw_result = unsafe {
      DrawIconEx(
        hdc,
        0,
        0,
        icon_handle,
        icon_width,
        icon_height,
        0,
        None,
        DI_NORMAL,
      )
    }
    .map_err(|err| format!("DrawIconEx failed: {err:?}"));

    unsafe {
      if !previous_object.0.is_null() {
        let _ = SelectObject(hdc, previous_object);
      }
    }

    let final_result = if let Err(err) = draw_result {
      Err(err)
    } else {
      let byte_len = (icon_width as usize)
        .saturating_mul(icon_height as usize)
        .saturating_mul(4);
      let bgra = unsafe { std::slice::from_raw_parts(bits_ptr as *const u8, byte_len) };
      let mut rgba_pixels = bgra.to_vec();

      for pixel in rgba_pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
      }

      let image = RgbaImage::from_raw(icon_width as u32, icon_height as u32, rgba_pixels)
        .ok_or_else(|| "Failed to construct RGBA image from cursor bitmap".to_string())?;

      let mut encoded = Vec::new();
      let mut writer = Cursor::new(&mut encoded);
      DynamicImage::ImageRgba8(image)
        .write_to(&mut writer, ImageFormat::Png)
        .map_err(|err| format!("PNG encode failed: {err:?}"))?;

      Ok(format!("data:image/png;base64,{}", BASE64_STANDARD.encode(encoded)))
    };

    unsafe {
      let _ = DeleteObject(HGDIOBJ(dib.0));
      let _ = DeleteDC(hdc);
    }

    final_result
  })();

  delete_gdi_bitmap(icon_info.hbmColor);
  delete_gdi_bitmap(icon_info.hbmMask);

  match image_result {
    Ok(data_url) => json!({
      "ok": true,
      "error": null,
      "dataUrl": data_url,
      "hotspotX": hotspot_x,
      "hotspotY": hotspot_y,
      "width": icon_width,
      "height": icon_height,
    }),
    Err(error) => json!({
      "ok": false,
      "error": error,
      "dataUrl": null,
      "hotspotX": hotspot_x,
      "hotspotY": hotspot_y,
      "width": icon_width,
      "height": icon_height,
    }),
  }
}

fn window_under_point_json(point: POINT) -> Value {
  let hwnd = unsafe { WindowFromPoint(point) };
  if hwnd.0.is_null() {
    return json!({
      "found": false,
      "point": {
        "x": point.x,
        "y": point.y,
      }
    });
  }

  let mut class_name_buf = [0u16; 256];
  let class_name_len = unsafe { GetClassNameW(hwnd, &mut class_name_buf) };
  let class_name = if class_name_len > 0 {
    wide_buf_to_string(&class_name_buf[..class_name_len as usize])
  } else {
    String::new()
  };

  let mut title_buf = [0u16; 1024];
  let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
  let title = if title_len > 0 {
    wide_buf_to_string(&title_buf[..title_len as usize])
  } else {
    String::new()
  };

  let mut process_id = 0u32;
  let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id as *mut u32)) };

  json!({
    "found": true,
    "point": {
      "x": point.x,
      "y": point.y,
    },
    "hwndDec": hwnd_to_u64(hwnd),
    "hwndHex": format!("0x{:X}", hwnd_to_u64(hwnd)),
    "className": class_name,
    "title": title,
    "processId": process_id,
    "threadId": thread_id,
  })
}

fn capture_cursor_snapshot_value() -> Value {
  let captured_at_epoch_ms = now_epoch_ms();

  let mut cursor_info = CURSORINFO::default();
  cursor_info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;

  let get_cursor_info_result = unsafe { GetCursorInfo(&mut cursor_info as *mut CURSORINFO) };

  let mut fallback_point = POINT::default();
  let get_cursor_pos_result = unsafe { GetCursorPos(&mut fallback_point as *mut POINT) };

  let (cursor_point, cursor_info_json) = match get_cursor_info_result {
    Ok(()) => {
      let flags = cursor_info.flags.0;
      let is_showing = (flags & CURSOR_SHOWING.0) != 0;
      let is_suppressed = (flags & CURSOR_SUPPRESSED.0) != 0;
      let cursor_handle_dec = hcursor_to_u64(cursor_info.hCursor);
      let system_cursor_guess = classify_system_cursor(cursor_info.hCursor);
      let cursor_image = capture_cursor_image_json(cursor_info.hCursor);

      (
        cursor_info.ptScreenPos,
        json!({
          "ok": true,
          "error": null,
          "flagsDec": flags,
          "flagsHex": format!("0x{:X}", flags),
          "isShowing": is_showing,
          "isSuppressed": is_suppressed,
          "hCursorDec": cursor_handle_dec,
          "hCursorHex": format!("0x{:X}", cursor_handle_dec),
          "systemCursorGuess": system_cursor_guess,
          "cursorImage": cursor_image,
          "screenPos": {
            "x": cursor_info.ptScreenPos.x,
            "y": cursor_info.ptScreenPos.y,
          }
        }),
      )
    }
    Err(err) => {
      let fallback = match get_cursor_pos_result {
        Ok(()) => fallback_point,
        Err(_) => POINT::default(),
      };

      (
        fallback,
        json!({
          "ok": false,
          "error": format!("{err:?}"),
          "flagsDec": null,
          "flagsHex": null,
          "isShowing": null,
          "isSuppressed": null,
          "hCursorDec": null,
          "hCursorHex": null,
          "systemCursorGuess": null,
          "cursorImage": null,
          "screenPos": {
            "x": fallback.x,
            "y": fallback.y,
          }
        }),
      )
    }
  };

  let cursor_pos_json = match get_cursor_pos_result {
    Ok(()) => json!({
      "ok": true,
      "error": null,
      "screenPos": {
        "x": fallback_point.x,
        "y": fallback_point.y,
      }
    }),
    Err(err) => json!({
      "ok": false,
      "error": format!("{err:?}"),
      "screenPos": null,
    }),
  };

  json!({
    "capturedAtEpochMs": captured_at_epoch_ms,
    "cursorInfo": cursor_info_json,
    "cursorPos": cursor_pos_json,
    "windowUnderCursor": window_under_point_json(cursor_point),
  })
}

#[napi]
pub fn capture_cursor_snapshot_json() -> napi::Result<String> {
  serde_json::to_string_pretty(&capture_cursor_snapshot_value())
    .map_err(|err| napi::Error::from_reason(format!("Failed to serialize cursor snapshot: {err}")))
}

#[napi]
pub fn capture_cursor_samples_json(
  duration_ms: u32,
  interval_ms: Option<u32>,
) -> napi::Result<String> {
  let clamped_duration_ms = duration_ms.clamp(20, 60_000);
  let clamped_interval_ms = interval_ms.unwrap_or(16).clamp(1, 1_000);

  let start = Instant::now();
  let mut samples = Vec::new();

  loop {
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let mut snapshot = capture_cursor_snapshot_value();
    if let Some(map) = snapshot.as_object_mut() {
      map.insert("tMs".to_string(), json!(elapsed_ms));
    }
    samples.push(snapshot);

    if elapsed_ms >= clamped_duration_ms as u64 {
      break;
    }

    thread::sleep(Duration::from_millis(clamped_interval_ms as u64));
  }

  let payload = json!({
    "durationMs": clamped_duration_ms,
    "intervalMs": clamped_interval_ms,
    "sampleCount": samples.len(),
    "samples": samples,
  });

  serde_json::to_string_pretty(&payload)
    .map_err(|err| napi::Error::from_reason(format!("Failed to serialize cursor samples: {err}")))
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
  use super::*;

  #[test]
  fn prints_cursor_snapshot_json() {
    let payload = capture_cursor_snapshot_json().expect("cursor snapshot should serialize");
    println!("{payload}");
    assert!(payload.contains("\"cursorInfo\""));
    assert!(payload.contains("\"windowUnderCursor\""));
  }
}

#[cfg(test)]
mod wide_string_scenarios {
  use super::*;

  fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
  }

  #[test]
  fn a_plain_string_comes_back_as_it_went_in() {
    assert_eq!(wide_buf_to_string(&wide("Notepad")), "Notepad");
  }

  #[test]
  fn an_empty_buffer_is_an_empty_string() {
    assert_eq!(wide_buf_to_string(&[]), "");
  }

  #[test]
  fn the_string_stops_at_the_first_null() {
    // Win32 fills a fixed-size buffer and null-terminates; the rest is
    // whatever was in the stack slot, and it is not part of the title.
    let mut buffer = wide("Notepad");
    buffer.push(0);
    buffer.extend(wide("GARBAGE"));
    assert_eq!(wide_buf_to_string(&buffer), "Notepad");
  }

  #[test]
  fn a_buffer_that_is_all_nulls_is_an_empty_string() {
    assert_eq!(wide_buf_to_string(&[0; 260]), "");
  }

  #[test]
  fn a_buffer_with_no_null_uses_the_whole_thing() {
    // Which is what a title that exactly fills the buffer looks like.
    assert_eq!(wide_buf_to_string(&wide("abc")), "abc");
  }

  #[test]
  fn a_null_at_the_very_start_is_an_empty_string() {
    let mut buffer = vec![0u16];
    buffer.extend(wide("ignored"));
    assert_eq!(wide_buf_to_string(&buffer), "");
  }

  #[test]
  fn a_title_with_spaces_and_punctuation_survives() {
    let title = "recso - main.rs (Working Tree) - Visual Studio Code";
    assert_eq!(wide_buf_to_string(&wide(title)), title);
  }

  #[test]
  fn a_non_ascii_title_survives() {
    // Window titles are UTF-16 and routinely are not ASCII.
    for title in ["\u{7a97}\u{53e3}", "caf\u{e9}", "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}"] {
      assert_eq!(wide_buf_to_string(&wide(title)), title, "{title}");
    }
  }

  #[test]
  fn an_emoji_title_survives_its_surrogate_pair() {
    let title = "build \u{1f680}";
    assert_eq!(wide_buf_to_string(&wide(title)), title);
  }

  #[test]
  fn an_unpaired_surrogate_is_replaced_rather_than_refused() {
    // A truncated buffer can split a pair. Losing the character is fine;
    // failing to list the window is not.
    let broken = [0xD83Du16, 0x0041];
    let out = wide_buf_to_string(&broken);
    assert!(out.ends_with('A'), "{out:?}");
  }

  #[test]
  fn the_result_never_contains_a_null() {
    let mut buffer = wide("Title");
    buffer.push(0);
    buffer.push(0);
    assert!(!wide_buf_to_string(&buffer).contains('\0'));
  }

  #[test]
  fn a_long_title_is_not_truncated() {
    let title = "x".repeat(500);
    assert_eq!(wide_buf_to_string(&wide(&title)).len(), 500);
  }

  #[test]
  fn the_epoch_clock_moves_forward() {
    let first = now_epoch_ms();
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(now_epoch_ms() >= first);
  }

  #[test]
  fn the_epoch_clock_is_a_plausible_wall_clock_time() {
    // Milliseconds since 1970. Anything before 2020 means the conversion lost
    // a factor somewhere.
    assert!(now_epoch_ms() > 1_577_836_800_000, "{}", now_epoch_ms());
  }
}

#[cfg(test)]
mod wide_string_matrix {
  use super::*;

  /// Titles a real desktop produces, including the awkward ones.
  const TITLES: [&str; 12] = [
    "",
    "a",
    "Notepad",
    "recso - main.rs - Visual Studio Code",
    "Untitled - Paint",
    "100% - Zoom",
    "a b  c   d",
    "\u{7a97}\u{53e3}",
    "caf\u{e9}",
    "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}",
    "build \u{1f680} ready",
    "tab\tseparated",
  ];

  fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
  }

  #[test]
  fn every_title_survives_a_round_trip() {
    for title in TITLES {
      assert_eq!(wide_buf_to_string(&wide(title)), title, "{title:?}");
    }
  }

  #[test]
  fn every_title_stops_at_its_terminator() {
    // Win32 fills a fixed-size buffer and null-terminates; the rest is
    // whatever was in the stack slot.
    for title in TITLES {
      let mut buffer = wide(title);
      buffer.push(0);
      buffer.extend(wide("GARBAGE\u{7a97}"));
      assert_eq!(wide_buf_to_string(&buffer), title, "{title:?}");
    }
  }

  #[test]
  fn every_title_survives_a_buffer_padded_with_nulls() {
    for title in TITLES {
      let mut buffer = wide(title);
      buffer.resize(260, 0);
      assert_eq!(wide_buf_to_string(&buffer), title, "{title:?}");
    }
  }

  #[test]
  fn no_result_ever_contains_a_null() {
    for title in TITLES {
      let mut buffer = wide(title);
      buffer.extend([0u16, 0, 0]);
      assert!(!wide_buf_to_string(&buffer).contains('\0'), "{title:?}");
    }
  }

  #[test]
  fn a_null_at_the_start_always_gives_an_empty_string() {
    for title in TITLES {
      let mut buffer = vec![0u16];
      buffer.extend(wide(title));
      assert_eq!(wide_buf_to_string(&buffer), "", "{title:?}");
    }
  }

  #[test]
  fn an_all_null_buffer_is_empty_at_every_length() {
    for len in [0usize, 1, 2, 64, 260, 1_024] {
      assert_eq!(wide_buf_to_string(&vec![0u16; len]), "", "len {len}");
    }
  }

  #[test]
  fn a_buffer_with_no_terminator_uses_all_of_it() {
    // Which is what a title that exactly fills the buffer looks like.
    for title in TITLES {
      assert_eq!(wide_buf_to_string(&wide(title)), title, "{title:?}");
    }
  }

  #[test]
  fn a_truncated_surrogate_pair_is_replaced_rather_than_refused() {
    // A fixed buffer can split a pair. Losing the character is fine; failing
    // to list the window is not.
    let broken = [0xD83Du16, 0x0041];
    let out = wide_buf_to_string(&broken);
    assert!(out.ends_with('A'), "{out:?}");
    assert!(!out.is_empty());
  }

  #[test]
  fn a_long_title_is_never_truncated() {
    for len in [100usize, 500, 2_000] {
      let title = "x".repeat(len);
      assert_eq!(wide_buf_to_string(&wide(&title)).len(), len, "len {len}");
    }
  }

  #[test]
  fn conversion_is_deterministic_for_every_title() {
    for title in TITLES {
      let buffer = wide(title);
      assert_eq!(
        wide_buf_to_string(&buffer),
        wide_buf_to_string(&buffer),
        "{title:?}"
      );
    }
  }

  #[test]
  fn the_epoch_clock_is_monotonic_and_plausible() {
    let first = now_epoch_ms();
    // Milliseconds since 1970; anything before 2020 means a lost factor.
    assert!(first > 1_577_836_800_000, "{first}");
    for _ in 0..50 {
      assert!(now_epoch_ms() >= first);
    }
  }
}
