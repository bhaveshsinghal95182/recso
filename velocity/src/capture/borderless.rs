//! Getting rid of the yellow capture border.
//!
//! `DrawBorderSettings::WithoutBorder` is not enough on its own. windows-capture
//! turns it into `GraphicsCaptureSession::SetIsBorderRequired(false)`, and
//! Windows quietly ignores that call unless the process has been granted
//! borderless capture access first. The call succeeds, the flag reads back as
//! set, and the border is still drawn -- which is why this looks like the
//! setting is broken rather than missing a step.
//!
//! `GraphicsCaptureAccess::RequestAccessAsync(Borderless)` is that step. It is
//! a capability check, not a user prompt, so it does not put anything on
//! screen. Whether it is granted depends on Windows version and how the app is
//! packaged, so the result is logged rather than assumed -- if it comes back
//! denied, the border is expected and the recording is otherwise fine.
//!
//! Asked for once per process. The grant applies to the process, not to a
//! session, and re-requesting per recording just adds latency to every start.

use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::OnceLock;
use std::time::Duration;

use windows::Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind};
use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// Long enough for a capability lookup, short enough that a machine where this
/// misbehaves loses a border rather than the ability to record.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// What Windows said when we asked to capture without a border.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BorderlessAccess {
  Allowed,
  /// Denied, or the API is unavailable. The border will be drawn.
  Denied,
}

static ACCESS: OnceLock<BorderlessAccess> = OnceLock::new();

/// Request borderless capture access, once per process.
///
/// Call before starting a capture session. Never fails the recording: a denial
/// costs a border, not a file.
pub fn ensure_borderless_access() -> BorderlessAccess {
  *ACCESS.get_or_init(request)
}

/// Ask on a thread we own, and never on the caller's.
///
/// `join()` blocks until the WinRT operation completes, and completion depends
/// on the calling thread's COM apartment. Recording start is reached through
/// napi on whatever thread Node is using, and anything that has already run
/// there may have initialised it as STA -- `listWebcamDevices` does, through
/// nokhwa's Media Foundation backend. Blocking on an STA thread with no message
/// pump waits forever, which turned "enumerate cameras, then record" into a
/// deadlock in recording start.
///
/// A dedicated MTA thread has no such dependency, and the timeout means even an
/// unexpected stall costs a border rather than the recording.
fn request() -> BorderlessAccess {
  let (tx, rx) = channel();

  std::thread::Builder::new()
    .name("borderless-access".into())
    .spawn(move || {
      // Explicit MTA: a fresh thread is uninitialised, and the WinRT call needs
      // an apartment to complete against.
      let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
      let _ = tx.send(request_blocking());
      if initialized {
        unsafe { CoUninitialize() };
      }
    })
    .map(|_| ())
    .unwrap_or_else(|error| {
      eprintln!("[VelocityCapture] could not spawn borderless access thread: {error}");
    });

  match rx.recv_timeout(REQUEST_TIMEOUT) {
    Ok(access) => access,
    Err(RecvTimeoutError::Timeout) => {
      eprintln!("[VelocityCapture] borderless access request timed out; the border will be drawn");
      BorderlessAccess::Denied
    }
    Err(RecvTimeoutError::Disconnected) => BorderlessAccess::Denied,
  }
}

fn request_blocking() -> BorderlessAccess {
  let operation = match GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
  {
    Ok(operation) => operation,
    Err(error) => {
      eprintln!("[VelocityCapture] borderless access unavailable: {error}");
      return BorderlessAccess::Denied;
    }
  };

  let status = match operation.join() {
    Ok(status) => status,
    Err(error) => {
      eprintln!("[VelocityCapture] borderless access request failed: {error}");
      return BorderlessAccess::Denied;
    }
  };

  if status == AppCapabilityAccessStatus::Allowed {
    println!("[VelocityCapture] borderless capture allowed; no yellow border");
    BorderlessAccess::Allowed
  } else {
    // UserPromptRequired / DeniedBySystem / DeniedByUser all land here. The
    // distinction does not change what we do, but it is worth printing: it is
    // the difference between "this build cannot do it" and "this machine will
    // not".
    eprintln!(
      "[VelocityCapture] borderless capture denied (status {:?}); the yellow border will be drawn",
      status.0
    );
    BorderlessAccess::Denied
  }
}

/// Diagnostic: did Windows let us capture without the yellow border?
///
/// Requests access if nothing has yet, so this is safe to call before a
/// recording starts and answers the most common "why is there a border?"
/// support question directly.
#[napi_derive::napi]
pub fn borderless_capture_allowed() -> bool {
  ensure_borderless_access() == BorderlessAccess::Allowed
}
