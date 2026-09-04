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

export interface CaptureModeInput {
  nativeCaptureMode?: 'legacy' | 'native-singular-clock';
  cameraSource?: 'local' | 'phone';
  /** `RECSO_NATIVE_SINGULAR_CLOCK=1` in the environment. */
  nativeClockForced?: boolean;
}

/**
 * Whether to record through the native singular-clock path.
 *
 * A phone forces it on. That is not a preference -- a phone's frames only ever
 * reach a recording through the native webcam sidecar, so without this the whole
 * native block is skipped, no camera track is written, and (because the renderer
 * sidecar cannot open a phone either) nothing is recorded at all. Silently.
 */
export function shouldUseNativeSingularClock(config: CaptureModeInput): boolean {
  if (config.nativeCaptureMode === 'native-singular-clock') {
    return true;
  }

  if (config.cameraSource === 'phone') {
    return true;
  }

  return Boolean(config.nativeClockForced);
}

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
