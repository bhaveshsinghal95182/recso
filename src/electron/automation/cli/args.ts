/** Keep CLI spelling and validation at the edge so RPC calls stay typed and predictable. */

import path from 'node:path';

export interface GlobalOptions {
  json: boolean;
  launch: boolean;
  socket?: string;
  timeoutMs: number;
  help: boolean;
  version: boolean;
}

export type Command =
  | { kind: 'call'; method: string; params: Record<string, unknown> }
  | { kind: 'events'; events: string[] }
  | { kind: 'mcp' }
  | { kind: 'help'; topic?: string };

export interface ParsedCli {
  global: GlobalOptions;
  command: Command;
  name: string;
}

export class UsageError extends Error {}

export const USAGE = `Usage: recso-cli [global flags] <command> [options]

Global flags (may appear anywhere):
  --json                 Print JSON results and errors
  --launch               Start recso if it is not running
  --socket PATH          Use a specific socket or named pipe
  --timeout MS           Wait this long for --launch (default: 30000)
  -h, --help             Show help
  --version              Show CLI API version

Commands:
  status | describe | version | show
  call <method> [json]
  record start [--source ID] [--out DIR] [--name NAME] [--system-audio|--no-system-audio] [--mic|--no-mic] [--mic-device ID] [--camera|--no-camera] [--camera-device ID] [--remember-source]
  record stop | pause | resume | state
  sources forget
  projects list [--dir DIR] [--limit N]
  projects get <dir> | open <dir>
  export <projectDir> [--out FILE] [--preset NAME] [--encoder auto|hardware|software] [--overwrite] [--wait]
  export progress <exportId> | cancel <exportId> | wait <exportId> [--timeout-ms N]
  settings get [key...] | set key=value [key=value...]
  devices
  events [name...]
  mcp
  help [topic]`;

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
    throw new UsageError(`${flag} requires a positive integer`);
  }
  return number;
}

function requireCount(args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new UsageError(`Expected ${usage}`);
}

function options(
  tokens: string[],
  values: Record<string, string>,
  switches: Record<string, string>,
): { positional: string[]; params: Record<string, unknown> } {
  const positional: string[] = [];
  const params: Record<string, unknown> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const [flag, inline] = splitFlag(token);
    if (flag in values) {
      const value = inline ?? tokens[++i];
      if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
      params[values[flag]] = value;
    } else if (flag in switches) {
      if (inline !== undefined) throw new UsageError(`${flag} does not take a value`);
      params[switches[flag].replace(/^!/, '')] = !switches[flag].startsWith('!');
    } else if (token.startsWith('-')) {
      throw new UsageError(`Unknown flag: ${token}`);
    } else {
      positional.push(token);
    }
  }
  return { positional, params };
}

function splitFlag(token: string): [string, string | undefined] {
  const index = token.indexOf('=');
  return index < 0 ? [token, undefined] : [token.slice(0, index), token.slice(index + 1)];
}

