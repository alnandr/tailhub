/**
 * File-backed artifact store — the generalization of the portfolio sync store
 * Tailhub grew out of. Data stays on the hub machine's disk; there is no
 * multi-tenant cloud.
 *
 * Guarantees carried over from the original design, now per-artifact:
 *  - every operation is serialized through one async mutex, so revision
 *    checks + writes + history updates behave as one logical transaction;
 *  - writes are atomic (temp file + rename), so a crash never leaves a
 *    half-written artifact;
 *  - unparseable files are quarantined (renamed aside), never deleted;
 *  - optimistic concurrency: a push must name the revision it built on
 *    (baseRevision) and is refused with the winning metadata otherwise.
 *
 * New in the generalization: per-revision history retained on disk for
 * rollback, and tombstones so deletions propagate between devices instead of
 * deleted artifacts silently reappearing from a stale peer.
 *
 * Disk layout:
 *   <dataDir>/data/<app>/<collection>/<id>.json            latest revision
 *   <dataDir>/data/<app>/<collection>/.history/<id>/r000000042.json
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, ensureDir, isNotFound, quarantineFile } from './fsjson.js';
import { sanitizeForFilename } from './ids.js';

export type EncryptionMeta = {
  v: 1;
  algo: string;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
};

export type StoredArtifact = {
  format: 'tailhub-artifact';
  version: 1;
  app: string;
  collection: string;
  id: string;
  title: string;
  revision: number;
  /** Client-supplied change time (device clock). */
  updatedAt: string;
  /** Hub-stamped acceptance time (hub clock). */
  receivedAt: string;
  deviceId?: string;
  deviceName?: string;
  tailscaleUser?: string;
  /** sha256:<hex> of the payload serialization; null on tombstones. */
  hash: string | null;
  bytes: number;
  deleted: boolean;
  encryption: EncryptionMeta | null;
  payload?: unknown;
};

export type ArtifactMeta = Omit<StoredArtifact, 'format' | 'version' | 'encryption' | 'payload'> & {
  encrypted: boolean;
};

export type ArtifactBundle = {
  format: 'tailhub-bundle';
  version: 1;
  app: string;
  exportedAt: string;
  artifacts: StoredArtifact[];
};

export type CollectionLimits = {
  maxBytes: number;
  historyKeep: number;
};

export type WriteContext = {
  force?: boolean;
  deviceId?: string;
  deviceName?: string;
  tailscaleUser?: string;
};

export type PutArtifactInput = {
  app: string;
  collection: string;
  id: string;
  title: string;
  updatedAt?: string;
  payload: unknown;
  encryption: EncryptionMeta | null;
  baseRevision: number;
};

export type PutArtifactResult =
  | { ok: true; record: StoredArtifact; created: boolean }
  | { ok: false; reason: 'conflict'; remote: ArtifactMeta; message: string }
  | { ok: false; reason: 'too-large'; bytes: number; maxBytes: number; message: string };

export type RemoveArtifactResult =
  | { ok: true; record: StoredArtifact }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'conflict'; remote: ArtifactMeta; message: string };

const HISTORY_DIR = '.history';
const HISTORY_FILE_PATTERN = /^r\d{9}\.json$/;

export function toMeta(record: StoredArtifact): ArtifactMeta {
  return {
    app: record.app,
    collection: record.collection,
    id: record.id,
    title: record.title,
    revision: record.revision,
    updatedAt: record.updatedAt,
    receivedAt: record.receivedAt,
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    tailscaleUser: record.tailscaleUser,
    hash: record.hash,
    bytes: record.bytes,
    deleted: record.deleted,
    encrypted: Boolean(record.encryption),
  };
}

