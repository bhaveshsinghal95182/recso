import { describe, expect, it } from 'vitest';

import { validate } from './schema.js';

describe('validate', () => {
  it('checks primitive types including finite numbers and integer values', () => {
    expect(validate({ type: 'number' }, NaN)).toEqual(['params must be a number']);
    expect(validate({ type: 'number' }, Infinity)).toEqual(['params must be a number']);
    expect(validate({ type: 'number' }, 2)).toEqual([]);
    expect(validate({ type: 'integer' }, 2.5)).toEqual(['params must be a integer']);
    expect(validate({ type: ['string', 'null'] }, false)).toEqual([
      'params must be one of string, null',
    ]);
    expect(validate({ type: 'object' }, [])).toEqual(['params must be a object']);
    expect(validate({ type: 'array' }, {})).toEqual(['params must be a array']);
    expect(validate({ type: 'boolean' }, 1)).toEqual(['params must be a boolean']);
  });

  it('reports missing and invalid nested properties at their paths', () => {
    const schema = {
      type: 'object' as const,
      required: ['output', 'items'],
      properties: {
        output: { type: 'string' as const },
        items: {
          type: 'array' as const,
          items: { properties: { id: { type: 'integer' as const } } },
        },
      },
    };
    expect(validate(schema, { output: undefined, items: [{ id: 1 }, { id: 'bad' }] })).toEqual([
      'params.output is required',
      'params.items[1].id must be a integer',
    ]);
    expect(validate(schema, null)).toEqual(['params must be a object']);
    expect(validate({ required: ['x'] }, 2)).toEqual([]);
  });

  it('checks additional properties even when no properties are declared', () => {
    expect(validate({ additionalProperties: false }, { extra: 1, absent: undefined })).toEqual([
      'params.extra is not allowed',
    ]);
    expect(validate({ additionalProperties: { type: 'string' } }, { extra: 1 })).toEqual([
      'params.extra must be a string',
    ]);
  });

  it('compares object enum and const values independent of key order', () => {
    expect(validate({ enum: [{ a: 1, b: [2, 3] }] }, { b: [2, 3], a: 1 })).toEqual([]);
    expect(validate({ const: { a: 1, b: 2 } }, { b: 2, a: 1 })).toEqual([]);
    expect(validate({ enum: [1], const: 1 }, 2)).toEqual([
      'params must be one of the allowed values',
      'params must be a specific value',
    ]);
  });

  it('accumulates bounds and pattern errors with type and nested errors', () => {
    expect(validate({ minimum: 3, maximum: 1 }, 2, 'value')).toEqual([
      'value must be >= 3',
      'value must be <= 1',
    ]);
    expect(validate({ minLength: 4, maxLength: 1, pattern: '^x' }, 'ab')).toEqual([
      'params must have length >= 4',
      'params must have length <= 1',
      'params must match pattern ^x',
    ]);
    expect(validate({ type: 'string', const: 2 }, 3)).toEqual([
      'params must be a string',
      'params must be a specific value',
    ]);
  });

  it('requires exactly one oneOf match and at least one anyOf match', () => {
    expect(validate({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 2)).toEqual([
      'params must match exactly one schema in oneOf',
    ]);
    expect(validate({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, false)).toEqual([
      'params must match exactly one schema in oneOf',
    ]);
    expect(validate({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, 2)).toEqual([]);
    expect(validate({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, false)).toEqual([
      'params must match at least one schema in anyOf',
    ]);
    expect(validate({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 2)).toEqual([]);
  });
});
