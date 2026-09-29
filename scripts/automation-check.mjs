#!/usr/bin/env node
/**
 * `pnpm check:automation`: the Automation API end to end, through recso-cli
 * and through its MCP server, against the built app.
 *
 * Starts recso with the API on, in a throwaway user-data directory and socket
 * so nothing touches the user's own recso, with a hook in `automation.json`.
 * Then, once over the CLI and once over MCP: status, record a few seconds,
 * stop, export, and check the MP4 and what the hook received.
 *
 * Linux records a GStreamer PipeWire test node instead of going through the
 * portal's picker (gst-launch-1.0 is a development tool here, never shipped).
 * Windows records the primary screen, which needs no picker.
 *
 * Needs `pnpm transpile:electron` and `vite build` first (the package script
 * runs them). RECSO_ELECTRON points at another Electron binary; --keep keeps
 * the temp directory for a look afterwards.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(root, 'dist-electron/automation/cli/recso-cli.js');
const keep = process.argv.includes('--keep');
const recordMs = 4000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recso-automation-check-'));
const userData = path.join(tmp, 'user-data');
const recordings = path.join(tmp, 'recordings');
const exportsDir = path.join(tmp, 'exports');
const hookLog = path.join(tmp, 'hooks.log');
const socket =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\recso-automation-check-${process.pid}`
    : path.join(tmp, 'api.sock');

const children = [];
let failures = 0;

function pass(message) {
  console.log(`  ok  ${message}`);
}

function fail(message) {
  failures += 1;
  console.log(`  FAIL ${message}`);
}

function check(condition, message, detail) {
  if (condition) pass(message);
  else fail(detail === undefined ? message : `${message}: ${detail}`);
  return condition;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function electronBinary() {
  if (process.env.RECSO_ELECTRON) return process.env.RECSO_ELECTRON;
  // The electron package's main export is the path to its binary.
  return createRequire(import.meta.url)('electron');
}

/** Linux: a video source the recorder takes in place of the portal. */
async function startTestNode() {
  const gst = spawn(
    'gst-launch-1.0',
    [
      '-q',
      'videotestsrc',
      'is-live=true',
      'pattern=ball',
      '!',
      // BGRx: without a format the node offers nothing velocity accepts.
      'video/x-raw,format=BGRx,width=1280,height=720,framerate=30/1',
      '!',
      'pipewiresink',
      'mode=provide',
      'client-name=recso-automation-check',
      `stream-properties=props,node.name=recso-automation-check-${process.pid},media.class=Video/Source`,
    ],
    { stdio: 'ignore' },
  );
  children.push(gst);
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    const dump = spawnSync('pw-dump', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (dump.status !== 0) continue;
    const node = JSON.parse(dump.stdout).find(
      (object) =>
        object.type === 'PipeWire:Interface:Node' &&
        object.info?.props?.['node.name'] === `recso-automation-check-${process.pid}`,
    );
    if (node) return String(node.id);
  }
  throw new Error('the GStreamer test node did not appear (is gst-plugin-pipewire installed?)');
}

function writeHookConfig() {
  const hookScript = path.join(tmp, 'hook.mjs');
  fs.writeFileSync(
    hookScript,
    `import fs from 'node:fs';
const input = fs.readFileSync(0, 'utf8').trim();
fs.appendFileSync(process.argv[2], JSON.stringify({ env: process.env.RECSO_EVENT, output: process.env.RECSO_OUTPUT ?? null, input: JSON.parse(input) }) + '\\n');
`,
  );
  const hook = [process.execPath, hookScript, hookLog];
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'automation.json'),
    JSON.stringify({ hooks: { 'recording.stopped': [hook], 'export.finished': [hook] } }, null, 2),
  );
}

function launchRecso(env) {
  const app = spawn(electronBinary(), [root, `--user-data-dir=${userData}`, '--background'], {
    env: { ...process.env, ...env, RECSO_AUTOMATION: '1', RECSO_AUTOMATION_SOCKET: socket },
    stdio: ['ignore', fs.openSync(path.join(tmp, 'recso.log'), 'w'), 'pipe'],
  });
  app.stderr.pipe(fs.createWriteStream(path.join(tmp, 'recso.err.log')));
  children.push(app);
  return app;
}

function cli(args) {
  const result = spawnSync(process.execPath, [cliPath, '--json', ...args], {
    env: { ...process.env, RECSO_AUTOMATION_SOCKET: socket },
    encoding: 'utf8',
    timeout: 15 * 60_000,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    /* Left null; the caller reports the exit code and stderr. */
  }
  return { code: result.status, json, stderr: result.stderr.trim() };
}

async function waitForApi() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (cli(['status']).code === 0) return true;
    await sleep(500);
  }
  return false;
}

function probe(file) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) return null;
  const parsed = JSON.parse(result.stdout);
  return {
    codecs: parsed.streams.map((stream) => stream.codec_name),
    durationS: Number(parsed.format.duration),
  };
}

function checkExport(label, file) {
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (!check(size > 0, `${label}: export written`, `${file} is missing or empty`)) return;
  const probed = probe(file);
  if (!probed) {
    pass(`${label}: ffprobe not on PATH; ${size} bytes written`);
    return;
  }
  check(
    probed.codecs.includes('h264') && probed.durationS > (recordMs / 1000) * 0.5,
    `${label}: H.264, ${probed.durationS.toFixed(2)} s`,
    JSON.stringify(probed),
  );
}

