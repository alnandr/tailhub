/**
 * Browser conveniences for PWAs: localStorage-backed hub settings, per-device
 * identity, revision/etag tracking, a pending-push queue, and sync health —
 * the state a local-first app needs around the core client.
 *
 * All keys are namespaced per app (`tailhub:<app>:*`) so multiple private
 * apps served from the same hub origin never collide.
 */

import { DEFAULT_HUB_PORT, TailhubClient, suggestHubUrl } from './index.js';

export type SyncHealth = {
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastAction: string | null;
};

export type PendingRecord = {
  queuedAt: string;
  lastAttemptAt?: string;
  error?: string;
};

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode, quota) — sync stays manual.
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export type BrowserSyncState = ReturnType<typeof createBrowserSyncState>;

/** Create the localStorage-backed settings/state helper for one app. */
export function createBrowserSyncState(app: string) {
  const ns = (suffix: string) => `tailhub:${app}:${suffix}`;
  const KEY_URL = ns('url');
  const KEY_TOKEN = ns('token');
  const KEY_DEVICE_ID = ns('device-id');
  const KEY_DEVICE_NAME = ns('device-name');
  const KEY_PENDING = ns('pending');
  const KEY_LAST_OK = ns('last-ok');
  const KEY_LAST_ERR_AT = ns('last-error-at');
  const KEY_LAST_ERR_MSG = ns('last-error');
  const KEY_LAST_ACTION = ns('last-action');
  const revKey = (collection: string, id: string) => ns(`rev:${collection}/${id}`);
  const etagKey = (collection: string, id: string) => ns(`etag:${collection}/${id}`);

  function readPending(): Record<string, PendingRecord> {
    try {
      const parsed = JSON.parse(storageGet(KEY_PENDING) ?? '{}') as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, PendingRecord>) : {};
    } catch {
      return {};
    }
  }

  function writePending(pending: Record<string, PendingRecord>): void {
    storageSet(KEY_PENDING, JSON.stringify(pending));
  }

  return {
    app,

    getHubUrl(): string {
      return (storageGet(KEY_URL) ?? '').trim().replace(/\/+$/, '');
    },
    setHubUrl(url: string): void {
      storageSet(KEY_URL, url.trim().replace(/\/+$/, ''));
    },
    getToken(): string {
      return (storageGet(KEY_TOKEN) ?? '').trim();
    },
    setToken(token: string): void {
      storageSet(KEY_TOKEN, token.trim());
    },
    isConfigured(): boolean {
      return Boolean(this.getHubUrl() && this.getToken());
    },
    /** Best-guess hub URL for first-run settings (Tailscale-aware). */
    suggestUrl(port = DEFAULT_HUB_PORT): string | null {
      return suggestHubUrl(port);
    },

    getOrCreateDeviceId(): string {
      let id = storageGet(KEY_DEVICE_ID);
      if (id && id.length >= 8) return id;
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      storageSet(KEY_DEVICE_ID, id);
      return id;
    },
    getDeviceName(): string {
      return (storageGet(KEY_DEVICE_NAME) ?? '').trim();
    },
    setDeviceName(name: string): void {
      storageSet(KEY_DEVICE_NAME, name.trim().slice(0, 64));
    },

    /** Last hub revision this device has seen for an artifact. */
    getRevision(collection: string, id: string): number {
      const value = Number(storageGet(revKey(collection, id)));
      return Number.isInteger(value) && value >= 0 ? value : 0;
    },
    setRevision(collection: string, id: string, revision: number): void {
      storageSet(revKey(collection, id), String(Math.max(0, Math.trunc(revision))));
    },
    getEtag(collection: string, id: string): string | null {
      return storageGet(etagKey(collection, id));
    },
    setEtag(collection: string, id: string, etag: string | null): void {
      if (etag) storageSet(etagKey(collection, id), etag);
      else storageRemove(etagKey(collection, id));
    },

    /** Queue an artifact whose push failed so the app can retry later. */
    markPending(artifactKey: string, error?: string): void {
      const pending = readPending();
      const existing = pending[artifactKey];
      pending[artifactKey] = {
        queuedAt: existing?.queuedAt ?? new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        error: error?.slice(0, 240),
      };
      writePending(pending);
    },
    clearPending(artifactKey: string): void {
      const pending = readPending();
      delete pending[artifactKey];
      writePending(pending);
    },
    pendingKeys(): string[] {
      return Object.keys(readPending());
    },

    recordOk(action: string): void {
      storageSet(KEY_LAST_OK, new Date().toISOString());
      storageSet(KEY_LAST_ACTION, action);
      storageRemove(KEY_LAST_ERR_AT);
      storageRemove(KEY_LAST_ERR_MSG);
    },
    recordError(action: string, message: string): void {
      storageSet(KEY_LAST_ERR_AT, new Date().toISOString());
      storageSet(KEY_LAST_ERR_MSG, message.slice(0, 240));
      storageSet(KEY_LAST_ACTION, action);
    },
    getHealth(): SyncHealth {
      return {
        lastOkAt: storageGet(KEY_LAST_OK),
        lastErrorAt: storageGet(KEY_LAST_ERR_AT),
        lastError: storageGet(KEY_LAST_ERR_MSG),
        lastAction: storageGet(KEY_LAST_ACTION),
      };
    },

    /** Build a TailhubClient from the stored URL/token/device settings. */
    createClient(): TailhubClient {
      const baseUrl = this.getHubUrl();
      const token = this.getToken();
      if (!baseUrl) throw new Error('Set a hub URL first (e.g. https://desktop.tailnet.ts.net).');
      if (!token) throw new Error('Set the hub token first (from the hub admin or app token).');
      return new TailhubClient({
        baseUrl,
        app,
        token,
        deviceId: this.getOrCreateDeviceId(),
        deviceName: this.getDeviceName() || undefined,
      });
    },
  };
}

/** "3m ago" style relative formatting for sync status lines. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m ago`;
  if (sec < 86400) return `${Math.max(1, Math.round(sec / 3600))}h ago`;
  return `${Math.max(1, Math.round(sec / 86400))}d ago`;
}
