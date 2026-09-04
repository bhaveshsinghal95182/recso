/**
 * The pairing server: a phone's camera, over the local network.
 *
 * The phone opens a page this serves, captures its own camera, and posts JPEG
 * frames back. They go straight into the native recorder's frame slot, which
 * the webcam sidecar loop reads exactly as it reads a USB camera -- so the
 * phone lands on the screen recording's own clock and needs no alignment
 * afterwards. See `velocity/src/capture/phone_camera.rs`.
 *
 * ## Why HTTPS, and why a warning
 *
 * Browsers refuse `getUserMedia` outside a secure context, and `http://` on a
 * private IP is not one. There is no flag, no header, no workaround: the camera
 * API simply is not there. So this has to be TLS, and on a home network with no
 * domain name the only certificate available is one the machine signs itself.
 * The phone shows a warning the first time and the user taps through it.
 *
 * That is not a wart being hidden. The certificate genuinely cannot be
 * verified, because nothing on a private network can vouch for it. What the
 * tap-through buys is a per-install key -- see `tls.rs` -- so the traffic is
 * actually encrypted rather than merely appearing to be.
 *
 * ## Why a token
 *
 * The server binds every interface, because the phone has to reach it and there
 * is no way to know in advance which interface it will arrive on. That means
 * anything else on the network can knock on the port. A random token in the URL
 * is what separates "the phone that scanned the code" from "some other device
 * that guessed the port" -- without it, a neighbour on the same wifi could push
 * frames into your recording. Every route checks it, in constant time, and it
 * is regenerated for every session.
 *
 * The server also only runs while pairing is open. It is not a background
 * service.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

import { capturePageHtml } from './phone-camera.page.js';

const require = createRequire(import.meta.url);

interface SelfSignedCertificate {
  certPem: string;
  keyPem: string;
  expiresAtMs: number;
}

interface VelocityPhoneBindings {
  generateSelfSignedCertificate(hosts: string[]): SelfSignedCertificate;
  pushPhoneFrame(jpeg: Buffer): Promise<{ width: number; height: number }>;
  resetPhoneCamera(): void;
  phoneCameraStatus(): {
    framesReceived: number;
    framesDropped: number;
    live: boolean;
    width: number;
    height: number;
  };
}

let velocity: VelocityPhoneBindings | null = null;

/**
 * Where to look for the native addon, in order.
 *
 * velocity lives outside node_modules, so there is no resolvable specifier for
 * it -- the same candidate walk the recorder and engine loaders do. The
 * packaged-app entries depend on Electron's `app`, so they are handed in rather
 * than read here: this module opens a network port and is worth being able to
 * start and test without an app shell around it.
 */
let velocityCandidates: string[] = [path.resolve(process.cwd(), 'velocity', 'index.js')];

function bindings(): VelocityPhoneBindings {
  if (velocity) {
    return velocity;
  }

  for (const candidate of velocityCandidates) {
    if (fs.existsSync(candidate)) {
      velocity = require(candidate) as VelocityPhoneBindings;
      return velocity;
    }
  }

  throw new Error(
    `the native camera bindings were not found. Tried: ${velocityCandidates.join(', ')}`,
  );
}

/** Largest frame we will read off the wire. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** How long a certificate has to have left before we bother regenerating. */
const CERT_RENEW_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;

const DEFAULT_PORT = 7420;

export interface PhoneCameraSession {
  /** The address to put in the QR code: the best guess at a reachable one. */
  url: string;
  /** Every address this machine answers on, best first, so the UI can offer alternates. */
  urls: string[];
  port: number;
}

export interface PhoneCameraState extends PhoneCameraSession {
  /** Whether a frame has arrived recently enough to still be showing the room. */
  live: boolean;
  framesReceived: number;
  framesDropped: number;
  width: number;
  height: number;
  /** Set when the phone reported something it could not recover from. */
  lastError?: string;
}

interface RunningSession extends PhoneCameraSession {
  server: Server;
  token: string;
  /** Open SSE responses, one per connected phone. */
  listeners: Set<ServerResponse>;
  lastError?: string;
}

let session: RunningSession | null = null;

/**
 * Addresses a phone could plausibly reach this machine on, best guess first.
 *
 * Ordering matters more than it looks. A developer machine routinely has half a
 * dozen IPv4 addresses -- WSL, Docker, Hyper-V, a VPN -- and all but one of them
 * are unreachable from a phone. Putting a virtual adapter in the QR code sends
 * the user to a page that never loads, with nothing on screen explaining why, so
 * the guessing is worth doing properly.
 */
