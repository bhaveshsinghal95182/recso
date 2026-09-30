/** Give common RPC results a concise terminal view while preserving arbitrary results as JSON. */

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sentence(value: string): string {
  const index = value.indexOf('.');
  return index < 0 ? value : value.slice(0, index + 1);
}

export function formatHuman(name: string, result: unknown): string {
  const fallback = () => {
    try {
      return JSON.stringify(result, null, 2) ?? String(result);
    } catch {
      return '[unserializable result]';
    }
  };
  try {
    const data = object(result);
    if (!data) return fallback();
    if (name === 'status') {
      const engine = object(data.engine);
      const recording = object(data.recording);
      const editor = data.editor === null ? null : object(data.editor);
      if (
        typeof data.app !== 'string' ||
        typeof data.api !== 'string' ||
        typeof data.platform !== 'string' ||
        typeof data.socket !== 'string' ||
        !engine ||
        typeof engine.available !== 'boolean' ||
        !Array.isArray(engine.encoders) ||
        !engine.encoders.every((x) => typeof x === 'string') ||
        !recording ||
        typeof recording.state !== 'string' ||
        (data.editor !== null &&
          (!editor || typeof editor.name !== 'string' || typeof editor.projectDir !== 'string'))
      )
        return fallback();
      if (
        recording.state !== 'idle' &&
        (typeof recording.durationMs !== 'number' || typeof recording.recordingId !== 'string')
      )
        return fallback();
      return [
        `recso ${data.app} (${data.platform}), API ${data.api}`,
        `Socket: ${data.socket}`,
        engine.available
          ? `Engine: available, encoders ${engine.encoders.join(', ')}`
          : 'Engine: not available',
        recording.state === 'idle'
          ? 'Recording: idle'
          : `Recording: recording for ${((recording.durationMs as number) / 1000).toFixed(1)} s (${recording.recordingId})`,
        editor ? `Editor: ${editor.name} (${editor.projectDir})` : 'Editor: no project open',
      ].join('\n');
    }
    if (name === 'describe') {
      if (!Array.isArray(data.methods) || !Array.isArray(data.events)) return fallback();
      const methods = data.methods.map(object);
      const events = data.events.map(object);
      if (
        [...methods, ...events].some(
          (entry) =>
            !entry || typeof entry.name !== 'string' || typeof entry.description !== 'string',
        )
      )
        return fallback();
      const width = Math.max(0, ...methods.map((entry) => (entry!.name as string).length));
      return [
        ...methods.map(
          (entry) =>
            `${(entry!.name as string).padEnd(width)}  ${sentence(entry!.description as string)}`,
        ),
        '',
        'Events:',
        ...events.map((entry) => `${entry!.name}  ${sentence(entry!.description as string)}`),
      ].join('\n');
    }
    if (name === 'start' && typeof data.videoPath === 'string')
      return `Recording → ${data.videoPath}`;
    if (
      name === 'stop' &&
      typeof data.videoPath === 'string' &&
      typeof data.durationMs === 'number' &&
      typeof data.projectDir === 'string'
    )
      return data.projectDir;
    if (name === 'export' && typeof data.output === 'string') {
      if (data.state === 'finished') return data.output;
      if (typeof data.exportId === 'string')
        return `Exporting → ${data.output} (id ${data.exportId})`;
    }
    return fallback();
  } catch {
    return fallback();
  }
}
