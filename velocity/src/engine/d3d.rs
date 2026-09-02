//! D3D11 device + shared-texture plumbing.
//!
//! Everything here exists to get an `ID3D11Texture2D` out of this process and
//! into Chromium's GPU process as a shared NT handle.

use std::sync::{Mutex, OnceLock};

use windows::core::{Interface, Result};
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{
  D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{
  CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory6, IDXGIKeyedMutex, IDXGIResource1,
  DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, DXGI_SHARED_RESOURCE_READ,
  DXGI_SHARED_RESOURCE_WRITE,
};

/// A D3D11 device with multithread protection turned on.
///
/// Media Foundation *requires* the protection flag when it shares a device, and
/// Chromium's GPU process touches our textures on its own threads, so we always
/// set it rather than tracking which paths need it.
pub struct Gpu {
  pub device: ID3D11Device,
  pub context: ID3D11DeviceContext,
}

// The underlying D3D11 objects are free-threaded once multithread protection is
// on, which is exactly what we set up in `new`.
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

static GPU: OnceLock<Gpu> = OnceLock::new();

static RENDER_LOCK: Mutex<()> = Mutex::new(());

/// Serialises a *sequence* of immediate-context calls.
///
/// Multithread protection makes individual D3D11 calls safe, but not a run of
/// them. The immediate context has one set of state, so a player decode thread
/// and an export thread issuing passes at the same time would overwrite each
/// other's viewport, shaders and render targets mid-frame.
///
/// Poisoning is ignored on purpose: the guard protects GPU state, not an
/// invariant that a panicking thread could have half-updated.
pub fn render_lock() -> std::sync::MutexGuard<'static, ()> {
  RENDER_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// One device for the whole process.
///
/// Decode, encode and preview all have to touch the same textures, and a texture
/// cannot be shared between D3D11 devices without going through another shared
/// handle. One device keeps that whole class of problem out of the prototype.
pub fn gpu() -> Result<&'static Gpu> {
  if let Some(g) = GPU.get() {
    return Ok(g);
  }
  let g = Gpu::new()?;
  Ok(GPU.get_or_init(|| g))
}

/// Which GPU to build the device on.
///
/// This matters more than it looks. Shared textures cannot cross adapters, so
/// the engine has to land on the *same* GPU as Chromium's GPU process or every
/// `importSharedTexture` breaks. Changing this without also telling Chromium is
/// not a tuning knob, it is a bug.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GpuPreference {
  /// Whatever DXGI enumerates first -- the integrated GPU on most laptops.
  Default,
  /// Ask DXGI for its high-performance adapter.
  ///
  /// This follows the machine's power policy, which is usually what you want:
  /// on battery Windows reports the *integrated* GPU as high-performance, and
  /// Chromium's GPU process makes the same choice, so the two stay on the same
  /// adapter and shared textures keep working.
  HighPerformance,
  /// Take the discrete GPU regardless of power policy.
  ///
  /// Ignores what DXGI would prefer, so on battery this can land the engine on
  /// a different adapter than Chromium -- which breaks every shared texture.
  /// `checkGpuMatch` in the main process warns when that happens.
  ForceDiscrete,
}

fn preference() -> GpuPreference {
  match std::env::var("RECSO_ENGINE_GPU").as_deref() {
    Ok("integrated") | Ok("default") => GpuPreference::Default,
    Ok("force-discrete") | Ok("nvidia") => GpuPreference::ForceDiscrete,
    _ => GpuPreference::HighPerformance,
  }
}

/// Pick an adapter explicitly rather than letting `D3D11CreateDevice` choose.
///
/// Returns `None` for the default, which makes the create call behave exactly
/// as it did before.
fn choose_adapter(pref: GpuPreference) -> Option<IDXGIAdapter> {
  match select_high_performance(pref) {
    Ok(adapter) => adapter,
    Err(reason) => {
      // Falling back silently is how this ends up on the integrated GPU without
      // anyone noticing, so say why.
      eprintln!("[gpu] falling back to the default adapter: {reason}");
      None
    }
  }
}

/// Ask DXGI for the high-performance adapter, explaining any refusal.
fn select_high_performance(pref: GpuPreference) -> std::result::Result<Option<IDXGIAdapter>, String> {
  if pref == GpuPreference::Default {
    return Ok(None);
  }

  if pref == GpuPreference::ForceDiscrete {
    return largest_dedicated().map(Some);
  }

  // IDXGIFactory6 knows the machine's own power/performance ordering, which is
  // more reliable than guessing from vendor IDs or memory sizes.
  let factory: IDXGIFactory6 =
    unsafe { CreateDXGIFactory1() }.map_err(|e| format!("no IDXGIFactory6: {e}"))?;

  let adapter: IDXGIAdapter1 = unsafe {
    factory.EnumAdapterByGpuPreference(0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
  }
  .map_err(|e| format!("EnumAdapterByGpuPreference failed: {e}"))?;

  let desc = unsafe { adapter.GetDesc1() }.map_err(|e| format!("GetDesc1 failed: {e}"))?;

  // Never end up on the software renderer just because it sorted first.
  if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
    return Err(format!("high-performance pick is software: {}", describe(&desc)));
  }

  adapter
    .cast()
    .map(Some)
    .map_err(|e| format!("adapter cast failed: {e}"))
}

