/** Wire the portable CLI to this process only at the executable entry point. */

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { launchPlan, launchRecso } from './launch.js';
import { type CliIo, runCli } from './run.js';

const cliPath = fileURLToPath(import.meta.url);
const interrupted = new Promise<void>((resolve) => process.once('SIGINT', resolve));
let runMcp: CliIo['runMcp'];
const mcpModule = '../mcp.js';
try {
  const mod = await import(mcpModule);
  runMcp = (socketPath) => mod.runMcpServer(socketPath);
} catch {
  /* MCP is optional until its entry point is built. */
}

const io: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  platform: process.platform,
  username: os.userInfo().username,
  tmpdir: os.tmpdir(),
  execPath: process.execPath,
  cliPath,
  exists: fs.existsSync,
  launch: () => {
    const plan = launchPlan({
      platform: process.platform,
      env: process.env,
      execPath: process.execPath,
      cliPath,
      exists: fs.existsSync,
    });
    if (!plan) return false;
    launchRecso(plan);
    return true;
  },
  interrupted,
  ...(runMcp ? { runMcp } : {}),
};

process.exitCode = await runCli(process.argv.slice(2), io);
