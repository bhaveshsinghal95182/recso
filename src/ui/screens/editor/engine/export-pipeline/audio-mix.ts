import { isInCutRegion, mapSourceTimeToCompositionTimeMs } from '../functions';
import type { CompositionConfig } from '../types';

/**
 * Sidecar pipelines (system audio, standalone mic) are opened by the renderer *after* the native
 * screen capture is already running, but every stream is stopped together. The warm-up delay
 * therefore shows up as a sidecar that is shorter than the screen recording, and we shift the
 * sidecar forward by that difference to line it back up.
 */
const MAX_START_DELAY_COMPENSATION_SECONDS = 3;
const MIN_START_DELAY_COMPENSATION_SECONDS = 0.05;
const MIXED_AUDIO_BITRATE = 160_000;

export interface ExtraAudioSource {
  /** `file://` URL of the sidecar file whose primary audio track should be mixed in. */
  url: string;
  /** Label used for diagnostics only. */
  label: string;
  /**
   * Sidecars that also drive a rendered overlay (the camera file) must stay locked to that
   * overlay, which is drawn without start-delay compensation. Audio-only sidecars are free to be
   * realigned.
   */
  compensateStartDelay: boolean;
}

interface TimedAudioBuffer {
  buffer: AudioBuffer;
  timestamp: number;
  duration: number;
}

function mapSourceAudioTimestampToComposition(
  sourceTimestampSeconds: number,
  cuts: CompositionConfig['cuts'],
): number | null {
  const sourceTimeMs = sourceTimestampSeconds * 1000;
  if (isInCutRegion(sourceTimeMs, cuts)) {
    return null;
  }

  return mapSourceTimeToCompositionTimeMs(sourceTimeMs, cuts) / 1000;
}

function resolveStartDelayCompensationSeconds(
  sourceDurationSeconds: number,
  sidecarDurationSeconds: number,
): number {
  if (!Number.isFinite(sourceDurationSeconds) || !Number.isFinite(sidecarDurationSeconds)) {
    return 0;
  }

  const delaySeconds = sourceDurationSeconds - sidecarDurationSeconds;
  if (
    delaySeconds < MIN_START_DELAY_COMPENSATION_SECONDS ||
    delaySeconds > MAX_START_DELAY_COMPENSATION_SECONDS
  ) {
    return 0;
  }

  return delaySeconds;
}

function normaliseAudioBufferInPlace(buffer: AudioBuffer, targetPeak = 0.98): void {
  let peak = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let index = 0; index < channelData.length; index += 1) {
      const amplitude = Math.abs(channelData[index]);
      if (amplitude > peak) {
        peak = amplitude;
      }
    }
  }

  if (peak <= 0 || peak <= targetPeak) {
    return;
  }

  const gain = targetPeak / peak;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let index = 0; index < channelData.length; index += 1) {
      channelData[index] *= gain;
    }
  }
}

/**
 * Mixes every recorded audio source into the rendered video.
 *
 * The rendered buffer only carries whatever audio the screen recording itself had; microphone and
 * system audio live in sidecar files whenever the recorder could not embed them. This remuxes the
 * rendered video track together with a single mixed-down audio track built from all of them.
 */