export function localAddresses(): string[] {
  const found: Array<{ address: string; rank: number }> = [];

  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }

      found.push({ address: entry.address, rank: rankAddress(entry.address, name) });
    }
  }

  return found
    .sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address))
    .map((entry) => entry.address);
}

/** Lower is more likely to be the wifi the phone is on. */
function rankAddress(address: string, interfaceName: string): number {
  const name = interfaceName.toLowerCase();

  // Named outright. These adapters exist on a lot of developer machines and are
  // never the one a phone can see.
  if (/vethernet|hyper-v|wsl|docker|virtualbox|vmware|loopback|tailscale|zerotier/.test(name)) {
    return 100;
  }

  // VirtualBox host-only, which is 192.168.56.x by default and would otherwise
  // score as an ordinary home network.
  if (address.startsWith('192.168.56.')) {
    return 90;
  }

  // Docker and WSL sit in 172.17-172.31. The rest of 172.16/12 is legitimately
  // used by some routers, so this is a nudge rather than a rejection.
  if (/^172\.(1[7-9]|2\d|3[01])\./.test(address)) {
    return 80;
  }

  // What a home router hands out.
  if (address.startsWith('192.168.')) {
    return 10;
  }
  if (address.startsWith('10.')) {
    return 20;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) {
    return 30;
  }

  // A public address, or something unrecognised. Reachable in principle.
  return 50;
}

/**
 * Where the generated certificate lives between runs.
 *
 * Handed in rather than read from `app.getPath` so this module knows nothing
 * about the app shell -- which also means it can be started headless and
 * actually tested, instead of only ever running inside Electron.
 */
let stateDir: string | null = null;

function certificatePath(): string {
  if (!stateDir) {
    throw new Error('phone camera state directory was never set');
  }
  return path.join(stateDir, 'phone-camera', 'certificate.json');
}

/**
 * Point the service at its certificate store and the native addon.
 *
 * Called once at startup. Everything the app shell knows and this module should
 * not goes through here.
 */
export function configurePhoneCamera(options: {
  stateDir: string;
  velocityCandidates?: string[];
}): void {
  stateDir = options.stateDir;
  if (options.velocityCandidates?.length) {
    velocityCandidates = options.velocityCandidates;
  }
}

interface CachedCertificate extends SelfSignedCertificate {
  /** The addresses it covers. A new interface means a new certificate. */
  hosts: string[];
}

/**
 * The certificate for these hosts, generating one if what we have will not do.
 *
 * Regenerated when an address appears that it does not cover, because a
 * certificate missing the address the phone actually used produces a *different*
 * browser error from the ordinary self-signed one -- and a far more confusing
 * one, since it looks like an attack rather than a missing signature.
 */
function certificateFor(hosts: string[]): SelfSignedCertificate {
  const file = certificatePath();

  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as CachedCertificate;
    const coversEveryHost = hosts.every((host) => cached.hosts.includes(host));
    const stillGood = cached.expiresAtMs - Date.now() > CERT_RENEW_WITHIN_MS;

    if (coversEveryHost && stillGood && cached.certPem && cached.keyPem) {
      return cached;
    }
  } catch {
    // No certificate yet, or an unreadable one. Either way, make a new one.
  }

  const generated = bindings().generateSelfSignedCertificate(hosts);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The private key is in here, so keep it to the current user. Windows
    // ignores the mode, but this also runs on the developer's machine.
    fs.writeFileSync(file, JSON.stringify({ ...generated, hosts }), { mode: 0o600 });
  } catch (error) {
    // Not fatal: an unwritable cache means a new certificate every launch, and
    // one more tap-through on the phone. Worth saying, not worth failing.
    console.warn('[phone-camera] could not cache the certificate:', error);
  }

  return generated;
}