function parseStoredArtifact(raw: string, file: string): StoredArtifact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt artifact ${path.basename(file)}: invalid JSON.`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as Record<string, unknown>).format !== 'tailhub-artifact' ||
    (value as Record<string, unknown>).version !== 1
  ) {
    throw new Error(`Corrupt artifact ${path.basename(file)}: not a tailhub-artifact v1 record.`);
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.app !== 'string' ||
    typeof v.collection !== 'string' ||
    typeof v.id !== 'string' ||
    typeof v.title !== 'string' ||
    !Number.isInteger(v.revision) ||
    (v.revision as number) < 1 ||
    typeof v.updatedAt !== 'string' ||
    typeof v.receivedAt !== 'string' ||
    typeof v.deleted !== 'boolean' ||
    !Number.isInteger(v.bytes) ||
    (v.bytes as number) < 0 ||
    (v.hash !== null && typeof v.hash !== 'string') ||
    (v.encryption !== null && typeof v.encryption !== 'object')
  ) {
    throw new Error(`Corrupt artifact ${path.basename(file)}: invalid record shape.`);
  }
  if (!(v.deleted as boolean) && !('payload' in v)) {
    throw new Error(`Corrupt artifact ${path.basename(file)}: live record is missing its payload.`);
  }
  return value as StoredArtifact;
}

export class ArtifactStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  /**
   * Store-wide asynchronous mutex. Reads share the queue too, so a bundle
   * export can never observe an artifact halfway through an update.
   */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private collectionDir(app: string, collection: string): string {
    return path.join(this.dataDir, 'data', app, collection);
  }

  private currentPath(app: string, collection: string, id: string): string {
    return path.join(this.collectionDir(app, collection), `${sanitizeForFilename(id)}.json`);
  }

  private historyDirFor(app: string, collection: string, id: string): string {
    return path.join(this.collectionDir(app, collection), HISTORY_DIR, sanitizeForFilename(id));
  }

  private historyPath(app: string, collection: string, id: string, revision: number): string {
    return path.join(
      this.historyDirFor(app, collection, id),
      `r${String(revision).padStart(9, '0')}.json`
    );
  }

  private async readCurrentUnlocked(
    app: string,
    collection: string,
    id: string
  ): Promise<StoredArtifact | null> {
    const file = this.currentPath(app, collection, id);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    let record: StoredArtifact;
    try {
      record = parseStoredArtifact(raw, file);
    } catch (error) {
      await quarantineFile(file).catch(() => undefined);
      throw error;
    }
    if (record.id !== id) {
      // Do not quarantine: the record may be valid data for a different id
      // (case-twin ids collide on case-insensitive filesystems).
      throw new Error(
        `Artifact file ${path.basename(file)} holds id "${record.id}" but "${id}" was requested — ` +
          'possible id case-collision on a case-insensitive filesystem.'
      );
    }
    return record;
  }

  private async writeHistoryUnlocked(record: StoredArtifact, historyKeep: number): Promise<void> {
    if (historyKeep <= 0) return;
    const dir = this.historyDirFor(record.app, record.collection, record.id);
    await atomicWriteJson(
      this.historyPath(record.app, record.collection, record.id, record.revision),
      record
    );
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const revisions = names.filter((n) => HISTORY_FILE_PATTERN.test(n)).sort();
    while (revisions.length > historyKeep) {
      const oldest = revisions.shift();
      if (!oldest) break;
      await fs.rm(path.join(dir, oldest), { force: true });
    }
  }

  private async listUnlocked(
    app: string,
    collection: string,
    includeDeleted: boolean
  ): Promise<ArtifactMeta[]> {
    const dir = this.collectionDir(app, collection);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const metas: ArtifactMeta[] = [];
    for (const name of names) {
      if (name.startsWith('.') || !name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const record = parseStoredArtifact(await fs.readFile(file, 'utf8'), file);
        if (record.deleted && !includeDeleted) continue;
        metas.push(toMeta(record));
      } catch {
        await quarantineFile(file).catch(() => undefined);
      }
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  private async putUnlocked(
    input: PutArtifactInput,
    context: WriteContext,
    limits: CollectionLimits
  ): Promise<PutArtifactResult> {
    const existing = await this.readCurrentUnlocked(input.app, input.collection, input.id);
    const expected = existing?.revision ?? 0;

    if (context.force !== true && input.baseRevision !== expected) {
      const remote: ArtifactMeta = existing
        ? toMeta(existing)
        : {
            app: input.app,
            collection: input.collection,
            id: input.id,
            title: input.title,
            revision: 0,
            updatedAt: '',
            receivedAt: '',
            hash: null,
            bytes: 0,
            deleted: false,
            encrypted: false,
          };
      return {
        ok: false,
        reason: 'conflict',
        remote,
        message: `Hub revision ${expected} does not match base revision ${input.baseRevision}.`,
      };
    }

    const serialized = JSON.stringify(input.payload ?? null) ?? 'null';
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > limits.maxBytes) {
      return {
        ok: false,
        reason: 'too-large',
        bytes,
        maxBytes: limits.maxBytes,
        message: `Payload is ${bytes} bytes; this collection allows at most ${limits.maxBytes}.`,
      };
    }

    const now = new Date().toISOString();
    const record: StoredArtifact = {
      format: 'tailhub-artifact',
      version: 1,
      app: input.app,
      collection: input.collection,
      id: input.id,
      title: input.title.trim() || 'Untitled',
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: input.updatedAt?.trim() || now,
      receivedAt: now,
      deviceId: context.deviceId,
      deviceName: context.deviceName,
      tailscaleUser: context.tailscaleUser,
      hash: `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`,
      bytes,
      deleted: false,
      encryption: input.encryption,
      payload: input.payload,
    };

    await atomicWriteJson(this.currentPath(input.app, input.collection, input.id), record);
    await this.writeHistoryUnlocked(record, limits.historyKeep);
    return { ok: true, record, created: !existing || existing.deleted };
  }

  // -- Public API (each entry point serializes through the store lock) ------

  async list(
    app: string,
    collection: string,
    options: { includeDeleted?: boolean } = {}
  ): Promise<ArtifactMeta[]> {
    return this.withLock(() => this.listUnlocked(app, collection, options.includeDeleted === true));
  }

  async get(app: string, collection: string, id: string): Promise<StoredArtifact | null> {
    return this.withLock(() => this.readCurrentUnlocked(app, collection, id));
  }

  async put(
    input: PutArtifactInput,
    context: WriteContext,
    limits: CollectionLimits
  ): Promise<PutArtifactResult> {
    return this.withLock(() => this.putUnlocked(input, context, limits));
  }

  async remove(
    app: string,
    collection: string,
    id: string,
    context: WriteContext & { baseRevision?: number },
    limits: CollectionLimits
  ): Promise<RemoveArtifactResult> {
    return this.withLock(async () => {
      const existing = await this.readCurrentUnlocked(app, collection, id);
      if (!existing || existing.deleted) return { ok: false, reason: 'not-found' };
      if (context.force !== true && context.baseRevision !== existing.revision) {
        return {
          ok: false,
          reason: 'conflict',
          remote: toMeta(existing),
          message: `Hub revision ${existing.revision} does not match base revision ${context.baseRevision ?? 0}.`,
        };
      }
      const now = new Date().toISOString();
      const tombstone: StoredArtifact = {
        format: 'tailhub-artifact',
        version: 1,
        app,
        collection,
        id,
        title: existing.title,
        revision: existing.revision + 1,
        updatedAt: now,
        receivedAt: now,
        deviceId: context.deviceId,
        deviceName: context.deviceName,
        tailscaleUser: context.tailscaleUser,
        hash: null,
        bytes: 0,
        deleted: true,
        encryption: null,
      };
      await atomicWriteJson(this.currentPath(app, collection, id), tombstone);
      await this.writeHistoryUnlocked(tombstone, limits.historyKeep);
      return { ok: true, record: tombstone };
    });
  }

  async history(app: string, collection: string, id: string): Promise<ArtifactMeta[]> {
    return this.withLock(async () => {
      const dir = this.historyDirFor(app, collection, id);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const metas: ArtifactMeta[] = [];
      for (const name of names.filter((n) => HISTORY_FILE_PATTERN.test(n)).sort().reverse()) {
        const file = path.join(dir, name);
        try {
          metas.push(toMeta(parseStoredArtifact(await fs.readFile(file, 'utf8'), file)));
        } catch {
          await quarantineFile(file).catch(() => undefined);
        }
      }
      return metas;
    });
  }

  async historyRevision(
    app: string,
    collection: string,
    id: string,
    revision: number
  ): Promise<StoredArtifact | null> {
    return this.withLock(async () => {
      const file = this.historyPath(app, collection, id, revision);
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      try {
        return parseStoredArtifact(raw, file);
      } catch (error) {
        await quarantineFile(file).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Full export of one app, tombstones included. */
  async bundle(app: string): Promise<ArtifactBundle> {
    return this.withLock(async () => {
      const appDir = path.join(this.dataDir, 'data', app);
      let collections: string[] = [];
      try {
        const entries = await fs.readdir(appDir, { withFileTypes: true });
        collections = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .sort();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const artifacts: StoredArtifact[] = [];
      for (const collection of collections) {
        const metas = await this.listUnlocked(app, collection, true);
        for (const meta of metas) {
          const record = await this.readCurrentUnlocked(app, collection, meta.id);
          if (record) artifacts.push(record);
        }
      }
      return {
        format: 'tailhub-bundle',
        version: 1,
        app,
        exportedAt: new Date().toISOString(),
        artifacts,
      };
    });
  }

  /**
   * Bulk import. Each entry goes through the same revision checks as a single
   * push (or force). Tombstone entries are not replayed in v1 — deletions do
   * not propagate through bundle import; they are reported in `conflicts`.
   */
  async putBundle(
    app: string,
    entries: Array<Omit<PutArtifactInput, 'app'>>,
    context: WriteContext,
    limitsFor: (collection: string) => CollectionLimits
  ): Promise<{ written: number; conflicts: string[] }> {
    return this.withLock(async () => {
      let written = 0;
      const conflicts: string[] = [];
      for (const entry of entries) {
        const result = await this.putUnlocked(
          { ...entry, app },
          context,
          limitsFor(entry.collection)
        );
        if (result.ok) written += 1;
        else conflicts.push(`${entry.collection}/${entry.id}: ${result.message}`);
      }
      return { written, conflicts };
    });
  }

  /** Count live (non-tombstone) artifacts, optionally scoped to one app. */
  async countArtifacts(app?: string): Promise<number> {
    return this.withLock(async () => {
      const dataRoot = path.join(this.dataDir, 'data');
      let apps: string[] = [];
      try {
        const entries = await fs.readdir(dataRoot, { withFileTypes: true });
        apps = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (app) apps = apps.filter((a) => a === app);
      let count = 0;
      for (const appName of apps) {
        const appDir = path.join(dataRoot, appName);
        let collections: string[] = [];
        try {
          const entries = await fs.readdir(appDir, { withFileTypes: true });
          collections = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => e.name);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        for (const collection of collections) {
          count += (await this.listUnlocked(appName, collection, false)).length;
        }
      }
      return count;
    });
  }
}
