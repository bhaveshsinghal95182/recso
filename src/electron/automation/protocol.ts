import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';

/** JSON-RPC permits null IDs so malformed calls can still receive a response. */
export type JsonRpcId = string | number | null;

/** Handlers receive the same shape for calls and notifications, distinguished by ID presence. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/** Successful calls preserve their ID for clients with concurrent requests. */
export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

/** A stable reason lets clients branch without matching free-text messages. */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: { reason: string; [key: string]: unknown };
}

/** Failed calls preserve their ID when the incoming ID was valid. */
export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

/** Call responses have exactly one of result and error. */
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Notifications deliberately have no ID and receive no response. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** Standard JSON-RPC codes and one reserved application error code. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  AppError: -32000,
} as const;

/** Handler failures carry a stable reason while retaining a useful human message. */
export class AutomationError extends Error {
  readonly code: number;
  readonly reason: string;
  readonly details?: Record<string, unknown>;

  constructor(
    reason: string,
    message: string,
    options?: { code?: number; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AutomationError';
    this.code = options?.code ?? ErrorCode.AppError;
    this.reason = reason;
    this.details = options?.details;
  }
}

/** Byte limits protect long-lived stdio and socket streams from unbounded lines. */
export class LineDecoder {
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private discarding = false;
  private readonly maxLineBytes: number;

  constructor(options?: { maxLineBytes?: number }) {
    this.maxLineBytes = options?.maxLineBytes ?? 1024 * 1024;
  }

  push(chunk: Buffer | string): { lines: string[]; overflow: boolean } {
    return this.consume(this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }

  end(): { lines: string[]; overflow: boolean } {
    const result = this.consume(this.decoder.end());
    const line = this.partial.replace(/\r$/, '');
    if (!this.discarding && line.trim()) {
      result.lines.push(line);
    }
    this.partial = '';
    this.discarding = false;
    this.decoder = new StringDecoder('utf8');
    return result;
  }

  private consume(text: string): { lines: string[]; overflow: boolean } {
    const lines: string[] = [];
    let overflow = false;
    const segments = text.split('\n');
    for (let index = 0; index < segments.length; index += 1) {
      if (!this.discarding) {
        this.partial += segments[index];
        if (Buffer.byteLength(this.partial, 'utf8') > this.maxLineBytes) {
          this.partial = '';
          this.discarding = true;
          overflow = true;
        }
      }
      if (index < segments.length - 1) {
        if (!this.discarding) {
          const line = this.partial.replace(/\r$/, '');
          if (line.trim()) {
            lines.push(line);
          }
        }
        this.partial = '';
        this.discarding = false;
      }
    }
    return { lines, overflow };
  }
}

/** Parsing keeps invalid requests separate from notifications, which cannot be answered. */
export type ParsedMessage =
  | { kind: 'request'; request: JsonRpcRequest & { id: JsonRpcId } }
  | { kind: 'notification'; notification: JsonRpcRequest }
  | { kind: 'invalid'; response: JsonRpcFailure };

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject batches and malformed envelopes before a method handler sees input. */
export function parseMessage(line: string): ParsedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      kind: 'invalid',
      response: errorResponse(null, ErrorCode.ParseError, 'Invalid JSON', 'parse_error'),
    };
  }
  if (Array.isArray(parsed)) {
    return {
      kind: 'invalid',
      response: errorResponse(
        null,
        ErrorCode.InvalidRequest,
        'Batches are not supported',
        'batch_not_supported',
      ),
    };
  }
  const id = objectValue(parsed) && validId(parsed.id) ? parsed.id : null;
  if (
    !objectValue(parsed) ||
    parsed.jsonrpc !== '2.0' ||
    typeof parsed.method !== 'string' ||
    (Object.hasOwn(parsed, 'id') && !validId(parsed.id)) ||
    (Object.hasOwn(parsed, 'params') &&
      !objectValue(parsed.params) &&
      !Array.isArray(parsed.params))
  ) {
    return {
      kind: 'invalid',
      response: errorResponse(id, ErrorCode.InvalidRequest, 'Invalid request', 'invalid_request'),
    };
  }
  const request: JsonRpcRequest = { jsonrpc: '2.0', method: parsed.method };
  if (Object.hasOwn(parsed, 'params')) {
    request.params = parsed.params;
  }
  if (Object.hasOwn(parsed, 'id')) {
    return { kind: 'request', request: { ...request, id: parsed.id as JsonRpcId } };
  }
  return { kind: 'notification', notification: request };
}

/** Keep response construction uniform across handlers. */
export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

/** Place application details alongside a reason that callers can rely on. */
export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  reason: string,
  details?: Record<string, unknown>,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, data: { ...details, reason } } };
}

/** Unexpected throws use the standard internal error code and a stable reason. */
export function toErrorResponse(id: JsonRpcId, error: unknown): JsonRpcFailure {
  if (error instanceof AutomationError) {
    return errorResponse(id, error.code, error.message, error.reason, error.details);
  }
  return errorResponse(
    id,
    ErrorCode.InternalError,
    error instanceof Error ? error.message : 'Internal error',
    'internal_error',
  );
}

/** Outbound events omit an ID so clients never expect a reply. */
export function notification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
}

/** One JSON object per line lets both stdio and sockets use the same framing. */
export function encodeMessage(
  message: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest,
): string {
  return `${JSON.stringify(message)}\n`;
}
