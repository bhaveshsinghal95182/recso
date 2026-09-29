/** Coordinate one CLI request while keeping socket lifetime and exit codes in one place. */

import { AutomationCallError, AutomationClient } from '../client.js';
import { API_VERSION } from '../registry.js';
import { transportPath } from '../transport.js';
import { parseCliArgs, USAGE, UsageError } from './args.js';
import { formatHuman } from './format.js';
import { waitForSocket } from './launch.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  username: string;
  tmpdir: string;
  execPath: string;
  cliPath: string;
  exists: (p: string) => boolean;
  launch?: () => boolean;
  runMcp?: (socketPath: string) => Promise<number>;
  interrupted?: Promise<void>;
}

function reportCallError(error: AutomationCallError, json: boolean, io: CliIo): number {
  if (json)
    io.stdout(
      JSON.stringify({
        error: {
          reason: error.reason,
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      }) + '\n',
    );
  else io.stderr(`Error (${error.reason}): ${error.message}\n`);
  return error.reason === 'disconnected' ? 3 : 1;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\nRun recso-cli --help for usage.\n`);
      return 2;
    }
    throw error;
  }
  if (parsed.global.version) {
    io.stdout(`recso-cli (API ${API_VERSION})\n`);
    return 0;
  }
  if (parsed.global.help || parsed.command.kind === 'help') {
    io.stdout(USAGE + '\n');
    return 0;
  }

  const socketPath =
    parsed.global.socket ??
    transportPath(io.platform, { env: io.env, username: io.username, tmpdir: io.tmpdir }).path;
  if (parsed.command.kind === 'mcp') {
    if (!io.runMcp) {
      io.stderr('the MCP server is not built into this recso-cli yet\n');
      return 1;
    }
    return io.runMcp(socketPath);
  }

  let client: AutomationClient | undefined;
  try {
    try {
      client = await AutomationClient.connect(socketPath);
    } catch (error) {
      if (!(error instanceof AutomationCallError) || error.reason !== 'not_running') throw error;
      if (!parsed.global.launch) {
        io.stderr(
          'recso is not running, or its Automation API is off.\nTurn it on in recso: Settings ▸ Advanced ▸ Automation API (or start recso with RECSO_AUTOMATION=1).\nPass --launch to start recso first.\n',
        );
        return 3;
      }
      if (!io.launch?.()) {
        io.stderr('Could not find recso to launch; set RECSO_APP to its executable.\n');
        return 3;
      }
      if (
        !(await waitForSocket(() => AutomationClient.connect(socketPath), parsed.global.timeoutMs))
      ) {
        io.stderr(
          `recso started but its Automation API did not come up within ${parsed.global.timeoutMs / 1000}s. Is it turned on in Settings ▸ Advanced ▸ Automation API?\n`,
        );
        return 3;
      }
      client = await AutomationClient.connect(socketPath);
    }

    if (parsed.command.kind === 'call') {
      try {
        const result = await client.call(parsed.command.method, parsed.command.params);
        io.stdout(
          (parsed.global.json || parsed.name === 'call'
            ? JSON.stringify(result, null, 2)
            : formatHuman(parsed.name, result)) + '\n',
        );
        return 0;
      } catch (error) {
        if (error instanceof AutomationCallError)
          return reportCallError(error, parsed.global.json, io);
        throw error;
      }
    }
    try {
      await client.call(
        'events.subscribe',
        parsed.command.events.length ? { events: parsed.command.events } : {},
      );
      client.onNotification((message) =>
        io.stdout(JSON.stringify({ event: message.method, data: message.params }) + '\n'),
      );
      return await Promise.race([
        client.closedPromise().then(() => 3),
        ...(io.interrupted ? [io.interrupted.then(() => 0)] : []),
      ]);
    } catch (error) {
      if (error instanceof AutomationCallError)
        return reportCallError(error, parsed.global.json, io);
      throw error;
    }
  } catch (error) {
    if (error instanceof AutomationCallError) return reportCallError(error, parsed.global.json, io);
    throw error;
  } finally {
    client?.close();
  }
}
