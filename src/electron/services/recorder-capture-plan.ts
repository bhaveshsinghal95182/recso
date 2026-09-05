/**
 * Decisions about which capture path a recording takes.
 *
 * Pure, and in their own file, because this is where the choice between "native
 * capture writes the camera track" and "the renderer records a sidecar" is
 * actually made -- and getting it wrong produces a recording that is *missing* a
 * track rather than one that fails, which is the worst kind of bug to find
 * later. `recorder.service.ts` cannot be loaded outside Electron, so anything
 * left in there is untestable by construction.
 */

export interface PhoneReadiness {
  recordCamera?: boolean;
  cameraSource?: 'local' | 'phone';
}

/**
 * Why a recording cannot start with the phone that was chosen, if it cannot.
 *
 * Separate from the native-webcam capability check because the two ask different
 * questions: that one asks what cameras this machine has, which is irrelevant to
 * a phone and would reject one on a laptop with no built-in webcam at all.
 *
 * Returns `null` when there is nothing wrong, so the caller reads as a guard.
 */
export function phoneCameraProblem(config: PhoneReadiness, phoneLive: boolean): string | null {
  if (!config.recordCamera || config.cameraSource !== 'phone') {
    return null;
  }

  if (!phoneLive) {
    return 'The phone is not sending a picture. Open the phone camera panel, scan the code, and tap Start camera before recording.';
  }

  return null;
}

export interface NativeAudioInput {
  recordSystemAudio?: boolean;
  recordMic?: boolean;
  /** WASAPI is Windows-only. */
  platform: string;
}

export interface NativeAudioPlan {
  /** Capture what the machine is playing, into the video's own track. */
  systemAudio: boolean;
  /** Capture the default microphone, into the same track. */
  microphone: boolean;
}

/**
 * Which audio the native recorder should capture itself.
 *
 * The alternative -- and what this replaces -- is recording each source in the
 * renderer as its own file and muxing them afterwards. That cannot work
 * properly: the sidecars start whenever `getUserMedia` finishes opening a
 * device, which is after the IPC round trip and after native capture has
 * already begun, and nothing records *when*. The offset then has to be inferred
 * from the difference in durations, which assumes the whole gap was warm-up at
 * the start. It is a guess, and when it is wrong the audio is a second out with
 * nothing on screen to say so.
 *
 * Captured natively there is no offset to guess. The audio is written into the
 * same encoder as the picture, in buffers sized against the picture's own frame
 * timestamps, and zero-padded while a device is still starting -- so the silence
 * during warm-up lands exactly where the silence actually was.
 *
 * Windows only, since this is WASAPI. There is no longer a renderer fallback
 * behind it -- recording requires the native addon, which is Windows-only too,
 * so anywhere this returns false there was never going to be a recording.
 */
export function planNativeAudio(config: NativeAudioInput): NativeAudioPlan {
  const available = config.platform === 'win32';

  return {
    systemAudio: available && Boolean(config.recordSystemAudio),
    microphone: available && Boolean(config.recordMic),
  };
}
