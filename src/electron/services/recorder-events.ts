/**
 * Recording and project lifecycle events, whoever caused them.
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

export interface RecordingStoppingEvent {
  recordingId: string;
}

export interface RecordingStoppedEvent {
  recordingId: string;
  result: StopRecordingResult;
  clicks: number;
}

interface RecorderEventMap {
  started: [RecordingStartedEvent];
  stopping: [RecordingStoppingEvent];
  stopped: [RecordingStoppedEvent];
}

export const recorderEvents = new EventEmitter<RecorderEventMap>();

export interface ProjectSavedEvent {
  projectDir: string;
  name: string;
  recordingId: string;
}

/** Every write of a project's `.recso/project.json`, from the editor or the API. */
export const projectEvents = new EventEmitter<{ saved: [ProjectSavedEvent] }>();