function hookEntries() {
  if (!fs.existsSync(hookLog)) return [];
  return fs
    .readFileSync(hookLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForHook(event, output) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const entry = hookEntries().find(
      (candidate) => candidate.env === event && (!output || candidate.output === output),
    );
    if (entry) return entry;
    await sleep(250);
  }
  return null;
}

async function cliRun() {
  console.log('CLI');
  const status = cli(['status']);
  check(status.code === 0 && status.json?.engine !== undefined, 'status', status.stderr);

  const started = cli([
    'record',
    'start',
    '--out',
    recordings,
    '--name',
    'cli-take',
    '--no-mic',
    '--no-system-audio',
  ]);
  if (!check(started.code === 0, 'record start', started.stderr)) return;
  await sleep(recordMs);
  const stopped = cli(['record', 'stop']);
  if (!check(stopped.code === 0 && stopped.json?.projectDir, 'record stop', stopped.stderr)) return;
  const projectDir = stopped.json.projectDir;

  const project = cli(['projects', 'get', projectDir]);
  check(project.code === 0 && project.json?.durationMs > 0, 'projects get', project.stderr);

  const output = path.join(exportsDir, 'cli.mp4');
  const exported = cli(['export', projectDir, '--out', output, '--wait']);
  check(
    exported.code === 0 && exported.json?.state === 'finished',
    `export (${exported.json?.encoderName ?? 'encoder not reported'})`,
    exported.stderr || JSON.stringify(exported.json),
  );
  checkExport('CLI', output);

  const again = cli(['export', projectDir, '--out', output]);
  check(
    again.code !== 0 && again.json?.error?.reason === 'output_exists',
    'an existing output is refused',
    JSON.stringify(again.json),
  );

  const stopHook = await waitForHook('recording.stopped');
  check(
    stopHook?.input?.data?.projectDir === projectDir,
    'hook got recording.stopped',
    JSON.stringify(stopHook),
  );
  const exportHook = await waitForHook('export.finished', output);
  check(exportHook !== null, 'hook got export.finished with RECSO_OUTPUT');
}

/** A minimal MCP client over the CLI's stdio server. */
function startMcp() {
  const server = spawn(process.execPath, [cliPath, 'mcp'], {
    env: { ...process.env, RECSO_AUTOMATION_SOCKET: socket },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(server);
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve) => pending.set(id, resolve));
    },
    notify(method, params) {
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    async tool(name, args = {}) {
      const response = await this.request('tools/call', { name, arguments: args });
      const result = response.result ?? {};
      return { isError: result.isError === true || !!response.error, result, response };
    },
    close() {
      server.stdin.end();
    },
  };
}

async function mcpRun() {
  console.log('MCP');
  const mcp = startMcp();
  const init = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'automation-check', version: '1' },
  });
  check(init.result?.serverInfo?.name === 'recso', 'initialize', JSON.stringify(init));
  mcp.notify('notifications/initialized', {});

  const list = await mcp.request('tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  check(
    ['app_status', 'recording_start', 'recording_stop', 'export_start'].every((name) =>
      names.includes(name),
    ),
    `tools/list (${names.length} tools)`,
    names.join(', '),
  );

  const status = await mcp.tool('app_status');
  check(!status.isError, 'app_status', JSON.stringify(status.response));

  const started = await mcp.tool('recording_start', {
    outputDir: recordings,
    fileName: 'mcp-take',
    mic: false,
    systemAudio: false,
  });
  if (!check(!started.isError, 'recording_start', JSON.stringify(started.response))) {
    mcp.close();
    return;
  }
  await sleep(recordMs);
  const stopped = await mcp.tool('recording_stop');
  const projectDir = stopped.result.structuredContent?.projectDir;
  if (!check(!stopped.isError && projectDir, 'recording_stop', JSON.stringify(stopped.response))) {
    mcp.close();
    return;
  }

  const output = path.join(exportsDir, 'mcp.mp4');
  const exported = await mcp.tool('export_start', { projectDir, output, wait: true });
  check(
    !exported.isError && exported.result.structuredContent?.state === 'finished',
    'export_start (wait)',
    JSON.stringify(exported.response),
  );
  checkExport('MCP', output);

  const missing = await mcp.tool('projects_get', { projectDir: path.join(tmp, 'nope') });
  check(missing.isError, 'a bad call comes back as a tool error, not a crash');
  mcp.close();
}

async function main() {
  if (!fs.existsSync(cliPath)) {
    throw new Error(`${cliPath} is missing; run pnpm transpile:electron first`);
  }
  console.log(`recso Automation API check (${process.platform}), temp: ${tmp}`);
  const env = {};
  if (process.platform === 'linux') {
    env.VELOCITY_TEST_PIPEWIRE_NODE = await startTestNode();
    pass(`test node ${env.VELOCITY_TEST_PIPEWIRE_NODE}`);
  }
  writeHookConfig();
  launchRecso(env);
  if (!check(await waitForApi(), 'recso started with its API on')) return;

  await cliRun();
  await mcpRun();
}

function cleanUp() {
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.kill();
  }
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  cleanUp();
  await sleep(500);
  if (!keep && failures === 0) fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? 'all passed' : `${failures} failed (logs in ${tmp})`);
  process.exitCode = failures === 0 ? 0 : 1;
}
