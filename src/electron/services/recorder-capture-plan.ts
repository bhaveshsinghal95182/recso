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
  /** `RECSO_LEGACY_CAPTURE=1` in the environment: the escape hatch. */
  legacyForced?: boolean;
}

/**
 * Whether to record through the native singular-clock path.
 *
 * Native is the default now. The legacy path drives the screen capture from the
 * renderer and records the camera with a `MediaRecorder` sidecar, which means
 * two independent clocks that have to be reconciled afterwards; the native path
 * writes both tracks from one, which is the whole reason it exists.
 *
 * Two ways back to legacy, in order: an explicit `nativeCaptureMode: 'legacy'`
 * on the recording, or `RECSO_LEGACY_CAPTURE=1` for when something is wrong and
 * the question is whether the native path caused it.
 *
 * A phone overrides even those. Its frames only ever reach a recording through
 * the native webcam sidecar, so falling back would not produce a worse camera
 * track -- it would produce none, silently.
 */
export function shouldUseNativeSingularClock(config: CaptureModeInput): boolean {
  if (config.cameraSource === 'phone') {
    return true;
  }

  if (config.nativeCaptureMode === 'legacy') {
    return false;
  }

  return !config.legacyForced;
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
