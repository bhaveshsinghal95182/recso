# NVENC header

`nvEncodeAPI.h` is unmodified from [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) at tag `n13.0.19.0` (`include/ffnvcodec/nvEncodeAPI.h`). NVIDIA licenses it under MIT; the license text is in the header itself. Nothing links against NVIDIA's libraries at build time: `capture/linux/nvenc.rs` loads `libcuda.so.1` and `libnvidia-encode.so.1` from the installed driver at runtime.

`src/capture/linux/nvenc_sys.rs` is generated from it. To regenerate, run this from the repository root with bindgen-cli 0.73 (`cargo install bindgen-cli`):

```sh
bindgen velocity/third_party/nvenc/nvEncodeAPI.h \
  --allowlist-type 'GUID|NVENCSTATUS|NV_ENC_(BUFFER_FORMAT|DEVICE_TYPE|INPUT_RESOURCE_TYPE|PIC_STRUCT|PIC_FLAGS|PIC_TYPE|PARAMS_RC_MODE|TUNING_INFO|CONFIG|CONFIG_H264|RC_PARAMS|INITIALIZE_PARAMS|PRESET_CONFIG|OPEN_ENCODE_SESSIONEX_PARAMS|REGISTER_RESOURCE|MAP_INPUT_RESOURCE|PIC_PARAMS|PIC_PARAMS_H264|LOCK_BITSTREAM|CREATE_BITSTREAM_BUFFER|CAPS_PARAM)|NV_ENCODE_API_FUNCTION_LIST|PNVENC.*' \
  --allowlist-var 'NV_ENC_(H264_PROFILE_HIGH_GUID|PRESET_P4_GUID|CODEC_H264_GUID)' \
  --no-layout-tests --no-derive-debug \
  --output velocity/src/capture/linux/nvenc_sys.rs
```

Then put back the `#![allow(...)]` block at the top of the generated file.
