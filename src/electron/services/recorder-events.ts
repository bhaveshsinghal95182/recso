/**
 * Recording lifecycle events, whoever started or stopped the recording.
 *
 * The recorder's button and the Automation API both go through the same
 * session functions in `recorder.ipc.ts`, which raise these. The Automation
 * API listens (for its own events and hooks); nothing else needs to.
 */

import { EventEmitter } from 'node:events';

import type { RecordingConfig, StopRecordingResult } from '../types/recorder.types.js';

export interface RecordingStartedEvent {
  recordingId: string;
  config: RecordingConfig;
}

export interface RecordingStoppedEvent {
  recordingId: string;
  result: StopRecordingResult;
  clicks: number;
}

interface RecorderEventMap {
  started: [RecordingStartedEvent];
  stopped: [RecordingStoppedEvent];
}

export const recorderEvents = new EventEmitter<RecorderEventMap>();
