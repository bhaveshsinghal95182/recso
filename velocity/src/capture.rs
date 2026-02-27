use napi_derive::napi;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
  IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
  AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
  ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
  MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

#[napi]
pub struct Stopper {
  tx: Option<Sender<()>>,
}

#[napi]
impl Stopper {
  #[napi]
  pub fn stop(&mut self) {
    if let Some(tx) = self.tx.take() {
      let _ = tx.send(());
    }
  }
}

struct Capture {
  encoder: Option<VideoEncoder>,
  rx: Receiver<()>,
  output_path: String,
  bitrate: u32,
}

impl GraphicsCaptureApiHandler for Capture {
  type Flags = (String, u32, Receiver<()>);
  type Error = Box<dyn std::error::Error + Send + Sync>;

  fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
    let (output_path, bitrate, rx) = ctx.flags;
    Ok(Self {
      encoder: None,
      rx,
      output_path,
      bitrate,
    })
  }

  fn on_frame_arrived(
    &mut self,
    frame: &mut Frame,
    capture_control: InternalCaptureControl,
  ) -> Result<(), Self::Error> {
    // Initialize the VideoEncoder on the very first frame so its width/height exactly matches the dimensions.
    if self.encoder.is_none() {
      let width = frame.width();
      let height = frame.height();
      let encoder = VideoEncoder::new(
        VideoSettingsBuilder::new(width, height).bitrate(self.bitrate),
        AudioSettingsBuilder::default().disabled(true),
        ContainerSettingsBuilder::default(),
        &self.output_path,
      )?;
      self.encoder = Some(encoder);
    }

    let _ = self.encoder.as_mut().unwrap().send_frame(frame);

    // Check if javascript told us to stop
    match self.rx.try_recv() {
      Ok(_) => {
        if let Some(encoder) = self.encoder.take() {
          let _ = encoder.finish();
        }
        capture_control.stop();
      }
      Err(TryRecvError::Empty) => {}
      Err(TryRecvError::Disconnected) => {
        if let Some(encoder) = self.encoder.take() {
          let _ = encoder.finish();
        }
        capture_control.stop();
      }
    }

    Ok(())
  }

  fn on_closed(&mut self) -> Result<(), Self::Error> {
    // If window is closed while recording, finish the encoder to save the video safely
    if let Some(encoder) = self.encoder.take() {
      let _ = encoder.finish();
    }
    Ok(())
  }
}

use windows_capture::monitor::Monitor;
use windows_capture::window::Window;

#[napi]
pub fn start_monitor_recording(output_path: String, bitrate: u32) -> napi::Result<Stopper> {
  let (tx, rx) = channel();

  let primary_monitor = Monitor::primary()
    .map_err(|e| napi::Error::from_reason(format!("Failed to get primary monitor: {:?}", e)))?;

  let settings = Settings::new(
    primary_monitor,
    CursorCaptureSettings::WithoutCursor,
    DrawBorderSettings::WithoutBorder,
    SecondaryWindowSettings::Default,
    MinimumUpdateIntervalSettings::Default,
    DirtyRegionSettings::Default,
    ColorFormat::Bgra8,
    (output_path, bitrate, rx),
  );

  // The windows-capture struct natively blocks the calling thread while it spins up the recording event loop,
  // so we spawn it onto a rust background daemon thread.
  thread::spawn(move || {
    let _ = Capture::start(settings);
  });

  Ok(Stopper { tx: Some(tx) })
}

#[napi]
pub fn start_window_recording(
  window_title: String,
  output_path: String,
  bitrate: u32,
) -> napi::Result<Stopper> {
  let (tx, rx) = channel();

  let window = Window::from_contains_name(&window_title)
    .map_err(|e| napi::Error::from_reason(format!("Failed to find window '{}': {:?}", window_title, e)))?;

  // WGC won't deliver frames for occluded/minimized windows.
  // Bring the target window to the foreground so the compositor renders it.
  // Only SW_RESTORE if truly minimized — otherwise it un-maximizes the window.
  let hwnd = HWND(window.as_raw_hwnd() as *mut _);
  unsafe {
    if IsIconic(hwnd).as_bool() {
      let _ = ShowWindow(hwnd, SW_RESTORE);
    }
    let _ = SetForegroundWindow(hwnd);
  }

  let settings = Settings::new(
    window,
    CursorCaptureSettings::WithoutCursor,
    DrawBorderSettings::WithoutBorder,
    SecondaryWindowSettings::Default,
    MinimumUpdateIntervalSettings::Default,
    DirtyRegionSettings::Default,
    ColorFormat::Bgra8,
    (output_path, bitrate, rx),
  );

  thread::spawn(move || {
    let _ = Capture::start(settings);
  });

  Ok(Stopper { tx: Some(tx) })
}
