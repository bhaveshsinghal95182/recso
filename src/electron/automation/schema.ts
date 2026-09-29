/** The supported primitive names keep handler parameter schemas small and portable. */
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** Handler schemas use only the keywords needed to check automation parameters. */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  title?: string;
  default?: unknown;
  examples?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(type: JsonType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => equalJson(item, right[index]))
    );
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
    );
  }
  return false;
}

/** Flat, located errors let callers report every parameter problem in one reply. */
export function validate(schema: JsonSchema, value: unknown, path = 'params'): string[] {
  const problems: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      problems.push(
        Array.isArray(schema.type)
          ? `${path} must be one of ${types.join(', ')}`
          : `${path} must be a ${schema.type}`,
      );
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((entry) => equalJson(entry, value))) {
    problems.push(`${path} must be one of the allowed values`);
  }
  if ('const' in schema && !equalJson(schema.const, value)) {
    problems.push(`${path} must be a specific value`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path} must be <= ${schema.maximum}`);
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path} must have length >= ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${path} must have length <= ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${path} must match pattern ${schema.pattern}`);
    }
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        problems.push(`${path}.${key} is required`);
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        continue;
      }
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        problems.push(...validate(schema.properties[key], entry, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}.${key} is not allowed`);
      } else if (schema.additionalProperties && schema.additionalProperties !== true) {
        problems.push(...validate(schema.additionalProperties, entry, `${path}.${key}`));
      }
    }
  }
  const items = schema.items;
  if (Array.isArray(value) && items !== undefined) {
    value.forEach((item, index) => {
      problems.push(...validate(items, item, `${path}[${index}]`));
    });
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(
      (branch) => validate(branch, value, path).length === 0,
    ).length;
    if (matches !== 1) {
      problems.push(`${path} must match exactly one schema in oneOf`);
    }
  }
  if (
    schema.anyOf !== undefined &&
    !schema.anyOf.some((branch) => validate(branch, value, path).length === 0)
  ) {
    problems.push(`${path} must match at least one schema in anyOf`);
  }
  return problems;
}
