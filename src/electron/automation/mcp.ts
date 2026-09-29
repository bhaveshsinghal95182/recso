/**
 * Expose the Automation API as MCP tools over stdio for the portable CLI.
 * Plain Node: the CLI loads this module without loading Electron.
 */

import { AutomationCallError, AutomationClient } from './client.js';
import { LineDecoder } from './protocol.js';
import { API_VERSION, type MethodDescription } from './registry.js';

export interface McpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (message: string) => void;
  launch?: () => boolean;
  connect?: (socketPath: string) => Promise<McpClient>;
  launchTimeoutMs?: number;
}

export interface McpClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
  closedPromise(): Promise<void>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export const LAUNCH_TOOL: McpTool = {
  name: 'recso_launch',
  description:
    'Start recso (window hidden) if it is not running and wait until its Automation API answers. Works only when the Automation API is turned on in recso (Settings ▸ Advanced ▸ Automation API).',
  inputSchema: { type: 'object', properties: {} },
};

const UNREACHABLE =
  'recso is not running, or its Automation API is off. Call recso_launch, or turn it on in recso: Settings ▸ Advanced ▸ Automation API.';

const INSTRUCTIONS =
  'recso is a screen recorder. Call app_status first. All paths are absolute. Record with recording_start then recording_stop, which returns the project. Export with export_start using wait: true, or call export_wait, and read the output path from the result. If recso_* tools are missing, recso is not running or its Automation API is off; call recso_launch.';

