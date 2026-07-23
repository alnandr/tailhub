/**
 * @tailhub/client — universal client for a Tailhub artifact sync hub.
 *
 * Works anywhere `fetch` and WebCrypto exist: browsers, Node >= 20, and
 * React Native. Zero dependencies. The hub stores opaque "artifacts" —
 * app-defined JSON payloads with revisions, history, and tombstones — on a
 * machine the user controls, reachable over their Tailscale network.
 */

export const DEFAULT_HUB_PORT = 4747;
export const CLIENT_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Artifact model types (mirrors the hub's wire format)
// ---------------------------------------------------------------------------

/** Envelope describing how an end-to-end encrypted payload was sealed. */
export type EncryptionMeta = {
  v: 1;
  algo: string;
  kdf: string;
  iterations: number;
  /** Base64 salt used by the KDF. */
  salt: string;
  /** Base64 AES-GCM initialization vector. */
  iv: string;
};

/** Metadata for one artifact revision — never contains the payload. */
export type ArtifactMeta = {
  app: string;
  collection: string;
  id: string;
  title: string;
  revision: number;
  /** Client-supplied moment the data changed (device clock). */
  updatedAt: string;
  /** Hub-stamped moment the revision was accepted (hub clock). */
  receivedAt: string;
  deviceId?: string;
  deviceName?: string;
  /** Tailscale identity, recorded when the hub trusts Serve identity headers. */
  tailscaleUser?: string;
  /** `sha256:<hex>` of the stored payload serialization; null for tombstones. */
  hash: string | null;
  bytes: number;
  deleted: boolean;
  encrypted: boolean;
};

/** Full artifact record: metadata plus the payload itself. */
export type ArtifactRecord = ArtifactMeta & {
  encryption: EncryptionMeta | null;
  /** Absent on tombstones. Base64 string when end-to-end encrypted. */
  payload?: unknown;
};

export type CollectionPolicy = {
  maxBytes?: number;
  historyKeep?: number;
  encryption?: 'none' | 'optional' | 'required';
};

/** App manifest — the "artifact configuration" an app registers with a hub. */
export type AppManifest = {
  app: string;
  name?: string;
  description?: string;
  collections: Record<string, CollectionPolicy>;
  /** SHA-256 hex digests of app-scoped bearer tokens. */
  tokens?: string[];
  /** Serve static files for this app from the hub at /apps/<app>/. */
  www?: boolean;
  /** 'app' (default) is launchable when hosted; 'service' is background-only. */
  kind?: 'app' | 'service';
  /**
   * External URL to open for apps the hub doesn't host (`www` false/absent).
   * Ignored when `www` is true; never offered for `kind: 'service'`.
   */
  launchUrl?: string;
};

export type PublicManifest = {
  app: string;
  name?: string;
  description?: string;
  collections: Record<string, CollectionPolicy>;
  www: boolean;
  kind: 'app' | 'service';
  /** Only present when operative — omitted for services and hub-hosted (`www`) apps. */
  launchUrl?: string;
  tokenCount: number;
};

export type ArtifactBundle = {
  format: 'tailhub-bundle';
  version: 1;
  app: string;
  exportedAt: string;
  artifacts: ArtifactRecord[];
};

export type PushResult = {
  ok: true;
  created: boolean;
  artifact: ArtifactMeta;
  etag: string | null;
};

export type PullResult =
  | { notModified: true }
  | { notModified: false; record: ArtifactRecord; etag: string | null };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TailhubError extends Error {
  status: number;
  body: unknown;
  /** Hub-side artifact metadata attached to 409 conflicts and 410 tombstones. */
  remote?: ArtifactMeta;
  constructor(message: string, status: number, body?: unknown, remote?: ArtifactMeta) {
    super(message);
    this.name = 'TailhubError';
    this.status = status;
    this.body = body;
    this.remote = remote;
  }
  get conflict(): boolean {
    return this.status === 409;
  }
  get deleted(): boolean {
    return this.status === 410;
  }
}

/** Network failures and 408/425/429/5xx are worth retrying; 4xx are not. */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof TailhubError)) return error instanceof Error;
  return (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  );
}

/** Retry an operation on transient failures with short fixed backoff. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delaysMs?: number[] } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delays = options.delaysMs ?? [400, 1200];
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientError(error)) throw error;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 1000;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Cryptographically random 32-byte hex token (hub admin or app tokens). */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 hex of a token — the form stored in app manifests. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Suggest a hub URL from the current page location.
 * On an HTTPS *.ts.net page (Tailscale Serve) the hub shares the page origin.
 */
