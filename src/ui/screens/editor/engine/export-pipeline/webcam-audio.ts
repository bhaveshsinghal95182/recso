import { isInCutRegion, mapSourceTimeToCompositionTimeMs } from '../functions';
import type { CompositionConfig } from '../types';

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

export async function appendWebcamAudioTrack(
  renderedBuffer: ArrayBuffer,
  webcamSourceUrl: string,
  cuts: CompositionConfig['cuts'],
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
    Input,
    Mp4OutputFormat,
    Output,
  } = await import('mediabunny');

  let webcamResponse: Response;
  try {
    webcamResponse = await fetch(webcamSourceUrl);
    if (!webcamResponse.ok && webcamResponse.status !== 0) {
      console.warn(
        '[EngineCanvasExport] Failed to fetch webcam source for audio remux:',
        webcamResponse.status,
      );
      return renderedBuffer;
    }
  } catch (error) {
    console.warn('[EngineCanvasExport] Failed to fetch webcam source for audio remux:', error);
    return renderedBuffer;
  }

  const webcamBlob = await webcamResponse.blob();
  onProgress?.(0.1);

  const renderedInput = new Input({
    source: new BlobSource(new Blob([renderedBuffer])),
    formats: ALL_FORMATS,
  });
  const webcamInput = new Input({
    source: new BlobSource(webcamBlob),
    formats: ALL_FORMATS,
  });

  const remuxTarget = new BufferTarget();
  let remuxOutput: InstanceType<typeof Output> | null = null;

  try {
    const [renderedVideoTrack, renderedAudioTrack, webcamAudioTrack] = await Promise.all([
      renderedInput.getPrimaryVideoTrack(),
      renderedInput.getPrimaryAudioTrack(),
      webcamInput.getPrimaryAudioTrack(),
    ]);

    if (!renderedVideoTrack || !renderedVideoTrack.codec) {
      console.warn(
        '[EngineCanvasExport] Remux skipped: rendered output has no compatible video track.',
      );
      return renderedBuffer;
    }

    if (!webcamAudioTrack || !webcamAudioTrack.codec) {
      return renderedBuffer;
    }

    if (typeof OfflineAudioContext === 'undefined') {
      console.warn(
        '[EngineCanvasExport] OfflineAudioContext unavailable. Skipping webcam audio mix.',
      );
      return renderedBuffer;
    }

    type TimedAudioBuffer = {
      buffer: AudioBuffer;
      timestamp: number;
      duration: number;
    };

    const readTimedAudioBuffers = async (audioTrack: unknown): Promise<TimedAudioBuffer[]> => {
      if (!audioTrack) {
        return [];
      }

      const sink = new AudioBufferSink(
        audioTrack as ConstructorParameters<typeof AudioBufferSink>[0],
      );
      const buffers: TimedAudioBuffer[] = [];

      for await (const wrapped of sink.buffers()) {
        if (isCancelRequested()) {
          throw new Error('Export cancelled');
        }

        buffers.push({
          buffer: wrapped.buffer,
          timestamp: wrapped.timestamp,
          duration: wrapped.duration,
        });
      }

      return buffers;
    };

    const [renderedAudioBuffers, webcamAudioBuffers] = await Promise.all([
      readTimedAudioBuffers(renderedAudioTrack),
      readTimedAudioBuffers(webcamAudioTrack),
    ]);
    onProgress?.(0.3);

    const mappedWebcamAudioBuffers: TimedAudioBuffer[] = webcamAudioBuffers
      .map((wrapped) => {
        const mappedTimestamp = mapSourceAudioTimestampToComposition(wrapped.timestamp, cuts);
        if (mappedTimestamp === null) {
          return null;
        }

        return {
          buffer: wrapped.buffer,
          timestamp: mappedTimestamp,
          duration: wrapped.duration,
        };
      })
      .filter((wrapped): wrapped is TimedAudioBuffer => wrapped !== null);

    if (mappedWebcamAudioBuffers.length === 0) {
      return renderedBuffer;
    }

    const renderedAudioEndSeconds = renderedAudioBuffers.reduce(
      (maxEnd, wrapped) => Math.max(maxEnd, wrapped.timestamp + wrapped.duration),
      0,
    );
    const webcamAudioEndSeconds = mappedWebcamAudioBuffers.reduce(
      (maxEnd, wrapped) => Math.max(maxEnd, wrapped.timestamp + wrapped.duration),
      0,
    );

    const targetSampleRate =
      renderedAudioTrack?.sampleRate ?? webcamAudioTrack.sampleRate ?? 48_000;
    const targetChannelCount = Math.max(
      1,
      Math.min(
        2,
        Math.max(
          renderedAudioTrack?.numberOfChannels ?? 0,
          webcamAudioTrack.numberOfChannels ?? 0,
          1,
        ),
      ),
    );
    const targetDurationSeconds = Math.max(
      compositionDurationSeconds,
      renderedAudioEndSeconds,
      webcamAudioEndSeconds,
    );
    const targetFrameCount = Math.max(1, Math.ceil(targetDurationSeconds * targetSampleRate));

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
    mappedWebcamAudioBuffers.forEach(scheduleTimedBuffer);

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
      codec: 'aac',
      bitrate: 160_000,
    });
    remuxOutput.addAudioTrack(mixedAudioSource);

    const [renderedVideoDecoderConfig, renderedVideoSink] = await Promise.all([
      renderedVideoTrack.getDecoderConfig(),
      Promise.resolve(new EncodedPacketSink(renderedVideoTrack)),
    ]);

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

    console.warn('[EngineCanvasExport] Failed to append webcam audio track:', error);

    if (remuxOutput && remuxOutput.state !== 'finalized' && remuxOutput.state !== 'canceled') {
      await remuxOutput.cancel();
    }

    return renderedBuffer;
  } finally {
    renderedInput.dispose();
    webcamInput.dispose();
  }
}