function call(
  name: string,
  method: string,
  params: Record<string, unknown> = {},
): ParsedCli['command'] {
  return { kind: 'call', method, params };
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const global: GlobalOptions = {
    json: false,
    launch: false,
    timeoutMs: 30000,
    help: false,
    version: false,
  };
  const tokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = splitFlag(argv[i]);
    if (
      flag === '--json' ||
      flag === '--launch' ||
      flag === '-h' ||
      flag === '--help' ||
      flag === '--version'
    ) {
      if (inline !== undefined) throw new UsageError(`${flag} does not take a value`);
      if (flag === '--json') global.json = true;
      if (flag === '--launch') global.launch = true;
      if (flag === '-h' || flag === '--help') global.help = true;
      if (flag === '--version') global.version = true;
    } else if (flag === '--socket' || flag === '--timeout') {
      const value = inline ?? argv[++i];
      if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
      if (flag === '--socket') global.socket = value;
      else global.timeoutMs = positiveInteger(value, flag);
    } else tokens.push(argv[i]);
  }
  const [name = 'help', ...rest] = tokens;
  let command: Command;
  if (name === 'help') {
    requireCount(rest, Math.min(rest.length, 1), 'help [topic]');
    command = { kind: 'help', ...(rest[0] ? { topic: rest[0] } : {}) };
  } else if (['status', 'describe', 'version', 'show', 'devices'].includes(name)) {
    requireCount(rest, 0, name);
    const method = {
      status: 'app.status',
      describe: 'api.describe',
      version: 'api.version',
      show: 'app.show',
      devices: 'devices.list',
    }[name];
    command = call(name, method!);
  } else if (name === 'call') {
    if (rest.length < 1 || rest.length > 2) throw new UsageError('Expected call <method> [json]');
    let params: unknown = {};
    if (rest[1] !== undefined) {
      try {
        params = JSON.parse(rest[1]);
      } catch {
        throw new UsageError('call params must be valid JSON object');
      }
      if (params === null || typeof params !== 'object' || Array.isArray(params))
        throw new UsageError('call params must be a JSON object');
    }
    command = call(name, rest[0], params as Record<string, unknown>);
  } else if (name === 'record') {
    const [action, ...tail] = rest;
    if (action === 'start') {
      const parsed = options(
        tail,
        {
          '--source': 'sourceId',
          '--out': 'outputDir',
          '--name': 'fileName',
          '--mic-device': 'micDeviceId',
          '--camera-device': 'cameraDeviceId',
        },
        {
          '--system-audio': 'systemAudio',
          '--no-system-audio': '!systemAudio',
          '--mic': 'mic',
          '--no-mic': '!mic',
          '--camera': 'camera',
          '--no-camera': '!camera',
          '--remember-source': 'rememberSource',
        },
      );
      requireCount(parsed.positional, 0, 'record start [options]');
      if (typeof parsed.params.outputDir === 'string')
        parsed.params.outputDir = path.resolve(parsed.params.outputDir);
      command = call('start', 'recording.start', parsed.params);
    } else if (['stop', 'pause', 'resume', 'state'].includes(action)) {
      requireCount(tail, 0, `record ${action}`);
      command = call(action, `recording.${action}`);
    } else throw new UsageError('Expected record start|stop|pause|resume|state');
  } else if (name === 'sources') {
    requireCount(rest, 1, 'sources forget');
    if (rest[0] !== 'forget') throw new UsageError('Expected sources forget');
    command = call('forget', 'sources.forget');
  } else if (name === 'projects') {
    const [action, ...tail] = rest;
    if (action === 'list') {
      const parsed = options(tail, { '--dir': 'dir', '--limit': 'limit' }, {});
      requireCount(parsed.positional, 0, 'projects list [options]');
      if (typeof parsed.params.dir === 'string')
        parsed.params.dir = path.resolve(parsed.params.dir);
      if (typeof parsed.params.limit === 'string')
        parsed.params.limit = positiveInteger(parsed.params.limit, '--limit');
      command = call('list', 'projects.list', parsed.params);
    } else if (action === 'get' || action === 'open') {
      requireCount(tail, 1, `projects ${action} <dir>`);
      command = call(action, `projects.${action}`, { projectDir: path.resolve(tail[0]) });
    } else throw new UsageError('Expected projects list|get|open');
  } else if (name === 'export') {
    const [first, ...tail] = rest;
    if (!first)
      throw new UsageError(
        'Expected export <projectDir> or export progress|cancel|wait <exportId>',
      );
    if (['progress', 'cancel', 'wait'].includes(first)) {
      const parsed = options(tail, first === 'wait' ? { '--timeout-ms': 'timeoutMs' } : {}, {});
      requireCount(parsed.positional, 1, `export ${first} <exportId>`);
      if (typeof parsed.params.timeoutMs === 'string')
        parsed.params.timeoutMs = positiveInteger(parsed.params.timeoutMs, '--timeout-ms');
      command = call('export', `export.${first}`, {
        exportId: parsed.positional[0],
        ...parsed.params,
      });
    } else {
      const parsed = options(
        tail,
        { '--out': 'output', '--preset': 'preset', '--encoder': 'encoder' },
        { '--overwrite': 'overwrite', '--wait': 'wait' },
      );
      requireCount(parsed.positional, 0, 'export <projectDir> [options]');
      if (typeof parsed.params.output === 'string')
        parsed.params.output = path.resolve(parsed.params.output);
      if (
        parsed.params.encoder !== undefined &&
        !['auto', 'hardware', 'software'].includes(String(parsed.params.encoder))
      )
        throw new UsageError('--encoder must be auto, hardware, or software');
      command = call('export', 'export.start', {
        projectDir: path.resolve(first),
        ...parsed.params,
      });
    }
  } else if (name === 'settings') {
    const [action, ...tail] = rest;
    if (action === 'get') {
      if (tail.some((value) => value.startsWith('-')))
        throw new UsageError(`Unknown flag: ${tail.find((value) => value.startsWith('-'))}`);
      command = call('get', 'settings.get', tail.length ? { keys: tail } : {});
    } else if (action === 'set') {
      if (!tail.length) throw new UsageError('Expected settings set key=value [key=value...]');
      const values: Record<string, unknown> = {};
      for (const pair of tail) {
        const index = pair.indexOf('=');
        if (index <= 0) throw new UsageError(`Expected key=value, got ${pair}`);
        const key = pair.slice(0, index);
        const raw = pair.slice(index + 1);
        values[key] =
          raw === 'true'
            ? true
            : raw === 'false'
              ? false
              : raw === 'null'
                ? null
                : raw.trim() && Number.isFinite(Number(raw))
                  ? Number(raw)
                  : raw;
      }
      command = call('set', 'settings.set', { values });
    } else throw new UsageError('Expected settings get|set');
  } else if (name === 'events') {
    if (rest.some((value) => value.startsWith('-')))
      throw new UsageError(`Unknown flag: ${rest.find((value) => value.startsWith('-'))}`);
    command = { kind: 'events', events: rest };
  } else if (name === 'mcp') {
    requireCount(rest, 0, 'mcp');
    command = { kind: 'mcp' };
  } else throw new UsageError(`Unknown command: ${name}`);
  return { global, command, name };
}
