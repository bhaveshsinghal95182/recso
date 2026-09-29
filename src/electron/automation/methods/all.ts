/**
 * Every method and event the API has, in one registry.
 *
 * Kept free of Electron so the docs generator can build the same registry
 * the app serves, from fake services, and describe it.
 */

import type { MethodRegistry } from '../registry.js';
import type { AutomationServices } from '../services.js';
import { registerCoreMethods } from './core.js';
import { registerEventMethods } from './events.js';
import { registerProjectMethods } from './projects.js';
import { registerRecordingMethods } from './recording.js';

export function registerAllMethods(
  registry: MethodRegistry,
  services: AutomationServices,
): MethodRegistry {
  registerCoreMethods(registry, services);
  registerRecordingMethods(registry, services);
  registerProjectMethods(registry, services);
  registerEventMethods(registry);
  return registry;
}
