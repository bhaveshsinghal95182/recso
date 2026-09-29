/**
 * The Automation API's one list of methods.
 *
 * Every door -- the socket, the CLI, MCP -- and `api.describe` and the docs
 * read their methods from here, so a method exists in all of them or none.
 * Handlers call the same services the IPC handlers call; this file only
 * validates and routes.
 */

import {
  AutomationError,
  ErrorCode,
  type JsonRpcId,
  type JsonRpcResponse,
  successResponse,
  toErrorResponse,
} from './protocol.js';
import { type JsonSchema, validate } from './schema.js';

/** The major.minor contract version. See "Versioned contract" in docs/automation-api.md. */
export const API_VERSION = '1.0';

/** What a handler can do to the connection that called it. */
export interface ConnectionHandle {
  readonly id: number;
  /** Start sending these events (all of them for `'*'`) as notifications. */
  subscribe(events: readonly string[] | '*'): void;
  unsubscribe(): void;
}

export interface MethodContext {
  /** Absent when a method is called from inside recso, not over a connection. */
  connection?: ConnectionHandle;
}

/** Per-platform notes, shown by `api.describe` when a method behaves differently there. */
export type PlatformNotes = Partial<Record<'linux' | 'win32' | 'darwin', string>>;

export interface MethodDefinition<Params = Record<string, unknown>, Result = unknown> {
  /** Dotted and stable: `recording.start`. */
  name: string;
  description: string;
  params: JsonSchema & { type: 'object' };
  result: JsonSchema;
  platforms?: PlatformNotes;
  handler: (params: Params, context: MethodContext) => Result | Promise<Result>;
}

export interface EventDefinition {
  name: string;
  description: string;
  payload: JsonSchema;
}

export interface MethodDescription {
  name: string;
  description: string;
  params: JsonSchema;
  result: JsonSchema;
  platforms?: PlatformNotes;
}

export class MethodRegistry {
  private readonly methods = new Map<string, MethodDefinition>();
  private readonly events = new Map<string, EventDefinition>();

  register<Params, Result>(definition: MethodDefinition<Params, Result>): this {
    if (this.methods.has(definition.name)) {
      throw new Error(`method ${definition.name} is registered twice`);
    }
    this.methods.set(definition.name, definition as unknown as MethodDefinition);
    return this;
  }

  registerEvent(definition: EventDefinition): this {
    if (this.events.has(definition.name)) {
      throw new Error(`event ${definition.name} is registered twice`);
    }
    this.events.set(definition.name, definition);
    return this;
  }

  has(name: string): boolean {
    return this.methods.has(name);
  }

  describeMethods(): MethodDescription[] {
    return [...this.methods.values()].map(({ name, description, params, result, platforms }) => ({
      name,
      description,
      params,
      result,
      ...(platforms ? { platforms } : {}),
    }));
  }

  describeEvents(): EventDefinition[] {
    return [...this.events.values()];
  }

  eventNames(): string[] {
    return [...this.events.keys()];
  }

  /**
   * Run one method and describe the outcome as a JSON-RPC response.
   *
   * Never throws: a handler's failure becomes an error response, so one bad
   * call cannot take the connection (or recso) down with it.
   */
  async call(
    id: JsonRpcId,
    method: string,
    params: unknown,
    context: MethodContext = {},
  ): Promise<JsonRpcResponse> {
    const definition = this.methods.get(method);
    if (!definition) {
      return toErrorResponse(
        id,
        new AutomationError('method_not_found', `unknown method ${method}; see api.describe`, {
          code: ErrorCode.MethodNotFound,
        }),
      );
    }

    // By-position params are part of JSON-RPC, but every method here takes
    // named ones; saying so beats a confusing schema message.
    if (Array.isArray(params)) {
      return toErrorResponse(
        id,
        new AutomationError('invalid_params', `${method} takes named params (an object)`, {
          code: ErrorCode.InvalidParams,
        }),
      );
    }

    const input = params ?? {};
    const problems = validate(definition.params, input);
    if (problems.length > 0) {
      return toErrorResponse(
        id,
        new AutomationError('invalid_params', `${method}: ${problems.join('; ')}`, {
          code: ErrorCode.InvalidParams,
          details: { problems },
        }),
      );
    }

    try {
      const result = await definition.handler(input as Record<string, unknown>, context);
      return successResponse(id, result ?? null);
    } catch (error) {
      return toErrorResponse(id, error);
    }
  }
}