/** Constant-time token comparison, so the port cannot be used as an oracle. */
function tokenMatches(expected: string, candidate: string | null): boolean {
  if (!candidate || candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function readToken(request: IncomingMessage): string | null {
  try {
    const url = new URL(request.url ?? '/', 'https://placeholder');
    return url.searchParams.get('t');
  } catch {
    return null;
  }
}

/** Read a request body, refusing anything implausibly large. */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        reject(new Error('frame too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  response.writeHead(status, {
    'content-type': type,
    // Nothing here should be cached: the page carries a session token, and a
    // stale copy would point at a session that has ended.
    'cache-control': 'no-store',
    // The page is served to one device over a private link and embeds no third
    // party, so it has no business being framed or loading anything remote.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

/**
 * Start serving, or return the session already running.
 *
 * Idempotent because the UI can open the pairing panel more than once and
 * restarting would invalidate a phone that is already connected.
 */
export async function startPhoneCamera(): Promise<PhoneCameraSession> {
  if (session) {
    return { url: session.url, urls: session.urls, port: session.port };
  }

  const addresses = localAddresses();
  if (addresses.length === 0) {
    throw new Error(
      'this machine is not on a network, so a phone has no way to reach it -- connect to wifi and try again',
    );
  }

  // `localhost` is in the certificate so the page can be opened on the desktop
  // itself, which is the only way to test this without a second device.
  const certificate = certificateFor([...addresses, 'localhost']);
  const token = randomBytes(16).toString('hex');
  const listeners = new Set<ServerResponse>();

  const server = createServer(
    { cert: certificate.certPem, key: certificate.keyPem },
    (request, response) => {
      void handle(request, response, token, listeners);
    },
  );

  const port = await listen(server, DEFAULT_PORT);
  const urls = addresses.map((address) => `https://${address}:${port}/?t=${token}`);

  bindings().resetPhoneCamera();

  session = {
    server,
    token,
    listeners,
    port,
    url: urls[0],
    urls,
  };

  return { url: session.url, urls: session.urls, port };
}

/**
 * Bind, falling forward a few ports if the preferred one is taken.
 *
 * A fixed port would be friendlier -- the phone could keep a bookmark -- but the
 * token changes every session anyway, so there is nothing to bookmark, and
 * failing to start because something else owns 7420 would be a worse trade.
 */
function listen(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = preferred;

    const attempt = () => {
      server.removeAllListeners('error');
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && port < preferred + 10) {
          port += 1;
          attempt();
          return;
        }
        reject(error);
      });
      server.listen(port, '0.0.0.0', () => resolve(port));
    };

    attempt();
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  listeners: Set<ServerResponse>,
): Promise<void> {
  const pathname = (request.url ?? '/').split('?')[0];

  if (!tokenMatches(token, readToken(request))) {
    // Deliberately terse. Anything more descriptive tells a scanner what it
    // found and how close it got.
    send(response, 404, 'not found');
    return;
  }

  try {
    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      send(response, 200, capturePageHtml(token), 'text/html; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && pathname === '/events') {
      openEventStream(response, listeners);
      return;
    }

    if (request.method === 'POST' && pathname === '/frame') {
      const jpeg = await readBody(request);
      await bindings().pushPhoneFrame(jpeg);
      send(response, 204, '');
      return;
    }

    if (request.method === 'POST' && pathname === '/problem') {
      // The phone telling us why it stopped -- permission denied, no camera,
      // the tab going to sleep. Surfacing it beats a preview that is simply
      // blank with no explanation on either device.
      const body = await readBody(request);
      if (session) {
        session.lastError = body.toString('utf8').slice(0, 300);
      }
      send(response, 204, '');
      return;
    }

    send(response, 404, 'not found');
  } catch (error) {
    send(response, 400, error instanceof Error ? error.message : 'bad request');
  }
}

/** Server-sent events: the desktop's way of telling the phone what to do. */
function openEventStream(response: ServerResponse, listeners: Set<ServerResponse>): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  response.write('retry: 2000\n\n');

  listeners.add(response);
  response.on('close', () => listeners.delete(response));
}

/** Tell every connected phone something. */
export function notifyPhone(event: string, data: Record<string, unknown> = {}): void {
  if (!session) {
    return;
  }

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const listener of session.listeners) {
    try {
      listener.write(payload);
    } catch {
      // A phone that walked out of range. The close handler will clean it up.
    }
  }
}

/** What the pairing panel needs to render. */
export function phoneCameraState(): PhoneCameraState | null {
  if (!session) {
    return null;
  }

  const status = bindings().phoneCameraStatus();
  return {
    url: session.url,
    urls: session.urls,
    port: session.port,
    live: status.live,
    framesReceived: status.framesReceived,
    framesDropped: status.framesDropped,
    width: status.width,
    height: status.height,
    lastError: session.lastError,
  };
}

/** Stop serving and forget the session. Safe to call when nothing is running. */
export async function stopPhoneCamera(): Promise<void> {
  const running = session;
  session = null;

  if (!running) {
    return;
  }

  notifyPhoneOn(running, 'ended');
  for (const listener of running.listeners) {
    listener.end();
  }
  running.listeners.clear();

  await new Promise<void>((resolve) => {
    running.server.close(() => resolve());
    // Sockets held open by an SSE stream would otherwise keep `close` waiting.
    running.server.closeAllConnections?.();
  });

  bindings().resetPhoneCamera();
}

function notifyPhoneOn(running: RunningSession, event: string): void {
  const payload = `event: ${event}\ndata: {}\n\n`;
  for (const listener of running.listeners) {
    try {
      listener.write(payload);
    } catch {
      /* going away anyway */
    }
  }
}