/// The non-software adapter with the most dedicated video memory.
///
/// Used only when the caller has asked to override the power policy. Dedicated
/// memory is a crude proxy for "the discrete one", but on a hybrid laptop the
/// gap is enormous (128 MB against several GB), so it is not a close call.
fn largest_dedicated() -> std::result::Result<IDXGIAdapter, String> {
  use windows::Win32::Graphics::Dxgi::IDXGIFactory1;

  let factory: IDXGIFactory1 =
    unsafe { CreateDXGIFactory1() }.map_err(|e| format!("no IDXGIFactory1: {e}"))?;

  let mut best: Option<(usize, IDXGIAdapter1)> = None;
  for index in 0.. {
    let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(index) } {
      Ok(a) => a,
      Err(_) => break,
    };
    let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
      continue;
    };
    if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
      continue;
    }
    let memory = desc.DedicatedVideoMemory;
    if best.as_ref().is_none_or(|(m, _)| memory > *m) {
      best = Some((memory, adapter));
    }
  }

  let (_, adapter) = best.ok_or_else(|| "no hardware adapters".to_string())?;
  adapter.cast().map_err(|e| format!("adapter cast failed: {e}"))
}

/// What DXGI would hand back for each preference, without creating a device.
pub fn gpu_preference_report() -> Vec<String> {
  use windows::Win32::Graphics::Dxgi::{DXGI_GPU_PREFERENCE_MINIMUM_POWER, DXGI_GPU_PREFERENCE_UNSPECIFIED};

  let mut out = Vec::new();
  let factory: IDXGIFactory6 = match unsafe { CreateDXGIFactory1() } {
    Ok(f) => f,
    Err(e) => {
      out.push(format!("IDXGIFactory6 unavailable: {e}"));
      return out;
    }
  };

  for (name, pref) in [
    ("unspecified", DXGI_GPU_PREFERENCE_UNSPECIFIED),
    ("minimum power", DXGI_GPU_PREFERENCE_MINIMUM_POWER),
    ("high performance", DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE),
  ] {
    match unsafe { factory.EnumAdapterByGpuPreference::<IDXGIAdapter1>(0, pref) } {
      Ok(a) => match unsafe { a.GetDesc1() } {
        Ok(desc) => out.push(format!("{name}: {}", describe(&desc))),
        Err(e) => out.push(format!("{name}: GetDesc1 failed: {e}")),
      },
      Err(e) => out.push(format!("{name}: {e}")),
    }
  }
  out
}

impl Gpu {
  pub fn new() -> Result<Self> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;

    let adapter = choose_adapter(preference());
    // An explicit adapter requires D3D_DRIVER_TYPE_UNKNOWN; passing HARDWARE
    // alongside one is an invalid-argument error, not a hint.
    let driver_type = if adapter.is_some() {
      D3D_DRIVER_TYPE_UNKNOWN
    } else {
      D3D_DRIVER_TYPE_HARDWARE
    };

    unsafe {
      D3D11CreateDevice(
        adapter.as_ref(),
        driver_type,
        HMODULE::default(),
        // BGRA_SUPPORT is what lets the video/D2D interop paths use this device.
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        Some(&[D3D_FEATURE_LEVEL_11_0]),
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        Some(&mut context),
      )?;
    }

    let device = device.expect("D3D11CreateDevice returned success with no device");
    let context = context.expect("D3D11CreateDevice returned success with no context");

    let mt: ID3D11Multithread = device.cast()?;
    // Returns the previous setting, which we do not care about.
    unsafe { let _ = mt.SetMultithreadProtected(true); };

    Ok(Self { device, context })
  }
}

/// Which sharing mode a texture was created with.
///
/// This is not a style choice. Electron's `importSharedTexture` documents that
/// `bgra`/`rgba`/`rgbaf16` handles must NOT carry a keyed mutex, while `nv12`
/// handles MUST. Get it backwards and the import fails or deadlocks.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Sharing {
  /// `D3D11_RESOURCE_MISC_SHARED` -- no mutex. For BGRA.
  Plain,
  /// `D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX` -- for NV12.
  KeyedMutex,
}

impl Sharing {
  fn misc_flags(self) -> i32 {
    let base = D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0;
    match self {
      Sharing::Plain => base | D3D11_RESOURCE_MISC_SHARED.0,
      Sharing::KeyedMutex => base | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0,
    }
  }
}

