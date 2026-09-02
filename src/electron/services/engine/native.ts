/**
 * Loads the engine half of the velocity addon.
 *
 * velocity lives outside node_modules, so there is no resolvable specifier for
 * it. Same candidate walk the cursor bindings use: cwd in dev, resourcesPath
 * when packaged. The main bundle is ESM and napi's index.js is CJS, hence
 * createRequire.
 *
 * The engine is optional. A machine without the bindings, or a build where the
 * Rust was never compiled, must still run recso -- the editor's existing
 * <video> + Pixi path does not depend on any of this. So a failure here is
 * recorded and reported, never thrown at startup.
 */

import { createRequire } from 'node:module';

import { app } from 'electron';

import fs from 'fs';
import path from 'path';

import type { EngineBindings } from '../../types/engine.types.js';

const require = createRequire(import.meta.url);

let bindings: EngineBindings | null | undefined;
let loadError: string | null = null;

function candidatePaths(): string[] {
  return [
    path.resolve(process.cwd(), 'velocity', 'index.js'),
    path.resolve(app.getAppPath(), 'velocity', 'index.js'),
    path.resolve(app.getAppPath(), '..', 'velocity', 'index.js'),
    path.resolve(process.resourcesPath, 'velocity', 'index.js'),
    path.resolve(process.resourcesPath, 'app.asar.unpacked', 'velocity', 'index.js'),
  ];
}

/**
 * The engine bindings, or null if the addon is missing or too old.
 *
 * `VideoPlayer` is the probe rather than the module itself: an older velocity
 * build loads fine and has every recording export, and would otherwise look
 * like a working engine right up until the first constructor call.
 */
export function getEngineBindings(): EngineBindings | null {
  if (bindings !== undefined) {
    return bindings;
  }

  const tried: string[] = [];

  for (const candidatePath of candidatePaths()) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    tried.push(candidatePath);

    try {
      const loaded = require(candidatePath) as Partial<EngineBindings>;

      if (typeof loaded.VideoPlayer !== 'function') {
        loadError = `velocity loaded from ${candidatePath} but has no VideoPlayer -- rebuild it with "pnpm --filter velocity build"`;
        continue;
      }

      bindings = loaded as EngineBindings;
      loadError = null;
      return bindings;
    } catch (error) {
      loadError = `velocity failed to load from ${candidatePath}: ${(error as Error).message}`;
    }
  }

  if (!loadError) {
    loadError =
      tried.length === 0
        ? 'velocity/index.js not found on any candidate path -- run "pnpm --filter velocity build"'
        : 'velocity was found but none of the candidates loaded';
  }

  bindings = null;
  return bindings;
}

/** For call sites that cannot do anything useful without the engine. */
export function requireEngineBindings(): EngineBindings {
  const loaded = getEngineBindings();
  if (!loaded) {
    throw new Error(loadError ?? 'engine bindings unavailable');
  }
  return loaded;
}

export function isEngineAvailable(): boolean {
  return getEngineBindings() !== null;
}

export function engineLoadError(): string | null {
  getEngineBindings();
  return loadError;
}