export function toolName(method: string): string {
  const name = method.replaceAll('.', '_');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid MCP tool name: ${name}`);
  return name;
}

export function toolsFromDescribe(methods: MethodDescription[]): McpTool[] {
  return methods
    .filter(({ name }) => name !== 'events.subscribe' && name !== 'events.unsubscribe')
    .map((method) => {
      let description = method.description;
      for (const [key, label] of [
        ['linux', 'Linux'],
        ['win32', 'Windows'],
        ['darwin', 'macOS'],
      ] as const) {
        const note = method.platforms?.[key];
        if (note !== undefined) description += `\n\nOn ${label}: ${note}`;
      }
      const schema = method.params;
      const objectSchema =
        schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'));
      return {
        name: toolName(method.name),
        description,
        inputSchema: objectSchema
          ? { ...schema, type: 'object', properties: schema.properties ?? {} }
          : { type: 'object', properties: {} },
      };
    });
}

type RpcId = string | number | null;
type RpcRequest = { id: RpcId; method: string; params?: unknown };

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResult(text: string, isError = false): Record<string, unknown> {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] };
}

/** Serve MCP on stdio until input ends; resolves with the exit code (0). */
export function runMcpServer(socketPath: string, options: McpServerOptions = {}): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const connect = options.connect ?? AutomationClient.connect;
  const decoder = new LineDecoder({ maxLineBytes: 64 * 1024 * 1024 });
  const active = new Set<Promise<void>>();
  const methods = new Map<string, string>();
  let client: McpClient | undefined;
  let connecting: Promise<McpClient | undefined> | undefined;
  let shortList = false;
  let ending = false;

  const write = (message: Record<string, unknown>): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const success = (id: RpcId, result: unknown): void => write({ jsonrpc: '2.0', id, result });
  const error = (id: RpcId, code: number, message: string): void =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  /** Share a pending connection attempt as well as an established connection. */
  const getClient = async (): Promise<McpClient | undefined> => {
    if (client) return client;
    if (!connecting) {
      connecting = Promise.resolve()
        .then(() => connect(socketPath))
        .then((connected) => {
          if (ending) {
            connected.close();
            return undefined;
          }
          client = connected;
          void connected.closedPromise().then(
            () => {
              if (client === connected) client = undefined;
            },
            () => {
              if (client === connected) client = undefined;
            },
          );
          return connected;
        })
        .catch(() => undefined)
        .finally(() => {
          connecting = undefined;
        });
    }
    return connecting;
  };

  const describe = async (connected: McpClient): Promise<McpTool[]> => {
    const result = await connected.call<{ methods: MethodDescription[] }>('api.describe');
    const tools = toolsFromDescribe(result.methods);
    methods.clear();
    for (const method of result.methods) {
      if (method.name !== 'events.subscribe' && method.name !== 'events.unsubscribe') {
        methods.set(toolName(method.name), method.name);
      }
    }
    return tools;
  };

  const launch = async (id: RpcId): Promise<void> => {
    if (await getClient()) {
      success(id, toolResult('recso is already running'));
      return;
    }
    let started = false;
    try {
      started = options.launch?.() ?? false;
    } catch (cause) {
      log(`Could not launch recso: ${String(cause)}`);
    }
    if (!started) {
      success(
        id,
        toolResult('Could not find recso to launch; set RECSO_APP to its executable.', true),
      );
      return;
    }
    const timeout = options.launchTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    while (true) {
      if (await getClient()) {
        success(id, toolResult('recso is running'));
        if (shortList) {
          write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          shortList = false;
        }
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
    success(
      id,
      toolResult(
        `recso started but its Automation API did not answer within ${timeout / 1000}s; turn it on in recso: Settings ▸ Advanced ▸ Automation API.`,
        true,
      ),
    );
  };

  const handle = async ({ id, method, params }: RpcRequest): Promise<void> => {
    if (method.startsWith('notifications/')) return;
    if (method === 'initialize') {
      const requested = objectValue(params) ? params.protocolVersion : undefined;
      success(id, {
        protocolVersion:
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'recso', version: API_VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    if (method === 'ping') {
      success(id, {});
      return;
    }
    if (method === 'tools/list') {
      const connected = await getClient();
      if (connected) {
        try {
          success(id, { tools: [...(await describe(connected)), LAUNCH_TOOL] });
          shortList = false;
          return;
        } catch (cause) {
          log(`Could not describe recso tools: ${String(cause)}`);
        }
      }
      shortList = options.launch !== undefined;
      success(id, { tools: shortList ? [LAUNCH_TOOL] : [] });
      return;
    }
    if (method === 'tools/call') {
      const args = objectValue(params) ? params : {};
      const name = args.name;
      if (name === 'recso_launch') {
        await launch(id);
        return;
      }
      const connected = await getClient();
      if (!connected) {
        success(id, toolResult(UNREACHABLE, true));
        return;
      }
      if (typeof name !== 'string' || !methods.has(name)) {
        try {
          await describe(connected);
        } catch {
          success(id, toolResult(UNREACHABLE, true));
          return;
        }
      }
      const automationMethod = typeof name === 'string' ? methods.get(name) : undefined;
      if (!automationMethod) {
        error(id, -32602, `Unknown tool: ${String(name)}`);
        return;
      }
      try {
        const result = await connected.call(
          automationMethod,
          objectValue(args.arguments) ? args.arguments : {},
        );
        const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
        success(id, objectValue(result) ? { content, structuredContent: result } : { content });
      } catch (cause) {
        if (cause instanceof AutomationCallError) {
          const details =
            cause.details && Object.keys(cause.details).length > 0
              ? `\n${JSON.stringify(cause.details)}`
              : '';
          success(id, toolResult(`${cause.reason}: ${cause.message}${details}`, true));
        } else {
          success(id, toolResult(UNREACHABLE, true));
        }
      }
      return;
    }
    error(id, -32601, 'Method not found');
  };

  /** Start a handler without blocking later lines, but retain it for EOF cleanup. */
  const receive = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      error(null, -32700, 'Parse error');
      return;
    }
    if (!objectValue(message) || !Object.hasOwn(message, 'id')) return;
    const id = message.id as RpcId;
    const task = Promise.resolve()
      .then(() => handle({ id, method: String(message.method), params: message.params }))
      .catch((cause) => {
        log(`MCP request failed: ${String(cause)}`);
        error(id, -32603, 'Internal error');
      });
    active.add(task);
    void task.finally(() => active.delete(task));
  };

  return new Promise<number>((resolve) => {
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk).lines) receive(line);
    });
    input.once('end', () => {
      for (const line of decoder.end().lines) receive(line);
      ending = true;
      client?.close();
      const timeout = setTimeout(() => resolve(0), 2000);
      void Promise.allSettled([...active]).then(() => {
        clearTimeout(timeout);
        resolve(0);
      });
    });
  });
}