/// A texture we own, plus the NT handle Electron will import.
pub struct SharedTexture {
  pub texture: ID3D11Texture2D,
  pub handle: HANDLE,
  pub width: u32,
  pub height: u32,
  pub format: DXGI_FORMAT,
  pub sharing: Sharing,
}

unsafe impl Send for SharedTexture {}

impl SharedTexture {
  /// Allocate a shareable texture and immediately export its NT handle.
  ///
  /// Shared textures are picky: DEFAULT usage, one mip, one array slice. Break
  /// any of those and `CreateSharedHandle` fails rather than the create call,
  /// which makes it look like a sharing problem when it's an allocation problem.
  pub fn new(
    gpu: &Gpu,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    sharing: Sharing,
    initial: Option<&[u8]>,
  ) -> Result<Self> {
    let bind = if format == DXGI_FORMAT_NV12 {
      // NV12 render targets aren't universally supported; SRV alone is enough
      // because we only ever copy into these.
      D3D11_BIND_SHADER_RESOURCE.0
    } else {
      D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0
    };

    let desc = D3D11_TEXTURE2D_DESC {
      Width: width,
      Height: height,
      MipLevels: 1,
      ArraySize: 1,
      Format: format,
      SampleDesc: DXGI_SAMPLE_DESC {
        Count: 1,
        Quality: 0,
      },
      Usage: D3D11_USAGE_DEFAULT,
      BindFlags: bind as u32,
      CPUAccessFlags: 0,
      MiscFlags: sharing.misc_flags() as u32,
    };

    let mut texture: Option<ID3D11Texture2D> = None;

    unsafe {
      match initial {
        Some(bytes) => {
          let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: bytes.as_ptr() as *const _,
            SysMemPitch: width * bytes_per_pixel(format),
            SysMemSlicePitch: 0,
          };
          gpu
            .device
            .CreateTexture2D(&desc, Some(&data), Some(&mut texture))?;
        }
        None => {
          gpu.device.CreateTexture2D(&desc, None, Some(&mut texture))?;
        }
      }
    }

    let texture = texture.expect("CreateTexture2D succeeded with no texture");

    // NT handles come from IDXGIResource1, not the older IDXGIResource::GetSharedHandle.
    let resource: IDXGIResource1 = texture.cast()?;
    let handle = unsafe {
      resource.CreateSharedHandle(
        None,
        (DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE).0,
        None,
      )?
    };

    Ok(Self {
      texture,
      handle,
      width,
      height,
      format,
      sharing,
    })
  }

  /// The string Electron expects in `textureInfo.pixelFormat`.
  pub fn pixel_format_name(&self) -> &'static str {
    match self.format {
      DXGI_FORMAT_B8G8R8A8_UNORM => "bgra",
      DXGI_FORMAT_R8G8B8A8_UNORM => "rgba",
      DXGI_FORMAT_NV12 => "nv12",
      _ => "bgra",
    }
  }

  /// The raw HANDLE as a u64, ready to be written into the Buffer Electron reads.
  pub fn handle_bits(&self) -> u64 {
    self.handle.0 as u64
  }

  /// Keyed-mutex guard. NV12 shared textures carry a mutex and Chromium
  /// acquires/releases on key 0, so we use the same key on our side.
  pub fn lock(&self) -> Result<Option<MutexGuard<'_>>> {
    if self.sharing != Sharing::KeyedMutex {
      return Ok(None);
    }
    let mutex: IDXGIKeyedMutex = self.texture.cast()?;
    unsafe { mutex.AcquireSync(0, u32::MAX)? };
    Ok(Some(MutexGuard {
      mutex,
      _marker: std::marker::PhantomData,
    }))
  }
}

/// Releases the keyed mutex on drop so an early return cannot strand it.
pub struct MutexGuard<'a> {
  mutex: IDXGIKeyedMutex,
  _marker: std::marker::PhantomData<&'a ()>,
}

impl Drop for MutexGuard<'_> {
  fn drop(&mut self) {
    unsafe {
      let _ = self.mutex.ReleaseSync(0);
    }
  }
}

impl Drop for SharedTexture {
  fn drop(&mut self) {
    if !self.handle.is_invalid() {
      // Electron's GPU process duplicates the handle on import, so closing ours
      // does not yank the texture out from under a live VideoFrame.
      unsafe {
        let _ = windows::Win32::Foundation::CloseHandle(self.handle);
      }
    }
  }
}

fn bytes_per_pixel(format: DXGI_FORMAT) -> u32 {
  match format {
    DXGI_FORMAT_B8G8R8A8_UNORM | DXGI_FORMAT_R8G8B8A8_UNORM => 4,
    _ => 1,
  }
}

