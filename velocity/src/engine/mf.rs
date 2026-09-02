//! Shared Media Foundation setup.
//!
//! Both the decoder and the encoder need MF started and the same D3D11 device
//! manager. Creating a second manager for the same device works but makes it
//! easy to end up with textures on mismatched devices, so there is exactly one.

use std::sync::{Once, OnceLock};

use windows::core::Result;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

static MF_INIT: Once = Once::new();

pub fn ensure_mf() {
  MF_INIT.call_once(|| unsafe {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
  });
}

/// Wrapper so the manager can live in a `OnceLock`.
///
/// `IMFDXGIDeviceManager` is a COM object with no Rust-visible thread affinity;
/// the device behind it has multithread protection enabled, which is what makes
/// this safe.
struct ManagerCell(IMFDXGIDeviceManager, u32);
unsafe impl Send for ManagerCell {}
unsafe impl Sync for ManagerCell {}

static MANAGER: OnceLock<ManagerCell> = OnceLock::new();

/// The device manager Media Foundation uses to reach our D3D11 device, plus its
/// reset token.
pub fn device_manager() -> Result<(&'static IMFDXGIDeviceManager, u32)> {
  ensure_mf();

  if let Some(cell) = MANAGER.get() {
    return Ok((&cell.0, cell.1));
  }

  let gpu = crate::engine::d3d::gpu()?;
  let mut token = 0u32;
  let mut manager: Option<IMFDXGIDeviceManager> = None;
  unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager)? };
  let manager = manager.expect("device manager");
  unsafe { manager.ResetDevice(&gpu.device, token)? };

  let cell = MANAGER.get_or_init(|| ManagerCell(manager, token));
  Ok((&cell.0, cell.1))
}

pub fn wide(s: &str) -> Vec<u16> {
  s.encode_utf16().chain(std::iter::once(0)).collect()
}