export async function appendMixedAudioTrack(
  renderedBuffer: ArrayBuffer,
  extraSources: ExtraAudioSource[],
  cuts: CompositionConfig['cuts'],
  sourceDurationSeconds: number,
  compositionDurationSeconds: number,
  isCancelRequested: () => boolean,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const {
    ALL_FORMATS,
    AudioBufferSink,
    AudioBufferSource,
    BlobSource,
    BufferTarget,
    EncodedPacketSink,
    EncodedVideoPacketSource,
    getFirstEncodableAudioCodec,
    Input,
    Mp4OutputFormat,
    Output,
  } = await import('mediabunny');

  const disposableInputs: InstanceType<typeof Input>[] = [];
  const remuxTarget = new BufferTarget();
  let remuxOutput: InstanceType<typeof Output> | null = null;

  const renderedInput = new Input({
    source: new BlobSource(new Blob([renderedBuffer])),
    formats: ALL_FORMATS,
  });
  disposableInputs.push(renderedInput);

  try {
    const loadedExtraTracks: {
      label: string;
      track: NonNullable<Awaited<ReturnType<InstanceType<typeof Input>['getPrimaryAudioTrack']>>>;
      offsetSeconds: number;
    }[] = [];

    for (const source of extraSources) {
      if (!source.url) {
        continue;
      }

      try {
        const response = await fetch(source.url);
        if (!response.ok && response.status !== 0) {
          continue;
        }

        const input = new Input({
          source: new BlobSource(await response.blob()),
          formats: ALL_FORMATS,
        });
        disposableInputs.push(input);

        const track = await input.getPrimaryAudioTrack();
        // Native recordings can carry an audio track with zero samples, so the track has to be
        // checked for actual content rather than mere existence.
        const trackDurationSeconds = track ? await track.computeDuration() : 0;
        if (!track || trackDurationSeconds <= 0) {
          continue;
        }

        loadedExtraTracks.push({
          label: source.label,
          track,
          offsetSeconds: source.compensateStartDelay
            ? resolveStartDelayCompensationSeconds(sourceDurationSeconds, trackDurationSeconds)
            : 0,
        });
      } catch (error) {
        console.warn(`[EngineCanvasExport] Skipping ${source.label} audio source:`, error);
      }
    }

    if (loadedExtraTracks.length === 0) {
      // Nothing to add — the rendered buffer already holds whatever audio the source video had.
      return renderedBuffer;
    }

    const [renderedVideoTrack, renderedAudioTrack] = await Promise.all([
      renderedInput.getPrimaryVideoTrack(),
      renderedInput.getPrimaryAudioTrack(),
    ]);

    if (!renderedVideoTrack || !renderedVideoTrack.codec) {
      console.warn(
        '[EngineCanvasExport] Audio mix skipped: rendered output has no compatible video track.',
      );
      return renderedBuffer;
    }

    if (typeof OfflineAudioContext === 'undefined') {
      console.warn('[EngineCanvasExport] OfflineAudioContext unavailable. Skipping audio mix.');
      return renderedBuffer;
    }

    onProgress?.(0.1);

    const readTimedAudioBuffers = async (
      audioTrack: ConstructorParameters<typeof AudioBufferSink>[0],
      offsetSeconds: number,
    ): Promise<TimedAudioBuffer[]> => {
      const sink = new AudioBufferSink(audioTrack);
      const buffers: TimedAudioBuffer[] = [];

      for await (const wrapped of sink.buffers()) {
        if (isCancelRequested()) {
          throw new Error('Export cancelled');
        }

        buffers.push({
          buffer: wrapped.buffer,
          timestamp: wrapped.timestamp + offsetSeconds,
          duration: wrapped.duration,
        });
      }

      return buffers;
    };

    const renderedAudioBuffers = renderedAudioTrack
      ? await readTimedAudioBuffers(
          renderedAudioTrack as ConstructorParameters<typeof AudioBufferSink>[0],
          0,
        )
      : [];

    const mappedExtraAudioBuffers: TimedAudioBuffer[] = [];
    for (const loaded of loadedExtraTracks) {
      if (loaded.offsetSeconds > 0) {
        console.log(
          `[EngineCanvasExport] Compensating ${loaded.label} start delay by ${(loaded.offsetSeconds * 1000).toFixed(0)}ms.`,
        );
      }

      const buffers = await readTimedAudioBuffers(
        loaded.track as ConstructorParameters<typeof AudioBufferSink>[0],
        loaded.offsetSeconds,
      );

      buffers.forEach((wrapped) => {
        const mappedTimestamp = mapSourceAudioTimestampToComposition(wrapped.timestamp, cuts);
        if (mappedTimestamp === null) {
          return;
        }

        mappedExtraAudioBuffers.push({
          buffer: wrapped.buffer,
          timestamp: mappedTimestamp,
          duration: wrapped.duration,
        });
      });
    }
    onProgress?.(0.3);

    if (mappedExtraAudioBuffers.length === 0) {
      return renderedBuffer;
    }

    const resolveMaxEndSeconds = (buffers: TimedAudioBuffer[]): number =>
      buffers.reduce(
        (maxEnd, wrapped) => Math.max(maxEnd, wrapped.timestamp + wrapped.duration),
        0,
      );

    const targetSampleRate =
      renderedAudioTrack?.sampleRate ?? loadedExtraTracks[0].track.sampleRate ?? 48_000;
    const targetChannelCount = Math.max(
      1,
      Math.min(
        2,
        Math.max(
          renderedAudioTrack?.numberOfChannels ?? 0,
          ...loadedExtraTracks.map((loaded) => loaded.track.numberOfChannels ?? 0),
          1,
        ),
      ),
    );
    const targetDurationSeconds = Math.max(
      compositionDurationSeconds,
      resolveMaxEndSeconds(renderedAudioBuffers),
      resolveMaxEndSeconds(mappedExtraAudioBuffers),
    );
    const targetFrameCount = Math.max(1, Math.ceil(targetDurationSeconds * targetSampleRate));

    const audioCodec = await getFirstEncodableAudioCodec(
      new Mp4OutputFormat().getSupportedAudioCodecs(),
      {
        numberOfChannels: targetChannelCount,
        sampleRate: targetSampleRate,
        bitrate: MIXED_AUDIO_BITRATE,
      },
    );

    if (!audioCodec) {
      console.warn('[EngineCanvasExport] No encodable audio codec available. Skipping audio mix.');
      return renderedBuffer;
    }

    const mixContext = new OfflineAudioContext(
      targetChannelCount,
      targetFrameCount,
      targetSampleRate,
    );

    const scheduleTimedBuffer = (wrapped: TimedAudioBuffer): void => {
      const sourceNode = mixContext.createBufferSource();
      sourceNode.buffer = wrapped.buffer;

      const gainNode = mixContext.createGain();
      gainNode.gain.value = 1;

      sourceNode.connect(gainNode);
      gainNode.connect(mixContext.destination);

      const when = Math.max(0, wrapped.timestamp);
      const offset = wrapped.timestamp < 0 ? -wrapped.timestamp : 0;
      const availableDuration = Math.max(0, wrapped.buffer.duration - offset);
      const cappedDuration = Math.min(availableDuration, targetDurationSeconds - when);

      if (cappedDuration <= 0) {
        return;
      }

      sourceNode.start(when, offset, cappedDuration);
    };

    renderedAudioBuffers.forEach(scheduleTimedBuffer);
    mappedExtraAudioBuffers.forEach(scheduleTimedBuffer);

    const mixedAudioBuffer = await mixContext.startRendering();
    normaliseAudioBufferInPlace(mixedAudioBuffer);
    onProgress?.(0.5);

    remuxOutput = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: remuxTarget,
    });

    const renderedVideoSource = new EncodedVideoPacketSource(renderedVideoTrack.codec);
    remuxOutput.addVideoTrack(renderedVideoSource);

    const mixedAudioSource = new AudioBufferSource({
      codec: audioCodec,
      bitrate: MIXED_AUDIO_BITRATE,
    });
    remuxOutput.addAudioTrack(mixedAudioSource);

    const renderedVideoDecoderConfig = await renderedVideoTrack.getDecoderConfig();
    const renderedVideoSink = new EncodedPacketSink(renderedVideoTrack);

    await remuxOutput.start();

    let renderedVideoPacket = await renderedVideoSink.getFirstPacket();
    let wroteRenderedVideo = false;
    let packetIndex = 0;
    while (renderedVideoPacket) {
      if (isCancelRequested()) {
        throw new Error('Export cancelled');
      }

      await renderedVideoSource.add(
        renderedVideoPacket,
        !wroteRenderedVideo && renderedVideoDecoderConfig
          ? { decoderConfig: renderedVideoDecoderConfig }
          : undefined,
      );

      wroteRenderedVideo = true;
      packetIndex += 1;
      // Report remux progress in the 50%–85% range (packet count isn't known upfront,
      // so we use a diminishing-returns curve that asymptotically approaches 0.85).
      if (packetIndex % 20 === 0) {
        onProgress?.(0.5 + 0.35 * (1 - 1 / (1 + packetIndex / 200)));
      }
      renderedVideoPacket = await renderedVideoSink.getNextPacket(renderedVideoPacket);
    }

    if (!wroteRenderedVideo) {
      await remuxOutput.cancel();
      return renderedBuffer;
    }

    if (isCancelRequested()) {
      throw new Error('Export cancelled');
    }

    await mixedAudioSource.add(mixedAudioBuffer);
    onProgress?.(0.9);

    await remuxOutput.finalize();
    return remuxTarget.buffer ?? renderedBuffer;
  } catch (error) {
    if (isCancelRequested()) {
      throw new Error('Export cancelled');
    }

    console.warn('[EngineCanvasExport] Failed to mix audio tracks:', error);

    if (remuxOutput && remuxOutput.state !== 'finalized' && remuxOutput.state !== 'canceled') {
      await remuxOutput.cancel();
    }

    return renderedBuffer;
  } finally {
    disposableInputs.forEach((input) => input.dispose());
  }
}
