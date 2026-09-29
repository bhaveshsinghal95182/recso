/**
 * A client for the Automation API socket, for recso-cli and its MCP server.
 *
 * Plain Node: the CLI runs under `ELECTRON_RUN_AS_NODE`, or any Node, and must
 * not load Electron.
 */

import net from 'node:net';

import {
  encodeMessage,
  type JsonRpcErrorObject,
  type JsonRpcNotification,
  type JsonRpcResponse,
  LineDecoder,
} from './protocol.js';

/** A method's error response, or a failure to reach recso at all (`reason: 'not_running'`). */
export class AutomationCallError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly code: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static from(error: JsonRpcErrorObject): AutomationCallError {
    const { reason = 'error', ...details } = error.data ?? {};
    return new AutomationCallError(error.message, String(reason), error.code, details);
  }
}

export class AutomationClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(message: JsonRpcNotification) => void>();
  private closed = false;

  private constructor(private readonly socket: net.Socket) {
    const decoder = new LineDecoder({ maxLineBytes: 64 * 1024 * 1024 });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk).lines) {
        this.receive(line);
      }
    });
    socket.on('close', () =>
      this.fail(new AutomationCallError('recso closed the connection', 'disconnected', -1)),
    );
    socket.on('error', () => undefined);
  }

  /** Connect, or reject with `reason: 'not_running'` when nothing listens there. */
  static connect(path: string, timeoutMs = 2000): Promise<AutomationClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AutomationCallError(`no answer on ${path}`, 'not_running', -1));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new AutomationClient(socket));
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new AutomationCallError(
            `recso is not running, or its Automation API is off (${error.code ?? error.message} on ${path})`,
            'not_running',
            -1,
          ),
        );
      });
    });
  }

  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AutomationCallError('connection is closed', 'disconnected', -1));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.write(encodeMessage({ jsonrpc: '2.0', id, method, params: params ?? {} }));
    });
  }

  onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }

  /** Resolves when recso closes the connection (for `events`, which runs until then). */
  closedPromise(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) resolve();
      else this.socket.once('close', () => resolve());
    });
  }

  private receive(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if ('method' in message) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    if (typeof message.id !== 'number') {
      // An error the server could not tie to a request (a line too long, say).
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if ('error' in message) waiter.reject(AutomationCallError.from(message.error));
    else waiter.resolve(message.result);
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
