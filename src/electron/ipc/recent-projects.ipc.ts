/**
 * IPC handlers for recent projects (welcome screen history).
 *
 * Channels:
 *   recent-projects:get     → getRecentProjects(limit)
 *   recent-projects:remove  → removeRecentProject(id)
 *   recent-projects:clear   → clearRecentProjects()
 */

import { ipcMain } from 'electron';

import {
  clearRecentProjects,
  getRecentProjects,
  removeRecentProject,
} from '../services/recent-projects.service.js';

export function registerRecentProjectsHandlers(): void {
  ipcMain.handle('recent-projects:get', (_event, limit?: number) => {
    return getRecentProjects(limit);
  });

  ipcMain.handle('recent-projects:remove', (_event, id: string) => {
    return removeRecentProject(id);
  });

  ipcMain.handle('recent-projects:clear', () => {
    return clearRecentProjects();
  });

  console.log('[RecentProjectsIPC] Handlers registered');
}