export function suggestHubUrl(port = DEFAULT_HUB_PORT): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const host = window.location.hostname;
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return `http://127.0.0.1:${port}`;
  }
  if (window.location.protocol === 'https:' && host.endsWith('.ts.net')) {
    return window.location.origin;
  }
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  return `${proto}://${host}:${port}`;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function encodePath(...segments: string[]): string {
  return '/' + segments.map((s) => encodeURIComponent(s)).join('/');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type TailhubClientOptions = {
  /** Hub base URL, e.g. https://desktop.tailnet.ts.net or http://100.x.x.x:4747 */
  baseUrl: string;
  /** App name this client is scoped to (lowercase, e.g. "notes"). */
  app: string;
  /** Bearer token: an app token for this app, or the hub admin token. */
  token: string;
  /** Stable per-device identifier recorded on every revision. */
  deviceId?: string;
  /** Human-friendly device label ("alans-phone"). */
  deviceName?: string;
  /** Request timeout in milliseconds (default 20s). */
  timeoutMs?: number;
  /** Custom fetch (tests, React Native polyfills). Defaults to global fetch. */
  fetch?: typeof fetch;
};

export class TailhubClient {
  readonly baseUrl: string;
  readonly app: string;
  private token: string;
  private deviceId?: string;
  private deviceName?: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: TailhubClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.app = options.app;
    this.token = options.token;
    this.deviceId = options.deviceId;
    this.deviceName = options.deviceName;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    // Wrap the global rather than storing a bare reference: browsers throw
    // "Illegal invocation" when fetch is called with a foreign `this`.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    if (!this.baseUrl) throw new Error('Tailhub: baseUrl is required.');
    if (!this.app) throw new Error('Tailhub: app is required.');
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { etag?: string | null; allow304?: boolean } = {}
  ): Promise<{ status: number; data: T; etag: string | null }> {
    if (!this.token) {
      throw new Error('Tailhub: set a token first (app token or hub admin token).');
    }
    const url = `${this.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    if (this.deviceId) headers.set('X-Tailhub-Device', this.deviceId);
    if (this.deviceName) headers.set('X-Tailhub-Device-Name', this.deviceName);
    if (options.etag) headers.set('If-None-Match', options.etag);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
      const etag = res.headers.get('ETag');
      if (res.status === 304 && options.allow304) {
        return { status: 304, data: undefined as T, etag };
      }
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (!res.ok) {
        const bodyObj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
        const message =
          bodyObj && typeof bodyObj.message === 'string'
            ? bodyObj.message
            : bodyObj && typeof bodyObj.error === 'string'
              ? bodyObj.error
              : `Tailhub request failed (${res.status})`;
        const remote =
          bodyObj && bodyObj.remote && typeof bodyObj.remote === 'object'
            ? (bodyObj.remote as ArtifactMeta)
            : bodyObj && bodyObj.artifact && typeof bodyObj.artifact === 'object'
              ? (bodyObj.artifact as ArtifactMeta)
              : undefined;
        throw new TailhubError(message, res.status, data, remote);
      }
      return { status: res.status, data: data as T, etag };
    } catch (err) {
      if (err instanceof TailhubError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Tailhub hub timed out — is it running and reachable over your tailnet?');
      }
      throw err instanceof Error
        ? err
        : Object.assign(new Error('Could not reach the Tailhub hub.'), { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  // -- Hub / app management -------------------------------------------------

  /** Unauthenticated liveness probe. */
  async health(): Promise<{ status: string; name: string; version: string }> {
    const { data } = await this.request<{ status: string; name: string; version: string }>(
      '/health'
    );
    return data;
  }

  /** Hub overview (admin token required). */
  async hubInfo(): Promise<{
    ok: boolean;
    name: string;
    version: string;
    uptimeSeconds: number;
    apps: number;
    artifacts: number;
    storage: string;
  }> {
    const { data } = await this.request<never>('/v1/hub');
    return data;
  }

  /** Register or update this app's manifest (admin token required). */
  async registerApp(manifest: AppManifest): Promise<PublicManifest> {
    const { data } = await this.request<{ ok: boolean; app: PublicManifest }>(
      encodePath('v1', 'apps', manifest.app),
      { method: 'PUT', body: JSON.stringify(manifest) }
    );
    return data.app;
  }

  /** Fetch this app's manifest as the hub sees it (token hashes omitted). */
  async getManifest(): Promise<PublicManifest> {
    const { data } = await this.request<PublicManifest>(encodePath('v1', 'apps', this.app));
    return data;
  }

  // -- Artifacts ------------------------------------------------------------

  async list(
    collection: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<ArtifactMeta[]> {
    const suffix = options.includeDeleted ? '?includeDeleted=1' : '';
    const { data } = await this.request<{ artifacts: ArtifactMeta[] }>(
      encodePath('v1', 'apps', this.app, collection) + suffix
    );
    return data.artifacts ?? [];
  }

  /**
   * Fetch the latest revision. Pass the etag from a previous pull/push to get
   * `{ notModified: true }` (HTTP 304) when nothing changed — cheap polling.
   * Throws TailhubError with `.deleted === true` for tombstoned artifacts.
   */
  async pull(
    collection: string,
    id: string,
    options: { etag?: string | null } = {}
  ): Promise<PullResult> {
    const { status, data, etag } = await this.request<ArtifactRecord>(
      encodePath('v1', 'apps', this.app, collection, id),
      {},
      { etag: options.etag ?? null, allow304: true }
    );
    if (status === 304) return { notModified: true };
    return { notModified: false, record: data, etag };
  }

  /**
   * Push a new revision using optimistic concurrency: `baseRevision` must
   * match the hub's current revision (0 when creating). On mismatch the hub
   * answers 409 and this throws a TailhubError whose `.remote` describes the
   * winning revision so the app can merge or force.
   */
  async push(
    collection: string,
    id: string,
    input: {
      payload: unknown;
      baseRevision: number;
      title?: string;
      updatedAt?: string;
      encryption?: EncryptionMeta | null;
      force?: boolean;
    }
  ): Promise<PushResult> {
    const { data, etag } = await this.request<{
      ok: true;
      created: boolean;
      artifact: ArtifactMeta;
    }>(encodePath('v1', 'apps', this.app, collection, id), {
      method: 'PUT',
      body: JSON.stringify({
        title: input.title,
        updatedAt: input.updatedAt,
        payload: input.payload,
        encryption: input.encryption ?? null,
        baseRevision: input.baseRevision,
        force: input.force === true,
      }),
    });
    return { ...data, etag };
  }

  /** Tombstone an artifact (revision-checked like push unless force). */
  async remove(
    collection: string,
    id: string,
    options: { baseRevision?: number; force?: boolean } = {}
  ): Promise<{ ok: true; artifact: ArtifactMeta }> {
    const params = new URLSearchParams();
    if (options.baseRevision !== undefined) params.set('baseRevision', String(options.baseRevision));
    if (options.force) params.set('force', '1');
    const query = params.toString();
    const { data } = await this.request<{ ok: true; artifact: ArtifactMeta }>(
      encodePath('v1', 'apps', this.app, collection, id) + (query ? `?${query}` : ''),
      { method: 'DELETE' }
    );
    return data;
  }

  /** List retained revisions, newest first (metadata only). */
  async history(collection: string, id: string): Promise<ArtifactMeta[]> {
    const { data } = await this.request<{ revisions: ArtifactMeta[] }>(
      encodePath('v1', 'apps', this.app, collection, id, 'history')
    );
    return data.revisions ?? [];
  }

  /** Fetch one retained revision in full (for restore / diff). */
  async historyRevision(collection: string, id: string, revision: number): Promise<ArtifactRecord> {
    const { data } = await this.request<ArtifactRecord>(
      encodePath('v1', 'apps', this.app, collection, id, 'history', String(revision))
    );
    return data;
  }

  /**
   * Restore a retained revision by pushing its payload as a new revision.
   * History is never rewritten — restore always moves forward.
   */
  async restore(collection: string, id: string, revision: number): Promise<PushResult> {
    const old = await this.historyRevision(collection, id, revision);
    return this.push(collection, id, {
      payload: old.payload,
      encryption: old.encryption,
      title: old.title,
      baseRevision: 0,
      force: true,
    });
  }

  // -- Bundles (whole-app export / import) ----------------------------------

  async pullBundle(): Promise<ArtifactBundle> {
    const { data } = await this.request<ArtifactBundle>(
      encodePath('v1', 'apps', this.app, 'bundle')
    );
    return data;
  }

  async pushBundle(
    artifacts: Array<{
      collection: string;
      id: string;
      title?: string;
      updatedAt?: string;
      payload: unknown;
      encryption?: EncryptionMeta | null;
      baseRevision: number;
    }>,
    options: { force?: boolean } = {}
  ): Promise<{ ok: boolean; written: number; conflicts: string[] }> {
    const { data } = await this.request<{ ok: boolean; written: number; conflicts: string[] }>(
      encodePath('v1', 'apps', this.app, 'bundle'),
      {
        method: 'PUT',
        body: JSON.stringify({ artifacts, force: options.force === true }),
      }
    );
    return data;
  }
}

export { sealPayload, openPayload, PBKDF2_ITERATIONS } from './crypto.js';
export type { SealedPayload } from './crypto.js';
