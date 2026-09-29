//! Synchronous H.264 encoding through NVIDIA's runtime-loaded NVENC driver.
//!
//! The driver is loaded only when needed, so machines without it can still use
//! the rest of the Linux capture backend.
use super::nvenc_sys as sys;
use libloading::Library;
use std::ffi::{c_void, CStr};
use std::ptr;

const API: u32 = 13;
const fn ver(n: u32) -> u32 {
  sys::nvencapi_struct_version(n)
}
const H264: sys::GUID = sys::GUID {
  Data1: 0x6bc82762,
  Data2: 0x4e63,
  Data3: 0x4ca4,
  Data4: [0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf],
};
const HIGH: sys::GUID = sys::GUID {
  Data1: 0xe7cbc309,
  Data2: 0x4f7a,
  Data3: 0x4b89,
  Data4: [0xaf, 0x2a, 0xd5, 0x37, 0xc9, 0x2b, 0xe3, 0x10],
};
const P4: sys::GUID = sys::GUID {
  Data1: 0x90a7b826,
  Data2: 0xdf06,
  Data3: 0x4862,
  Data4: [0xb9, 0xd2, 0xcd, 0x6d, 0x73, 0xa0, 0x86, 0x81],
};
const FORMAT: sys::NV_ENC_BUFFER_FORMAT = sys::_NV_ENC_BUFFER_FORMAT_NV_ENC_BUFFER_FORMAT_ABGR;
const CONFIG_VER: u32 = ver(9) | (1 << 31);
const INIT_VER: u32 = ver(7) | (1 << 31);
const PRESET_VER: u32 = ver(5) | (1 << 31);
const LIST_VER: u32 = ver(2);
const SESSION_VER: u32 = ver(1);
const REGISTER_VER: u32 = ver(5);
const MAP_VER: u32 = ver(4);
const BITSTREAM_VER: u32 = ver(1);
const PIC_VER: u32 = ver(7) | (1 << 31);
const LOCK_VER: u32 = ver(2) | (1 << 31);
#[allow(dead_code)]
const CAPS_VER: u32 = ver(1);

type Ctx = *mut c_void;
type DevicePtr = u64;
type CuResult = i32;
type Init = unsafe extern "C" fn(u32) -> CuResult;
type DeviceGet = unsafe extern "C" fn(*mut i32, i32) -> CuResult;
type DeviceName = unsafe extern "C" fn(*mut i8, i32, i32) -> CuResult;
type CtxCreate = unsafe extern "C" fn(*mut Ctx, u32, i32) -> CuResult;
type CtxDestroy = unsafe extern "C" fn(Ctx) -> CuResult;
type CtxPush = unsafe extern "C" fn(Ctx) -> CuResult;
type CtxPop = unsafe extern "C" fn(*mut Ctx) -> CuResult;
type MemAllocPitch =
  unsafe extern "C" fn(*mut DevicePtr, *mut usize, usize, usize, u32) -> CuResult;
type MemFree = unsafe extern "C" fn(DevicePtr) -> CuResult;
type Memcpy2D = unsafe extern "C" fn(*const CudaMemcpy2D) -> CuResult;

