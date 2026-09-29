/**
 * The socket (or named pipe) door to the method registry.
 *
 * JSON-RPC 2.0, one message per line. Requests on one connection run
 * concurrently and answer in whatever order they finish -- ids pair them up --
 * so a long `export.wait` does not hold up a `recording.state` behind it.
 */

import fs from 'node:fs';
import net from 'node:net';

import {
  encodeMessage,
  ErrorCode,
  errorResponse,
  type JsonRpcNotification,
  type JsonRpcResponse,
  LineDecoder,
  notification,
  parseMessage,
} from './protocol.js';
import type { ConnectionHandle, MethodRegistry } from './registry.js';
import { prepareSocketDir, removeStaleSocket, type Transport } from './transport.js';

export interface AutomationServerOptions {
  registry: MethodRegistry;
  transport: Transport;
  /** The current user's uid, for the socket directory's owner check. Unused on Windows. */
  uid?: number;
  log?: (message: string) => void;
  /** Called whenever a client connects or leaves, with how many remain. */
  onConnectionCountChange?: (count: number) => void;
}

class Connection implements ConnectionHandle {
  private subscription: Set<string> | '*' | null = null;

  constructor(
    readonly id: number,
    private readonly socket: net.Socket,
  ) {}

  subscribe(events: readonly string[] | '*'): void {
    this.subscription = events === '*' ? '*' : new Set(events);
  }

  unsubscribe(): void {
    this.subscription = null;
  }

  wants(event: string): boolean {
    return this.subscription === '*' || (this.subscription?.has(event) ?? false);
  }

  send(message: JsonRpcResponse | JsonRpcNotification): void {
    if (!this.socket.destroyed && this.socket.writable) {
      this.socket.write(encodeMessage(message));
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

export class AutomationServer {
  private server: net.Server | null = null;
  private readonly connections = new Set<Connection>();
  private nextConnectionId = 1;

  constructor(private readonly options: AutomationServerOptions) {}

  get connectionCount(): number {
    return this.connections.size;
  }

  get path(): string {
    return this.options.transport.path;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const { transport } = this.options;
    if (transport.kind === 'unix') {
      prepareSocketDir(transport.dir, this.options.uid ?? process.getuid?.() ?? -1);
      await removeStaleSocket(transport.path);
    }

    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(transport.path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (error) => this.log(`server error: ${error.message}`));

    if (transport.kind === 'unix') {
      // The directory is 0700 already; this keeps the socket private even if
      // someone later loosens the directory.
      fs.chmodSync(transport.path, 0o600);
    }

    this.server = server;
    this.log(`listening on ${transport.path}`);
  }

  /** Close every connection and the listener, and remove the socket file. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;

    for (const connection of this.connections) {
      connection.close();
    }
    this.connections.clear();
    this.options.onConnectionCountChange?.(0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    // `close` unlinks a Unix socket itself; this is for the odd case where it
    // could not, so a stale file never outlives the API being turned off.
    if (this.options.transport.kind === 'unix') {
      fs.rmSync(this.options.transport.path, { force: true });
    }
    this.log('stopped');
  }

  /** Send an event to every connection subscribed to it. */
  broadcast(event: string, payload: unknown): void {
    const message = notification(event, payload);
    for (const connection of this.connections) {
      if (connection.wants(event)) {
        connection.send(message);
      }
    }
  }

  private accept(socket: net.Socket): void {
    const connection = new Connection(this.nextConnectionId++, socket);
    this.connections.add(connection);
    this.options.onConnectionCountChange?.(this.connections.size);

    const decoder = new LineDecoder();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      const { lines, overflow } = decoder.push(chunk);
      if (overflow) {
        connection.send(
          errorResponse(null, ErrorCode.InvalidRequest, 'message too long', 'message_too_long'),
        );
      }
      for (const line of lines) {
        void this.handleLine(connection, line);
      }
    });

    const forget = () => {
      if (this.connections.delete(connection)) {
        this.options.onConnectionCountChange?.(this.connections.size);
      }
    };
    socket.on('close', forget);
    // A client vanishing mid-write is ordinary; the close handler cleans up.
    socket.on('error', () => undefined);
  }

  private async handleLine(connection: Connection, line: string): Promise<void> {
    const parsed = parseMessage(line);
    if (parsed.kind === 'invalid') {
      connection.send(parsed.response);
      return;
    }

    const request = parsed.kind === 'request' ? parsed.request : parsed.notification;
    const response = await this.options.registry.call(
      parsed.kind === 'request' ? parsed.request.id : null,
      request.method,
      request.params,
      { connection },
    );
    if (parsed.kind === 'request') {
      connection.send(response);
    }
  }

  private log(message: string): void {
    this.options.log?.(`[Automation] ${message}`);
  }
}
