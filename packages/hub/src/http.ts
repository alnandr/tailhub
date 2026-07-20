/**
 * The Tailhub HTTP surface. Zero dependencies — node:http and hand-rolled
 * validation keep the whole trusted computing base auditable in one sitting.
 *
 * Routes:
 *   GET  /health                                       liveness (no auth)
 *   GET  /v1/hub                                       hub overview (admin)
 *   GET  /v1/apps                                      list manifests (admin)
 *   GET  /v1/apps/:app                                 manifest (admin or app)
 *   PUT  /v1/apps/:app                                 register manifest (admin)
 *   DEL  /v1/apps/:app                                 unregister (admin; data kept)
 *   GET  /v1/apps/:app/bundle                          full export
 *   PUT  /v1/apps/:app/bundle                          bulk import
 *   GET  /v1/apps/:app/:collection                     list artifact metadata
 *   GET  /v1/apps/:app/:collection/:id                 latest revision (ETag/304)
 *   PUT  /v1/apps/:app/:collection/:id                 push revision (409 conflict)
 *   DEL  /v1/apps/:app/:collection/:id                 tombstone
 *   GET  /v1/apps/:app/:collection/:id/history         retained revisions
 *   GET  /v1/apps/:app/:collection/:id/history/:rev    one retained revision
 *   GET  /                                             admin console
 *   GET  /sdk/tailhub-client.js                        browser SDK (+ modules)
 *   GET  /apps/:app/*                                  app static files (www: true)
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, extractToken, sha256Hex, type AuthResult } from './auth.js';
import { isValidAppName, isValidArtifactId, isValidCollectionName } from './ids.js';
import {
  deleteManifest,
  listManifests,
  loadManifest,
  publicManifest,
  saveManifest,
  validateManifest,
  wwwDir,
  type AppManifest,
} from './manifests.js';
import { serveFile, serveStaticTree } from './static.js';
import {
  ArtifactStore,
  toMeta,
  type CollectionLimits,
  type EncryptionMeta,
  type PutArtifactInput,
  type StoredArtifact,
  type WriteContext,
} from './store.js';
import { TAILHUB_NAME, TAILHUB_VERSION } from './version.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SDK_FILES = new Set(['tailhub-client.js', 'index.js', 'crypto.js', 'browser.js']);

export type HubOptions = {
  dataDir: string;
  adminToken: string;
  maxRequestBytes?: number;
  defaultMaxArtifactBytes?: number;
  defaultHistoryKeep?: number;
  corsOrigins?: '*' | string[];
  trustTailscaleHeaders?: boolean;
  quiet?: boolean;
};

export type Hub = {
  server: http.Server;
  store: ArtifactStore;
  dataDir: string;
  listen(port: number, host: string): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
};

class HttpProblem extends Error {
  constructor(
    public status: number,
    public errorLabel: string,
    message: string
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new HttpProblem(413, 'Payload too large', `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpProblem(400, 'Invalid JSON', 'Request body is not valid JSON.');
  }
}

function makeEtag(record: StoredArtifact): string {
  return `"${record.revision}-${record.hash ? record.hash.slice(7, 19) : 'del'}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((s) => s.trim())
    .some((candidate) => candidate === etag || candidate === '*');
}

function validateEncryptionMeta(value: unknown): EncryptionMeta | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpProblem(400, 'Invalid encryption', 'encryption must be null or an envelope object.');
  }
  const v = value as Record<string, unknown>;
  if (
    v.v !== 1 ||
    typeof v.algo !== 'string' ||
    v.algo.length > 32 ||
    typeof v.kdf !== 'string' ||
    v.kdf.length > 32 ||
    !Number.isInteger(v.iterations) ||
    (v.iterations as number) < 1 ||
    (v.iterations as number) > 10_000_000 ||
    typeof v.salt !== 'string' ||
    v.salt.length > 128 ||
    typeof v.iv !== 'string' ||
    v.iv.length > 64
  ) {
    throw new HttpProblem(400, 'Invalid encryption', 'encryption envelope has an invalid shape.');
  }
  return {
    v: 1,
    algo: v.algo,
    kdf: v.kdf,
    iterations: v.iterations as number,
    salt: v.salt,
    iv: v.iv,
  };
}

type PushBody = {
  title: string;
  updatedAt?: string;
  payload: unknown;
  encryption: EncryptionMeta | null;
  baseRevision: number;
  force: boolean;
  deviceId?: string;
  deviceName?: string;
};

function validatePushBody(value: unknown): PushBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpProblem(400, 'Invalid body', 'Push body must be a JSON object.');
  }
  const v = value as Record<string, unknown>;
  if (!('payload' in v) || v.payload === undefined) {
    throw new HttpProblem(400, 'Missing payload', 'Push body must include a "payload".');
  }
  if (!Number.isInteger(v.baseRevision) || (v.baseRevision as number) < 0) {
    throw new HttpProblem(
      400,
      'Missing baseRevision',
      'Push body must include an integer "baseRevision" (0 when creating).'
    );
  }
  const title = typeof v.title === 'string' ? v.title.slice(0, 200) : 'Untitled';
  const updatedAt =
    typeof v.updatedAt === 'string' && v.updatedAt.length <= 64 ? v.updatedAt : undefined;
  const deviceId =
    typeof v.deviceId === 'string' && v.deviceId ? v.deviceId.slice(0, 128) : undefined;
  const deviceName =
    typeof v.deviceName === 'string' && v.deviceName ? v.deviceName.slice(0, 128) : undefined;
  return {
    title,
    updatedAt,
    payload: v.payload,
    encryption: validateEncryptionMeta(v.encryption),
    baseRevision: v.baseRevision as number,
    force: v.force === true,
    deviceId,
    deviceName,
  };
}

function headerString(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  if (Array.isArray(value) && value[0]) return String(value[0]).trim().slice(0, 128);
  return undefined;
}

export function createHub(options: HubOptions): Hub {
  const dataDir = options.dataDir;
  const maxRequestBytes = options.maxRequestBytes ?? 25 * 1024 * 1024;
  const defaultMaxArtifactBytes = options.defaultMaxArtifactBytes ?? 10 * 1024 * 1024;
  const defaultHistoryKeep = options.defaultHistoryKeep ?? 20;
  const corsOrigins = options.corsOrigins ?? '*';
  const trustTailscaleHeaders = options.trustTailscaleHeaders === true;
  const quiet = options.quiet === true;
  const adminTokenHash = sha256Hex(options.adminToken);
  const store = new ArtifactStore(dataDir);
  const bootedAt = Date.now();

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin) return;
    if (corsOrigins !== '*' && !corsOrigins.includes(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, If-None-Match, X-Tailhub-Token, X-Tailhub-Device, X-Tailhub-Device-Name'
    );
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  function writeContext(req: IncomingMessage, body?: PushBody): WriteContext {
    return {
      deviceId: headerString(req, 'x-tailhub-device') ?? body?.deviceId,
      deviceName: headerString(req, 'x-tailhub-device-name') ?? body?.deviceName,
      tailscaleUser: trustTailscaleHeaders ? headerString(req, 'tailscale-user-login') : undefined,
    };
  }

  function limitsFor(manifest: AppManifest, collection: string): CollectionLimits {
    const policy = manifest.collections[collection] ?? {};
    return {
      maxBytes: policy.maxBytes ?? defaultMaxArtifactBytes,
      historyKeep: policy.historyKeep ?? defaultHistoryKeep,
    };
  }

  function requireAuth(req: IncomingMessage, manifest: AppManifest | null): AuthResult {
    const auth = authenticate(extractToken(req), adminTokenHash, manifest);
    if (!auth) {
      throw new HttpProblem(
        401,
        'Unauthorized',
        'Invalid or missing token. Send "Authorization: Bearer <token>".'
      );
    }
    return auth;
  }

  function requireAdmin(auth: AuthResult): void {
    if (auth?.level !== 'admin') {
      throw new HttpProblem(403, 'Forbidden', 'The hub admin token is required for this route.');
    }
  }

  async function handleArtifactApi(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
    url: URL
  ): Promise<void> {
    // segments: ['v1', 'apps', app, ...]
    const appName = segments[2] ?? '';
    if (!isValidAppName(appName)) {
      throw new HttpProblem(
        400,
        'Invalid app name',
        'App names are 1-64 chars of lowercase a-z, 0-9, or hyphen.'
      );
    }
    const manifest = await loadManifest(dataDir, appName);
    const auth = requireAuth(req, manifest);

    if (segments.length === 3) {
      if (req.method === 'GET') {
        if (!manifest) throw new HttpProblem(404, 'Not found', `App "${appName}" is not registered.`);
        return sendJson(res, 200, publicManifest(manifest));
      }
      if (req.method === 'PUT') {
        requireAdmin(auth);
        const body = await readJsonBody(req, maxRequestBytes);
        const result = validateManifest(body, appName);
        if (!result.ok) throw new HttpProblem(400, 'Invalid manifest', result.message);
        await saveManifest(dataDir, result.manifest);
        return sendJson(res, 200, { ok: true, app: publicManifest(result.manifest) });
      }
      if (req.method === 'DELETE') {
        requireAdmin(auth);
        const deleted = await deleteManifest(dataDir, appName);
        if (!deleted) throw new HttpProblem(404, 'Not found', `App "${appName}" is not registered.`);
        return sendJson(res, 200, { ok: true, note: 'Manifest removed; stored artifacts were kept on disk.' });
      }
      throw new HttpProblem(405, 'Method not allowed', 'Use GET, PUT, or DELETE.');
    }

    if (!manifest) {
      throw new HttpProblem(
        404,
        'Not found',
        `App "${appName}" is not registered on this hub. Register a manifest first (PUT /v1/apps/${appName}).`
      );
    }

    // /v1/apps/:app/bundle
    if (segments.length === 4 && segments[3] === 'bundle') {
      if (req.method === 'GET') {
        return sendJson(res, 200, await store.bundle(appName));
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req, maxRequestBytes);
        if (typeof body !== 'object' || body === null || !Array.isArray((body as Record<string, unknown>).artifacts)) {
          throw new HttpProblem(400, 'Invalid body', 'Bundle body must be { artifacts: [...] }.');
        }
        const force = (body as Record<string, unknown>).force === true;
        const rawEntries = (body as { artifacts: unknown[] }).artifacts;
        if (rawEntries.length === 0) {
          throw new HttpProblem(400, 'Empty bundle', 'Bundle "artifacts" array is empty.');
        }
        const entries: Array<Omit<PutArtifactInput, 'app'>> = [];
        const skipped: string[] = [];
        for (const rawEntry of rawEntries) {
          if (typeof rawEntry !== 'object' || rawEntry === null) {
            throw new HttpProblem(400, 'Invalid bundle entry', 'Each bundle entry must be an object.');
          }
          const e = rawEntry as Record<string, unknown>;
          const collection = typeof e.collection === 'string' ? e.collection : '';
          if (!isValidCollectionName(collection) || !manifest.collections[collection]) {
            throw new HttpProblem(400, 'Invalid bundle entry', `Unknown collection "${collection}".`);
          }
          const id = typeof e.id === 'string' ? e.id : '';
          if (!isValidArtifactId(id)) {
            throw new HttpProblem(400, 'Invalid bundle entry', `Invalid artifact id "${id}".`);
          }
          // Tombstones are not replayed by bundle import (v1) — deletions never
          // propagate implicitly from a backup file.
          if (e.deleted === true) {
            skipped.push(`${collection}/${id}`);
            continue;
          }
          // A raw exported bundle carries "revision", not "baseRevision"; with
          // force (disaster restore) the check is skipped anyway.
          const entryValue =
            force && !Number.isInteger(e.baseRevision) ? { ...e, baseRevision: 0 } : e;
          const push = validatePushBody(entryValue);
          entries.push({
            collection,
            id,
            title: push.title,
            updatedAt: push.updatedAt,
            payload: push.payload,
            encryption: push.encryption,
            baseRevision: push.baseRevision,
          });
        }
        const result = await store.putBundle(appName, entries, {
          ...writeContext(req),
          force,
        }, (collection) => limitsFor(manifest, collection));
        const status = result.conflicts.length > 0 && result.written === 0 ? 409 : 200;
        return sendJson(res, status, {
          ok: result.conflicts.length === 0,
          written: result.written,
          conflicts: result.conflicts,
          skipped,
        });
      }
      throw new HttpProblem(405, 'Method not allowed', 'Use GET or PUT.');
    }

    const collection = segments[3] ?? '';
    if (!isValidCollectionName(collection)) {
      throw new HttpProblem(
        400,
        'Invalid collection',
        'Collection names are 1-64 chars of lowercase a-z, 0-9, or hyphen.'
      );
    }
    const policy = manifest.collections[collection];
    if (!policy) {
      throw new HttpProblem(
        404,
        'Unknown collection',
        `App "${appName}" has no collection "${collection}". Add it to the app manifest.`
      );
    }
    const limits = limitsFor(manifest, collection);
    const encryptionPolicy = policy.encryption ?? 'optional';

    if (segments.length === 4) {
      if (req.method !== 'GET') throw new HttpProblem(405, 'Method not allowed', 'Use GET.');
      const includeDeleted = url.searchParams.get('includeDeleted') === '1';
      return sendJson(res, 200, {
        artifacts: await store.list(appName, collection, { includeDeleted }),
      });
    }

    const id = segments[4] ?? '';
    if (!isValidArtifactId(id)) {
      throw new HttpProblem(
        400,
        'Invalid artifact id',
        'Artifact ids are 1-128 chars of letters, digits, dot, underscore, or hyphen (no leading dot).'
      );
    }

    if (segments.length === 5) {
      if (req.method === 'GET') {
        const record = await store.get(appName, collection, id);
        if (!record) throw new HttpProblem(404, 'Not found', 'No such artifact.');
        if (record.deleted) {
          return sendJson(res, 410, {
            error: 'Gone',
            message: 'Artifact was deleted.',
            artifact: toMeta(record),
          });
        }
        const etag = makeEtag(record);
        res.setHeader('ETag', etag);
        if (etagMatches(req.headers['if-none-match'] as string | undefined, etag)) {
          res.writeHead(304);
          res.end();
          return;
        }
        return sendJson(res, 200, record);
      }
      if (req.method === 'PUT') {
        const body = validatePushBody(await readJsonBody(req, maxRequestBytes));
        if (encryptionPolicy === 'required' && !body.encryption) {
          throw new HttpProblem(
            400,
            'Encryption required',
            `Collection "${collection}" only accepts end-to-end encrypted payloads.`
          );
        }
        if (encryptionPolicy === 'none' && body.encryption) {
          throw new HttpProblem(
            400,
            'Encryption not allowed',
            `Collection "${collection}" does not accept encrypted payloads.`
          );
        }
        const result = await store.put(
          {
            app: appName,
            collection,
            id,
            title: body.title,
            updatedAt: body.updatedAt,
            payload: body.payload,
            encryption: body.encryption,
            baseRevision: body.baseRevision,
          },
          { ...writeContext(req, body), force: body.force },
          limits
        );
        if (!result.ok) {
          if (result.reason === 'conflict') {
            return sendJson(res, 409, {
              error: 'Conflict',
              message: result.message,
              remote: result.remote,
            });
          }
          return sendJson(res, 413, {
            error: 'Payload too large',
            message: result.message,
            maxBytes: result.maxBytes,
          });
        }
        res.setHeader('ETag', makeEtag(result.record));
        return sendJson(res, 200, {
          ok: true,
          created: result.created,
          artifact: toMeta(result.record),
        });
      }
      if (req.method === 'DELETE') {
        const baseRaw = url.searchParams.get('baseRevision');
        const baseRevision = baseRaw === null ? undefined : Number(baseRaw);
        if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
          throw new HttpProblem(400, 'Invalid baseRevision', 'baseRevision must be a non-negative integer.');
        }
        const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
        const result = await store.remove(
          appName,
          collection,
          id,
          { ...writeContext(req), force, baseRevision },
          limits
        );
        if (!result.ok) {
          if (result.reason === 'not-found') throw new HttpProblem(404, 'Not found', 'No such artifact.');
          return sendJson(res, 409, {
            error: 'Conflict',
            message: result.message,
            remote: result.remote,
          });
        }
        return sendJson(res, 200, { ok: true, artifact: toMeta(result.record) });
      }
      throw new HttpProblem(405, 'Method not allowed', 'Use GET, PUT, or DELETE.');
    }

    if (segments[5] === 'history' && req.method === 'GET') {
      if (segments.length === 6) {
        return sendJson(res, 200, { revisions: await store.history(appName, collection, id) });
      }
      if (segments.length === 7) {
        const revision = Number(segments[6]);
        if (!Number.isInteger(revision) || revision < 1) {
          throw new HttpProblem(400, 'Invalid revision', 'Revision must be a positive integer.');
        }
        const record = await store.historyRevision(appName, collection, id, revision);
        if (!record) throw new HttpProblem(404, 'Not found', 'That revision is not retained.');
        return sendJson(res, 200, record);
      }
    }

    throw new HttpProblem(404, 'Not found', 'Unknown route.');
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    segments: string[],
    url: URL
  ): Promise<void> {
    if (segments[1] === 'hub' && segments.length === 2 && req.method === 'GET') {
      requireAdmin(requireAuth(req, null));
      const manifests = await listManifests(dataDir);
      return sendJson(res, 200, {
        ok: true,
        name: TAILHUB_NAME,
        version: TAILHUB_VERSION,
        uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
        apps: manifests.length,
        artifacts: await store.countArtifacts(),
        storage: 'local-disk',
      });
    }
    if (segments[1] === 'apps' && segments.length === 2 && req.method === 'GET') {
      requireAdmin(requireAuth(req, null));
      const manifests = await listManifests(dataDir);
      return sendJson(res, 200, { apps: manifests.map(publicManifest) });
    }
    if (segments[1] === 'apps' && segments.length >= 3) {
      return handleArtifactApi(req, res, segments, url);
    }
    throw new HttpProblem(404, 'Not found', 'Unknown route.');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://tailhub.internal');
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });

    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok', name: TAILHUB_NAME, version: TAILHUB_VERSION });
    }

    if (segments[0] === 'v1') {
      return handleApi(req, res, segments, url);
    }

    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/console') {
        const ok = await serveFile(res, path.join(moduleDir, 'console.html'), 'text/html; charset=utf-8');
        if (ok) return;
        throw new HttpProblem(404, 'Not found', 'Console asset missing from this build.');
      }
      if (segments[0] === 'sdk' && segments.length === 2 && SDK_FILES.has(segments[1] ?? '')) {
        const ok = await serveFile(res, path.join(moduleDir, 'sdk', segments[1] ?? ''));
        if (ok) return;
        throw new HttpProblem(404, 'Not found', 'SDK asset missing from this build.');
      }
      if (segments[0] === 'apps' && segments.length >= 2) {
        const appName = segments[1] ?? '';
        if (isValidAppName(appName)) {
          const manifest = await loadManifest(dataDir, appName);
          if (manifest?.www === true) {
            const ok = await serveStaticTree(res, wwwDir(dataDir, appName), segments.slice(2).join('/'));
            if (ok) return;
          }
        }
        throw new HttpProblem(404, 'Not found', 'No static app is served at this path.');
      }
    }

    throw new HttpProblem(404, 'Not found', 'Unknown route.');
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    if (!quiet) {
      res.on('finish', () => {
        const pathname = (req.url ?? '/').split('?')[0];
        console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      });
    }
    handle(req, res).catch((error: unknown) => {
      if (res.writableEnded) return;
      if (error instanceof HttpProblem) {
        return sendJson(res, error.status, { error: error.errorLabel, message: error.message });
      }
      console.error('tailhub: unhandled request error', error);
      return sendJson(res, 500, {
        error: 'Internal error',
        message: error instanceof Error ? error.message : 'Unknown error.',
      });
    });
  });

  return {
    server,
    store,
    dataDir,
    listen(port: number, host: string) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const boundPort = typeof address === 'object' && address ? address.port : port;
          resolve({ port: boundPort, host });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