/// LP64 layout of CUDA_MEMCPY2D from cuda.h.
#[repr(C)]
#[allow(non_snake_case)]
struct CudaMemcpy2D {
  srcXInBytes: usize,
  srcY: usize,
  srcMemoryType: u32,
  srcHost: *const c_void,
  srcDevice: DevicePtr,
  srcArray: *mut c_void,
  srcPitch: usize,
  dstXInBytes: usize,
  dstY: usize,
  dstMemoryType: u32,
  dstHost: *mut c_void,
  dstDevice: DevicePtr,
  dstArray: *mut c_void,
  dstPitch: usize,
  WidthInBytes: usize,
  Height: usize,
}
struct Cuda {
  _library: Library,
  init: Init,
  device_get: DeviceGet,
  device_name: DeviceName,
  ctx_create: CtxCreate,
  ctx_destroy: CtxDestroy,
  ctx_push: CtxPush,
  ctx_pop: CtxPop,
  mem_alloc_pitch: MemAllocPitch,
  mem_free: MemFree,
  memcpy_2d: Memcpy2D,
}
fn cu_check(name: &str, code: CuResult) -> Result<(), String> {
  if code == 0 {
    Ok(())
  } else {
    Err(format!("{name} failed (CUresult={code})"))
  }
}
fn nv_check(name: &str, code: sys::NVENCSTATUS) -> Result<(), String> {
  if code == 0 {
    return Ok(());
  }
  let status = match code {
    1 => "NV_ENC_ERR_NO_ENCODE_DEVICE",
    2 => "NV_ENC_ERR_UNSUPPORTED_DEVICE",
    3 => "NV_ENC_ERR_INVALID_ENCODERDEVICE",
    4 => "NV_ENC_ERR_INVALID_DEVICE",
    5 => "NV_ENC_ERR_DEVICE_NOT_EXIST",
    6 => "NV_ENC_ERR_INVALID_PTR",
    7 => "NV_ENC_ERR_INVALID_EVENT",
    8 => "NV_ENC_ERR_INVALID_PARAM",
    9 => "NV_ENC_ERR_INVALID_CALL",
    10 => "NV_ENC_ERR_OUT_OF_MEMORY",
    11 => "NV_ENC_ERR_ENCODER_NOT_INITIALIZED",
    12 => "NV_ENC_ERR_UNSUPPORTED_PARAM",
    13 => "NV_ENC_ERR_LOCK_BUSY",
    14 => "NV_ENC_ERR_NOT_ENOUGH_BUFFER",
    15 => "NV_ENC_ERR_INVALID_VERSION",
    16 => "NV_ENC_ERR_MAP_FAILED",
    17 => "NV_ENC_ERR_NEED_MORE_INPUT",
    18 => "NV_ENC_ERR_ENCODER_BUSY",
    19 => "NV_ENC_ERR_EVENT_NOT_REGISTERD",
    20 => "NV_ENC_ERR_GENERIC",
    21 => "NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY",
    22 => "NV_ENC_ERR_UNIMPLEMENTED",
    23 => "NV_ENC_ERR_RESOURCE_REGISTER_FAILED",
    24 => "NV_ENC_ERR_RESOURCE_NOT_REGISTERED",
    25 => "NV_ENC_ERR_RESOURCE_NOT_MAPPED",
    26 => "NV_ENC_ERR_NEED_MORE_OUTPUT",
    _ => "NVENCSTATUS",
  };
  Err(format!("{name} failed ({status}={code})"))
}

unsafe fn symbol<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
  // SAFETY: Callers use the exact C signature from the CUDA or NVENC header.
  unsafe { lib.get::<T>(name) }
    .map(|s| *s)
    .map_err(|e| format!("load {}: {e}", String::from_utf8_lossy(name)))
}
impl Cuda {
  fn load() -> Result<Self, String> {
    // SAFETY: The handle remains live while any copied symbol is called.
    let lib =
      unsafe { Library::new("libcuda.so.1") }.map_err(|e| format!("load libcuda.so.1: {e}"))?;
    // SAFETY: CUDA driver API signatures are declared above.
    unsafe {
      Ok(Self {
        init: symbol(&lib, b"cuInit\0")?,
        device_get: symbol(&lib, b"cuDeviceGet\0")?,
        device_name: symbol(&lib, b"cuDeviceGetName\0")?,
        ctx_create: symbol(&lib, b"cuCtxCreate_v2\0")?,
        ctx_destroy: symbol(&lib, b"cuCtxDestroy_v2\0")?,
        ctx_push: symbol(&lib, b"cuCtxPushCurrent_v2\0")?,
        ctx_pop: symbol(&lib, b"cuCtxPopCurrent_v2\0")?,
        mem_alloc_pitch: symbol(&lib, b"cuMemAllocPitch_v2\0")?,
        mem_free: symbol(&lib, b"cuMemFree_v2\0")?,
        memcpy_2d: symbol(&lib, b"cuMemcpy2D_v2\0")?,
        _library: lib,
      })
    }
  }
  fn push(&self, ctx: Ctx) -> Result<CurrentContext<'_>, String> {
    // SAFETY: ctx was created by this driver and is still live.
    cu_check("cuCtxPushCurrent_v2", unsafe { (self.ctx_push)(ctx) })?;
    Ok(CurrentContext(self))
  }
}
struct CurrentContext<'a>(&'a Cuda);
impl Drop for CurrentContext<'_> {
  fn drop(&mut self) {
    let mut popped = ptr::null_mut();
    // SAFETY: A successful push made one stack entry to pop.
    unsafe { (self.0.ctx_pop)(&mut popped) };
  }
}

