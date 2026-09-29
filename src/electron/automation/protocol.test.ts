import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  AutomationError,
  encodeMessage,
  ErrorCode,
  errorResponse,
  LineDecoder,
  notification,
  parseMessage,
  successResponse,
  toErrorResponse,
} from './protocol.js';

describe('ErrorCode', () => {
  it('exposes standard JSON-RPC codes and the application code', () => {
    expect(ErrorCode).toEqual({
      ParseError: -32700,
      InvalidRequest: -32600,
      MethodNotFound: -32601,
      InvalidParams: -32602,
      InternalError: -32603,
      AppError: -32000,
    });
  });
});

describe('AutomationError', () => {
  it('defaults to the application code and preserves explicit details', () => {
    expect(new AutomationError('missing_recording', 'Missing recording')).toMatchObject({
      code: ErrorCode.AppError,
      reason: 'missing_recording',
      message: 'Missing recording',
    });
    expect(
      new AutomationError('bad_input', 'Bad input', { code: -32602, details: { field: 'id' } }),
    ).toMatchObject({
      code: -32602,
      details: { field: 'id' },
    });
  });
});

describe('LineDecoder', () => {
  it('emits multiple complete lines while retaining an unfinished line', () => {
    const decoder = new LineDecoder();
    expect(decoder.push('one\r\n \n two\npar')).toEqual({
      lines: ['one', ' two'],
      overflow: false,
    });
    expect(decoder.push('tial\n')).toEqual({ lines: ['partial'], overflow: false });
    expect(decoder.end()).toEqual({ lines: [], overflow: false });
  });

  it('reassembles a UTF-8 character split between Buffer chunks', () => {
    const decoder = new LineDecoder();
    const bytes = Buffer.from('café\n');
    expect(decoder.push(bytes.subarray(0, 4))).toEqual({ lines: [], overflow: false });
    expect(decoder.push(bytes.subarray(4))).toEqual({ lines: ['café'], overflow: false });
  });

  it('drops oversized lines and resumes after their newline', () => {
    const decoder = new LineDecoder({ maxLineBytes: 4 });
    expect(decoder.push('éé')).toEqual({ lines: [], overflow: false });
    expect(decoder.push('x')).toEqual({ lines: [], overflow: true });
    expect(decoder.push('ignored\nok\n12345\nyes\n')).toEqual({
      lines: ['ok', 'yes'],
      overflow: true,
    });
    expect(decoder.end()).toEqual({ lines: [], overflow: false });
  });

  it('flushes a final unterminated line and resets for reuse', () => {
    const decoder = new LineDecoder();
    decoder.push('last\r');
    expect(decoder.end()).toEqual({ lines: ['last'], overflow: false });
    expect(decoder.end()).toEqual({ lines: [], overflow: false });
    expect(decoder.push('next\n')).toEqual({ lines: ['next'], overflow: false });
  });
});

describe('parseMessage', () => {
  it('distinguishes a request with a null ID from a notification', () => {
    expect(parseMessage('{"jsonrpc":"2.0","method":"ping","id":null}')).toEqual({
      kind: 'request',
      request: { jsonrpc: '2.0', method: 'ping', id: null },
    });
    expect(parseMessage('{"jsonrpc":"2.0","method":"ping","params":[]}')).toEqual({
      kind: 'notification',
      notification: { jsonrpc: '2.0', method: 'ping', params: [] },
    });
  });

  it('reports invalid JSON and unsupported batches with distinct reasons', () => {
    expect(parseMessage('{')).toMatchObject({
      kind: 'invalid',
      response: {
        id: null,
        error: { code: ErrorCode.ParseError, data: { reason: 'parse_error' } },
      },
    });
    expect(parseMessage('[]')).toMatchObject({
      kind: 'invalid',
      response: {
        id: null,
        error: { code: ErrorCode.InvalidRequest, data: { reason: 'batch_not_supported' } },
      },
    });
  });

  it('retains a valid ID on malformed envelopes and rejects invalid fields', () => {
    for (const input of [
      '{"id":2,"method":"ping"}',
      '{"id":2,"jsonrpc":"2.0","method":3}',
      '{"id":2,"jsonrpc":"2.0","method":"ping","params":null}',
    ]) {
      expect(parseMessage(input)).toMatchObject({
        kind: 'invalid',
        response: { id: 2, error: { data: { reason: 'invalid_request' } } },
      });
    }
    for (const input of ['null', '3', '{"id":{},"jsonrpc":"2.0","method":"ping"}']) {
      expect(parseMessage(input)).toMatchObject({ kind: 'invalid', response: { id: null } });
    }
  });
});

describe('successResponse', () => {
  it('wraps the result with its request ID', () => {
    expect(successResponse('a', { ok: true })).toEqual({
      jsonrpc: '2.0',
      id: 'a',
      result: { ok: true },
    });
  });
});

describe('errorResponse', () => {
  it('keeps the stable reason when details contain a reason key', () => {
    expect(errorResponse(1, -32000, 'Oops', 'known', { reason: 'overridden', field: 'x' })).toEqual(
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Oops', data: { reason: 'known', field: 'x' } },
      },
    );
  });
});

describe('toErrorResponse', () => {
  it('preserves intentional errors and converts unexpected throws', () => {
    expect(
      toErrorResponse(1, new AutomationError('gone', 'Gone', { details: { id: 3 } })),
    ).toMatchObject({
      error: { code: ErrorCode.AppError, message: 'Gone', data: { reason: 'gone', id: 3 } },
    });
    expect(toErrorResponse(2, new Error('Boom'))).toMatchObject({
      error: { code: ErrorCode.InternalError, message: 'Boom', data: { reason: 'internal_error' } },
    });
    expect(toErrorResponse(3, 'oops')).toMatchObject({ error: { message: 'Internal error' } });
  });
});

describe('notification', () => {
  it('omits absent params and never includes an ID', () => {
    expect(notification('ready')).toEqual({ jsonrpc: '2.0', method: 'ready' });
    expect(notification('ready', { count: 1 })).toEqual({
      jsonrpc: '2.0',
      method: 'ready',
      params: { count: 1 },
    });
  });
});

describe('encodeMessage', () => {
  it('adds one framing newline while escaping newlines inside JSON', () => {
    const encoded = encodeMessage(notification('status', { text: 'a\nb' }));
    expect(encoded).toBe('{"jsonrpc":"2.0","method":"status","params":{"text":"a\\nb"}}\n');
    expect(encoded.split('\n')).toHaveLength(2);
  });
});
