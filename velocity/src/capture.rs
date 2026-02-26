use napi_derive::napi;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread;
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
use windows_capture::window::Window;

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
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = (String, Receiver<()>);
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (output_path, rx) = ctx.flags;
        Ok(Self { encoder: None, rx, output_path })
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
                VideoSettingsBuilder::new(width, height),
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

#[napi]
pub fn start_window_recording(
    window_title: String,
    output_path: String,
) -> napi::Result<Stopper> {
    let (tx, rx) = channel();

    // Iterate carefully to find our requested window instance
    let mut target_window = None;
    if let Ok(windows) = Window::enumerate() {
        for window in windows {
            if let Ok(title) = window.title() {
                if title == window_title {
                    target_window = Some(window);
                    break;
                }
            }
        }
    }
    let window = target_window.ok_or_else(|| napi::Error::from_reason("Window not found"))?;

    let settings = Settings::new(
        window,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        (output_path, rx),
    );

    // The windows-capture struct natively blocks the calling thread while it spins up the recording event loop,
    // so we spawn it onto a rust background daemon thread.
    thread::spawn(move || {
        let _ = Capture::start(settings);
    });

    Ok(Stopper { tx: Some(tx) })
}
