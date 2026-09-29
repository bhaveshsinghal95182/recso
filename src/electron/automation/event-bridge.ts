/**
 * recso's own events, as Automation API events.
 *
 * Connected only while the API is on; the returned function disconnects
 * everything, so an API that has been turned off leaves no listener behind.
 * Export events don't pass through here: the export jobs raise them.
 */

import {
  projectSavedPayload,
  recordingStartedPayload,
  recordingStoppedPayload,
} from './methods/events.js';
import { projectEvents, recorderEvents } from '../services/recorder-events.js';
import type { SettingsStore } from './settings-store.js';

export type EventSink = (event: string, payload: unknown) => void;

export function connectEvents(sink: EventSink, settings: SettingsStore): () => void {
  const onStarted = (event: Parameters<typeof recordingStartedPayload>[0]) => {
    sink('recording.started', recordingStartedPayload(event));
    sink('recording.stateChanged', { state: 'recording', recordingId: event.recordingId });
  };
  const onStopping = ({ recordingId }: { recordingId: string }) => {
    sink('recording.stateChanged', { state: 'stopping', recordingId });
  };
  const onStopped = (event: Parameters<typeof recordingStoppedPayload>[0]) => {
    sink('recording.stateChanged', { state: 'idle', recordingId: event.recordingId });
    sink('recording.stopped', recordingStoppedPayload(event));
  };
  const onSaved = (event: Parameters<typeof projectSavedPayload>[0]) => {
    sink('project.saved', projectSavedPayload(event));
  };

  recorderEvents.on('started', onStarted);
  recorderEvents.on('stopping', onStopping);
  recorderEvents.on('stopped', onStopped);
  projectEvents.on('saved', onSaved);
  const offSettings = settings.onChange((changed) =>
    sink('settings.changed', { changed: Object.keys(changed), values: settings.get() }),
  );

  return () => {
    recorderEvents.off('started', onStarted);
    recorderEvents.off('stopping', onStopping);
    recorderEvents.off('stopped', onStopped);
    projectEvents.off('saved', onSaved);
    offSettings();
  };
}