/// A plain device-local texture. No sharing, no mutex -- for staging that never
/// leaves this process.
pub fn create_texture(
  gpu: &Gpu,
  width: u32,
  height: u32,
  format: DXGI_FORMAT,
) -> Result<ID3D11Texture2D> {
  let desc = D3D11_TEXTURE2D_DESC {
    Width: width,
    Height: height,
    MipLevels: 1,
    ArraySize: 1,
    Format: format,
    SampleDesc: DXGI_SAMPLE_DESC {
      Count: 1,
      Quality: 0,
    },
    Usage: D3D11_USAGE_DEFAULT,
    BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
    CPUAccessFlags: 0,
    MiscFlags: 0,
  };
  let mut tex: Option<ID3D11Texture2D> = None;
  unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut tex))? };
  Ok(tex.expect("texture"))
}


fn describe(desc: &windows::Win32::Graphics::Dxgi::DXGI_ADAPTER_DESC1) -> String {
  let end = desc
    .Description
    .iter()
    .position(|&c| c == 0)
    .unwrap_or(desc.Description.len());
  let name = String::from_utf16_lossy(&desc.Description[..end]);
  format!(
    "{} [vendor 0x{:04X}, {} MB dedicated]",
    name.trim(),
    desc.VendorId,
    desc.DedicatedVideoMemory / 1048576
  )
}

/// Every adapter DXGI knows about, in its own enumeration order.
///
/// Order matters: passing `None` to `D3D11CreateDevice` takes the first one,
/// which on a laptop is usually the integrated GPU.
pub fn list_adapters() -> Result<Vec<String>> {
  use windows::Win32::Graphics::Dxgi::IDXGIFactory1;

  let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
  let mut out = Vec::new();

  for index in 0.. {
    let adapter: IDXGIAdapter1 = match unsafe { factory.EnumAdapters1(index) } {
      Ok(a) => a,
      Err(_) => break,
    };
    let desc = unsafe { adapter.GetDesc1()? };
    out.push(format!("{index}: {}", describe(&desc)));
  }

  Ok(out)
}

/// Which adapter the process-wide device actually ended up on.
pub fn active_adapter() -> Result<String> {
  use windows::Win32::Graphics::Dxgi::IDXGIDevice;

  let gpu = gpu()?;
  let dxgi: IDXGIDevice = gpu.device.cast()?;
  let adapter: IDXGIAdapter1 = unsafe { dxgi.GetAdapter()?.cast()? };
  let desc = unsafe { adapter.GetDesc1()? };
  Ok(describe(&desc))
}

/// Local (on-GPU) video memory usage for this process, in bytes.
///
/// The interesting number for a video pipeline: if this climbs while scrubbing,
/// textures are leaking somewhere between here and the GPU process.
pub fn video_memory() -> Result<(u64, u64)> {
  use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter3, IDXGIDevice, DXGI_MEMORY_SEGMENT_GROUP_LOCAL,
  };

  let gpu = gpu()?;
  let dxgi: IDXGIDevice = gpu.device.cast()?;
  let adapter: IDXGIAdapter3 = unsafe { dxgi.GetAdapter()?.cast()? };

  let mut info = Default::default();
  unsafe { adapter.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)? };
  Ok((info.CurrentUsage, info.Budget))
}

/// Copy a BGRA texture back to system memory.
///
/// Only for verification and stills -- it stalls the GPU by design, so it has
/// no place on the per-frame path. Rows are unpacked from the staging pitch,
/// which is almost never `width * 4`.
pub fn read_bgra(texture: &ID3D11Texture2D, width: u32, height: u32) -> Result<Vec<u8>> {
  let gpu = gpu()?;
  let _guard = render_lock();

  let desc = D3D11_TEXTURE2D_DESC {
    Width: width,
    Height: height,
    MipLevels: 1,
    ArraySize: 1,
    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
    SampleDesc: DXGI_SAMPLE_DESC {
      Count: 1,
      Quality: 0,
    },
    Usage: D3D11_USAGE_STAGING,
    BindFlags: 0,
    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
    MiscFlags: 0,
  };

  let mut staging = None;
  unsafe { gpu.device.CreateTexture2D(&desc, None, Some(&mut staging))? };
  let staging = staging.expect("staging texture");

  let mut out = vec![0u8; (width as usize) * (height as usize) * 4];

  unsafe {
    gpu.context.CopyResource(&staging, texture);

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    gpu
      .context
      .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;

    let row_bytes = (width as usize) * 4;
    for row in 0..height as usize {
      let src = (mapped.pData as *const u8).add(row * mapped.RowPitch as usize);
      std::ptr::copy_nonoverlapping(src, out.as_mut_ptr().add(row * row_bytes), row_bytes);
    }

    gpu.context.Unmap(&staging, 0);
  }

  Ok(out)
}
