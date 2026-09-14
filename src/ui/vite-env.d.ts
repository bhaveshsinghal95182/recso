/// <reference types="vite/client" />

/** App version from the root package.json, supplied by Vite. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /**
   * Path to a video file. When set in a dev build, the engine harness opens it
   * on mount, plays for a moment, then reads the canvas back and logs what it
   * actually painted -- the unattended presentation check. See the harness.
   */
  readonly VITE_ENGINE_AUTORUN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