/// What the export asks of the encoder.
#[derive(Clone, Copy, Debug)]
pub(crate) struct NvencSettings {
  pub(crate) width: u32,
  pub(crate) height: u32,
  pub(crate) fps: u32,
  pub(crate) bitrate: u32,
}
/// One encoded picture: Annex B, with SPS and PPS before every IDR.
pub(crate) struct NvencFrame {
  pub(crate) annex_b: Vec<u8>,
  pub(crate) keyframe: bool,
}
pub(crate) struct NvencEncoder {
  cuda: Cuda,
  _nvenc_library: Library,
  functions: sys::NV_ENCODE_API_FUNCTION_LIST,
  context: Option<Ctx>,
  encoder: Option<*mut c_void>,
  device_ptr: Option<DevicePtr>,
  pitch: usize,
  registered: Option<*mut c_void>,
  mapped: Option<*mut c_void>,
  bitstream: Option<*mut c_void>,
  settings: NvencSettings,
  name: String,
  frame_index: u64,
}
// Only one thread uses a session at a time; each call pushes and pops its CUDA context.
unsafe impl Send for NvencEncoder {}
macro_rules! nv_call {
  ($this:expr, $field:ident ( $($arg:expr),* ), $name:literal) => {{
    let f = $this.functions.$field.ok_or_else(|| format!("{} unavailable in NVENC function list", $name))?;
    // SAFETY: The library, session and argument storage remain live for this call.
    nv_check($name, unsafe { f($($arg),*) })
  }};
}
impl NvencEncoder {
  fn open() -> Result<Self, String> {
    let cuda = Cuda::load()?;
    let path =
      std::env::var("VELOCITY_NVENC_LIBRARY").unwrap_or_else(|_| "libnvidia-encode.so.1".into());
    // SAFETY: The handle is owned by the session for every function call.
    let lib = unsafe { Library::new(&path) }.map_err(|e| format!("load {path}: {e}"))?;
    // SAFETY: These entry point signatures match nvEncodeAPI.h.
    let (get_version, create): (
      unsafe extern "C" fn(*mut u32) -> u32,
      unsafe extern "C" fn(*mut sys::NV_ENCODE_API_FUNCTION_LIST) -> u32,
    ) = unsafe {
      (
        symbol(&lib, b"NvEncodeAPIGetMaxSupportedVersion\0")?,
        symbol(&lib, b"NvEncodeAPICreateInstance\0")?,
      )
    };
    let mut max = 0;
    // SAFETY: max is a live writable u32.
    let status = unsafe { get_version(&mut max) };
    if status != 0 || max < API {
      return Err(format!(
        "the NVIDIA driver is too old for NVENC API 13.0 (NVENCSTATUS={status}, max={max})"
      ));
    }
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut functions: sys::NV_ENCODE_API_FUNCTION_LIST = unsafe { std::mem::zeroed() };
    functions.version = LIST_VER;
    // SAFETY: functions is writable and initialized with its required version.
    nv_check("NvEncodeAPICreateInstance", unsafe {
      create(&mut functions)
    })?;
    // SAFETY: cuInit has no pointer arguments.
    cu_check("cuInit", unsafe { (cuda.init)(0) })?;
    let mut device = 0;
    // SAFETY: device is writable; ordinal zero selects the first GPU.
    cu_check("cuDeviceGet", unsafe { (cuda.device_get)(&mut device, 0) })?;
    let mut bytes = [0i8; 256];
    // SAFETY: bytes is a writable 256-byte array.
    cu_check("cuDeviceGetName", unsafe {
      (cuda.device_name)(bytes.as_mut_ptr(), 256, device)
    })?;
    // SAFETY: CUDA returns a null-terminated device name on success.
    let name = unsafe { CStr::from_ptr(bytes.as_ptr()) }
      .to_string_lossy()
      .into_owned();
    let mut context = ptr::null_mut();
    // SAFETY: context is writable; cuCtxCreate makes it current.
    cu_check("cuCtxCreate_v2", unsafe {
      (cuda.ctx_create)(&mut context, 0, device)
    })?;
    let mut this = Self {
      cuda,
      _nvenc_library: lib,
      functions,
      context: Some(context),
      encoder: None,
      device_ptr: None,
      pitch: 0,
      registered: None,
      mapped: None,
      bitstream: None,
      settings: NvencSettings {
        width: 0,
        height: 0,
        fps: 0,
        bitrate: 0,
      },
      name,
      frame_index: 0,
    };
    let mut popped = ptr::null_mut();
    // SAFETY: cuCtxCreate implicitly made this context current.
    cu_check("cuCtxPopCurrent_v2", unsafe {
      (this.cuda.ctx_pop)(&mut popped)
    })?;
    let _current = this.cuda.push(context)?;
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut params: sys::NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS = unsafe { std::mem::zeroed() };
    params.version = SESSION_VER;
    params.deviceType = sys::_NV_ENC_DEVICE_TYPE_NV_ENC_DEVICE_TYPE_CUDA;
    params.device = context;
    params.apiVersion = API;
    let mut handle = ptr::null_mut();
    nv_call!(
      this,
      nvEncOpenEncodeSessionEx(&mut params, &mut handle),
      "nvEncOpenEncodeSessionEx"
    )?;
    this.encoder = Some(handle);
    drop(_current);
    Ok(this)
  }
  /// Loads the drivers and opens then destroys a CUDA/NVENC session.
  pub(crate) fn probe() -> Result<String, String> {
    Ok(Self::open()?.name.clone())
  }
  /// Opens one synchronous H.264 session with a reusable pitched RGBA surface.
  pub(crate) fn new(settings: NvencSettings) -> Result<Self, String> {
    if settings.width < 2
      || settings.height < 2
      || settings.width % 2 != 0
      || settings.height % 2 != 0
    {
      return Err("NVENC width and height must be even and at least 2".into());
    }
    if settings.fps == 0
      || settings.bitrate == 0
      || settings.fps.checked_mul(2).is_none()
      || settings.width.checked_mul(4).is_none()
    {
      return Err("NVENC fps, bitrate, or width is invalid".into());
    }
    let mut this = Self::open()?;
    this.settings = settings;
    let _current = this.cuda.push(this.context.unwrap())?;
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut preset: sys::NV_ENC_PRESET_CONFIG = unsafe { std::mem::zeroed() };
    preset.version = PRESET_VER;
    preset.presetCfg.version = CONFIG_VER;
    nv_call!(
      this,
      nvEncGetEncodePresetConfigEx(
        this.encoder.unwrap(),
        H264,
        P4,
        sys::NV_ENC_TUNING_INFO_NV_ENC_TUNING_INFO_HIGH_QUALITY,
        &mut preset
      ),
      "nvEncGetEncodePresetConfigEx"
    )?;
    let config = &mut preset.presetCfg;
    config.version = CONFIG_VER;
    config.profileGUID = HIGH;
    config.gopLength = settings.fps * 2;
    config.frameIntervalP = 1;
    config.rcParams.rateControlMode = sys::_NV_ENC_PARAMS_RC_MODE_NV_ENC_PARAMS_RC_CBR;
    config.rcParams.averageBitRate = settings.bitrate;
    config.rcParams.vbvBufferSize = settings.bitrate;
    // SAFETY: The H.264 codec GUID selects this union member.
    let h264 = unsafe { &mut config.encodeCodecConfig.h264Config };
    h264.idrPeriod = settings.fps * 2;
    h264.set_repeatSPSPPS(1);
    h264.set_outputAUD(0);
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut init: sys::NV_ENC_INITIALIZE_PARAMS = unsafe { std::mem::zeroed() };
    init.version = INIT_VER;
    init.encodeGUID = H264;
    init.presetGUID = P4;
    init.encodeWidth = settings.width;
    init.encodeHeight = settings.height;
    init.darWidth = settings.width;
    init.darHeight = settings.height;
    init.maxEncodeWidth = settings.width;
    init.maxEncodeHeight = settings.height;
    init.frameRateNum = settings.fps;
    init.frameRateDen = 1;
    init.enableEncodeAsync = 0;
    init.enablePTD = 1;
    init.tuningInfo = sys::NV_ENC_TUNING_INFO_NV_ENC_TUNING_INFO_HIGH_QUALITY;
    init.encodeConfig = config;
    nv_call!(
      this,
      nvEncInitializeEncoder(this.encoder.unwrap(), &mut init),
      "nvEncInitializeEncoder"
    )?;
    let mut ptr = 0;
    let mut pitch = 0;
    // SAFETY: CUDA receives writable outputs and valid dimensions.
    cu_check("cuMemAllocPitch_v2", unsafe {
      (this.cuda.mem_alloc_pitch)(
        &mut ptr,
        &mut pitch,
        settings.width as usize * 4,
        settings.height as usize,
        4,
      )
    })?;
    this.device_ptr = Some(ptr);
    this.pitch = pitch;
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut reg: sys::NV_ENC_REGISTER_RESOURCE = unsafe { std::mem::zeroed() };
    reg.version = REGISTER_VER;
    reg.resourceType = sys::_NV_ENC_INPUT_RESOURCE_TYPE_NV_ENC_INPUT_RESOURCE_TYPE_CUDADEVICEPTR;
    reg.width = settings.width;
    reg.height = settings.height;
    reg.pitch = u32::try_from(pitch).map_err(|_| "CUDA pitch exceeds NVENC limit".to_string())?;
    reg.resourceToRegister = ptr as usize as *mut c_void;
    reg.bufferFormat = FORMAT;
    reg.bufferUsage = sys::_NV_ENC_BUFFER_USAGE_NV_ENC_INPUT_IMAGE;
    nv_call!(
      this,
      nvEncRegisterResource(this.encoder.unwrap(), &mut reg),
      "nvEncRegisterResource"
    )?;
    this.registered = Some(reg.registeredResource);
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut bitstream: sys::NV_ENC_CREATE_BITSTREAM_BUFFER = unsafe { std::mem::zeroed() };
    bitstream.version = BITSTREAM_VER;
    nv_call!(
      this,
      nvEncCreateBitstreamBuffer(this.encoder.unwrap(), &mut bitstream),
      "nvEncCreateBitstreamBuffer"
    )?;
    this.bitstream = Some(bitstream.bitstreamBuffer);
    drop(_current);
    Ok(this)
  }
  /// Copies each visible row, then returns exactly one picture in input order.
  pub(crate) fn encode(
    &mut self,
    rgba: &[u8],
    stride: usize,
    force_keyframe: bool,
  ) -> Result<NvencFrame, String> {
    let row = self.settings.width as usize * 4;
    let size = stride
      .checked_mul(self.settings.height as usize)
      .ok_or("frame size overflow")?;
    if stride < row || rgba.len() < size {
      return Err("RGBA buffer is shorter than stride * height".into());
    }
    let _current = self.cuda.push(self.context.unwrap())?;
    let copy = CudaMemcpy2D {
      srcXInBytes: 0,
      srcY: 0,
      srcMemoryType: 1,
      srcHost: rgba.as_ptr().cast(),
      srcDevice: 0,
      srcArray: ptr::null_mut(),
      srcPitch: stride,
      dstXInBytes: 0,
      dstY: 0,
      dstMemoryType: 2,
      dstHost: ptr::null_mut(),
      dstDevice: self.device_ptr.unwrap(),
      dstArray: ptr::null_mut(),
      dstPitch: self.pitch,
      WidthInBytes: row,
      Height: self.settings.height as usize,
    };
    // SAFETY: The source was length-checked and the destination is a live pitched CUDA buffer.
    cu_check("cuMemcpy2D_v2", unsafe { (self.cuda.memcpy_2d)(&copy) })?;
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut map: sys::NV_ENC_MAP_INPUT_RESOURCE = unsafe { std::mem::zeroed() };
    map.version = MAP_VER;
    map.registeredResource = self.registered.unwrap();
    nv_call!(
      self,
      nvEncMapInputResource(self.encoder.unwrap(), &mut map),
      "nvEncMapInputResource"
    )?;
    self.mapped = Some(map.mappedResource);
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut pic: sys::NV_ENC_PIC_PARAMS = unsafe { std::mem::zeroed() };
    pic.version = PIC_VER;
    pic.inputWidth = self.settings.width;
    pic.inputHeight = self.settings.height;
    pic.inputPitch = self.pitch as u32;
    pic.frameIdx = self.frame_index as u32;
    pic.inputTimeStamp = self.frame_index;
    pic.inputBuffer = map.mappedResource;
    pic.outputBitstream = self.bitstream.unwrap();
    pic.bufferFmt = FORMAT;
    pic.pictureStruct = sys::_NV_ENC_PIC_STRUCT_NV_ENC_PIC_STRUCT_FRAME;
    if force_keyframe || self.frame_index == 0 {
      pic.encodePicFlags = sys::_NV_ENC_PIC_FLAGS_NV_ENC_PIC_FLAG_FORCEIDR
        | sys::_NV_ENC_PIC_FLAGS_NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    }
    let f = self
      .functions
      .nvEncEncodePicture
      .ok_or("nvEncEncodePicture unavailable")?;
    // SAFETY: pic contains live input and output resources owned by the session.
    let status = unsafe { f(self.encoder.unwrap(), &mut pic) };
    if status == sys::_NVENCSTATUS_NV_ENC_ERR_NEED_MORE_INPUT {
      return Err("NVENC requested more input, which means B-frames are misconfigured (frameIntervalP must stay 1)".into());
    }
    nv_check("nvEncEncodePicture", status)?;
    // SAFETY: NVENC structs require zeroed reserved fields.
    let mut lock: sys::NV_ENC_LOCK_BITSTREAM = unsafe { std::mem::zeroed() };
    lock.version = LOCK_VER;
    lock.outputBitstream = self.bitstream.unwrap();
    nv_call!(
      self,
      nvEncLockBitstream(self.encoder.unwrap(), &mut lock),
      "nvEncLockBitstream"
    )?;
    // SAFETY: NVENC keeps the locked pointer valid for bitstreamSizeInBytes until unlock.
    let annex_b = unsafe {
      std::slice::from_raw_parts(
        lock.bitstreamBufferPtr.cast::<u8>(),
        lock.bitstreamSizeInBytes as usize,
      )
    }
    .to_vec();
    let keyframe = lock.pictureType == sys::_NV_ENC_PIC_TYPE_NV_ENC_PIC_TYPE_IDR;
    nv_call!(
      self,
      nvEncUnlockBitstream(self.encoder.unwrap(), self.bitstream.unwrap()),
      "nvEncUnlockBitstream"
    )?;
    nv_call!(
      self,
      nvEncUnmapInputResource(self.encoder.unwrap(), map.mappedResource),
      "nvEncUnmapInputResource"
    )?;
    self.mapped = None;
    self.frame_index += 1;
    Ok(NvencFrame { annex_b, keyframe })
  }
  /// The GPU selected for this session.
  pub(crate) fn device_name(&self) -> &str {
    &self.name
  }
}
impl Drop for NvencEncoder {
  fn drop(&mut self) {
    let Some(ctx) = self.context.take() else {
      return;
    };
    if let Ok(current) = self.cuda.push(ctx) {
      if let Some(enc) = self.encoder.take() {
        if let Some(mapped) = self.mapped.take() {
          if let Some(f) = self.functions.nvEncUnmapInputResource {
            // SAFETY: mapped belongs to this live encoder.
            unsafe { f(enc, mapped) };
          }
        }
        if let Some(registered) = self.registered.take() {
          if let Some(f) = self.functions.nvEncUnregisterResource {
            // SAFETY: registered belongs to this live encoder.
            unsafe { f(enc, registered) };
          }
        }
        if let Some(bitstream) = self.bitstream.take() {
          if let Some(f) = self.functions.nvEncDestroyBitstreamBuffer {
            // SAFETY: bitstream belongs to this live encoder.
            unsafe { f(enc, bitstream) };
          }
        }
        if let Some(f) = self.functions.nvEncDestroyEncoder {
          // SAFETY: all resources owned by this encoder were released above.
          unsafe { f(enc) };
        }
      }
      if let Some(ptr) = self.device_ptr.take() {
        // SAFETY: ptr was allocated in this context.
        unsafe { (self.cuda.mem_free)(ptr) };
      }
      drop(current);
    }
    // SAFETY: ctx was created by cuCtxCreate_v2 and has no live resources.
    unsafe { (self.cuda.ctx_destroy)(ctx) };
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::Mutex;
  use std::time::{Duration, Instant};

  static ENV_LOCK: Mutex<()> = Mutex::new(());
  fn settings() -> NvencSettings {
    NvencSettings {
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 12_000_000,
    }
  }
  struct LibraryOverride(Option<std::ffi::OsString>);
  impl LibraryOverride {
    fn set(path: &str) -> Self {
      let previous = std::env::var_os("VELOCITY_NVENC_LIBRARY");
      // SAFETY: All tests in this module serialize access through ENV_LOCK.
      unsafe { std::env::set_var("VELOCITY_NVENC_LIBRARY", path) };
      Self(previous)
    }
  }
  impl Drop for LibraryOverride {
    fn drop(&mut self) {
      // SAFETY: The test still holds ENV_LOCK while the override is restored.
      unsafe {
        if let Some(previous) = self.0.take() {
          std::env::set_var("VELOCITY_NVENC_LIBRARY", previous);
        } else {
          std::env::remove_var("VELOCITY_NVENC_LIBRARY");
        }
      }
    }
  }
  #[test]
  fn missing_nvenc_library_is_an_error() {
    let _lock = ENV_LOCK
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _override = LibraryOverride::set("/nonexistent/libnvidia-encode.so.1");
    let probe = NvencEncoder::probe().err().expect("probe should fail");
    let create = NvencEncoder::new(settings())
      .err()
      .expect("new should fail");
    assert!(probe.contains("libnvidia-encode"), "{probe}");
    assert!(create.contains("libnvidia-encode"), "{create}");
  }
  #[test]
  #[ignore = "needs an NVIDIA GPU and driver"]
  fn probe_names_nvidia_gpu() {
    let _lock = ENV_LOCK
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    let name = NvencEncoder::probe().unwrap();
    assert!(name.contains("NVIDIA"), "{name}");
  }
  fn frame(index: usize, width: usize, height: usize, stride: usize) -> Vec<u8> {
    let mut pixels = vec![0; stride * height];
    for y in 0..height {
      for x in 0..width {
        let colour = if x < width / 2 && y < height / 2 {
          [255, 0, 0]
        } else if x >= width / 2 && y < height / 2 {
          [0, 255, 0]
        } else if x < width / 2 {
          [0, 0, 255]
        } else {
          [255, 255, 255]
        };
        // The border moves while the quadrant centres stay solid for colour checks.
        let rgb = if x < 16 || y < 16 {
          [
            ((x + index) % 256) as u8,
            ((y + index) % 256) as u8,
            index as u8,
          ]
        } else {
          colour
        };
        let offset = y * stride + x * 4;
        pixels[offset..offset + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
      }
    }
    pixels
  }
  fn nal_types(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 4 < data.len() {
      let start = if data[i..].starts_with(&[0, 0, 0, 1]) {
        4
      } else if data[i..].starts_with(&[0, 0, 1]) {
        3
      } else {
        0
      };
      if start != 0 {
        out.push(data[i + start] & 31);
        i += start + 1;
      } else {
        i += 1;
      }
    }
    out
  }
  #[test]
  #[ignore = "needs an NVIDIA GPU and driver"]
  fn encodes_and_decodes_rgba_at_speed() {
    let _lock = ENV_LOCK
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    let settings = settings();
    let mut encoder = NvencEncoder::new(settings).unwrap();
    assert!(encoder.device_name().contains("NVIDIA"));
    let width = settings.width as usize;
    let height = settings.height as usize;
    let stride = width * 4 + 256;
    let mut output = Vec::with_capacity(120);
    let mut elapsed = Duration::ZERO;
    for index in 0..120 {
      let rgba = frame(index, width, height, stride);
      let start = Instant::now();
      let encoded = encoder.encode(&rgba, stride, index == 60).unwrap();
      elapsed += start.elapsed();
      output.push(encoded);
    }
    assert_eq!(output.len(), 120);
    assert!(output[0].keyframe);
    assert!(output[60].keyframe);
    let nals = nal_types(&output[0].annex_b);
    let sps = nals.iter().position(|&n| n == 7).expect("SPS");
    let pps = nals.iter().position(|&n| n == 8).expect("PPS");
    let idr = nals.iter().position(|&n| n == 5).expect("IDR");
    assert!(sps < pps && pps < idr, "NAL order: {nals:?}");
    let mut decoder = openh264::decoder::Decoder::new().unwrap();
    let mut count = 0;
    let mut last = Vec::new();
    for encoded in &output {
      if let Some(decoded) = decoder.decode(&encoded.annex_b).unwrap() {
        count += 1;
        last.resize(width * height * 3, 0);
        decoded.write_rgb8(&mut last);
      }
    }
    for decoded in decoder.flush_remaining().unwrap() {
      count += 1;
      last.resize(width * height * 3, 0);
      decoded.write_rgb8(&mut last);
    }
    assert_eq!(count, 120);
    for (x, y, wanted) in [
      (width / 4, height / 4, [255i16, 0, 0]),
      (width * 3 / 4, height / 4, [0, 255, 0]),
      (width / 4, height * 3 / 4, [0, 0, 255]),
      (width * 3 / 4, height * 3 / 4, [255, 255, 255]),
    ] {
      let actual = &last[(y * width + x) * 3..][..3];
      for channel in 0..3 {
        assert!(
          (actual[channel] as i16 - wanted[channel]).abs() <= 24,
          "at ({x},{y}), got {actual:?}, wanted {wanted:?}"
        );
      }
    }
    let fps = 120.0 / elapsed.as_secs_f64();
    println!("NVENC encode fps: {fps:.1}");
    #[cfg(not(debug_assertions))]
    assert!(fps > 100.0, "NVENC encode fps was {fps:.1}");
  }
}
