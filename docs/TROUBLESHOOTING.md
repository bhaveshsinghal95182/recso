# Troubleshooting Guide

## Native Module Binding Errors

### Symptom

```
Error: Could not locate the bindings file. Tried:
→ C:\...\better_sqlite3.node
```

This happens when native Node modules (like `better-sqlite3`) aren't compiled for Electron's Node version.

### Quick Fix

```bash
npx @electron/rebuild
```

### Why This Happens

- Native modules compile for your system's Node version by default
- Electron bundles its own Node version, which may differ
- The compiled `.node` binaries are incompatible

### Prevention

The `postinstall` script in `package.json` handles this automatically:

```json
"postinstall": "npx @electron/rebuild"
```

### Manual Steps (if postinstall fails)

1. **Approve native builds in pnpm:**

   ```bash
   pnpm approve-builds
   # Select the module (e.g., better-sqlite3), press Space, then Y
   ```

2. **Rebuild for Electron:**

   ```bash
   npx @electron/rebuild
   ```

3. **Verify:**
   ```bash
   pnpm dev
   ```

### Common Native Modules

These require rebuilding for Electron:

- `better-sqlite3`
- `node-pty`
- `sharp`
- `serialport`
- Any package using `node-gyp` or `prebuild`
