---
description: How to add new IPC (Inter-Process Communication) functionality to the Electron app
---

# Adding New IPC Functionality

This workflow covers adding new IPC handlers for communication between the React UI and Electron main process.

## Steps

### 1. Create or update the IPC handler module

**File:** `src/electron/ipc/{feature}.ipc.ts`

```typescript
import { ipcMain } from 'electron';

export function register{Feature}Handlers() {
  // One-way (fire & forget)
  ipcMain.on('channel-name', () => {
    // Do something
  });

  // Two-way (request/response)
  ipcMain.handle('channel-name', async (_event, arg1: Type1) => {
    return { success: true, data: result };
  });
}
```

### 2. Register the handler in ipc/index.ts

**File:** `src/electron/ipc/index.ts`

```typescript
import { register{Feature}Handlers } from './{feature}.ipc.js';

export function registerAllIpcHandlers() {
  // ... existing handlers
  register{Feature}Handlers();
}
```

### 3. Expose in preload.cts

**File:** `src/electron/preload.cts`

Add to the appropriate namespace group:

```typescript
electron.contextBridge.exposeInMainWorld('electron', {
  // ... existing groups
  {feature}: {
    doSomething: () => electron.ipcRenderer.send('channel-name'),
    getData: (arg: string) => electron.ipcRenderer.invoke('get-data', arg),
  },
});
```

### 4. Add TypeScript types

**File:** `src/ui/electron.d.ts`

```typescript
interface ElectronAPI {
  // ... existing groups
  {feature}: {
    doSomething: () => void;
    getData: (arg: string) => Promise<{ success: boolean; data: any }>;
  };
}
```

### 5. Use in React component

```tsx
// One-way call
window.electron.{feature}.doSomething();

// Two-way call
const result = await window.electron.{feature}.getData('arg');
```

## IPC Pattern Reference

| Pattern           | Preload                             | Main                               | Use Case          |
| ----------------- | ----------------------------------- | ---------------------------------- | ----------------- |
| `send`/`on`       | `ipcRenderer.send(channel)`         | `ipcMain.on(channel, handler)`     | Fire & forget     |
| `invoke`/`handle` | `ipcRenderer.invoke(channel)`       | `ipcMain.handle(channel, handler)` | Request/response  |
| Push subscription | `ipcRenderer.on(channel, callback)` | `webContents.send(channel, data)`  | Real-time updates |

## Files to touch

1. `src/electron/ipc/{feature}.ipc.ts` - Handler logic
2. `src/electron/ipc/index.ts` - Registration
3. `src/electron/preload.cts` - Bridge exposure
4. `src/ui/electron.d.ts` - TypeScript types
5. (Optional) `src/electron/services/{feature}.service.ts` - Business logic
