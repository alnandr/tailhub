/**
 * App manifests — the "artifact configuration" that makes Tailhub universal.
 *
 * An app registers a manifest declaring its artifact collections and the
 * policy for each: size limit, how many revisions of history the hub keeps,
 * and whether payloads must / may / must-not be end-to-end encrypted. The
 * hub refuses artifact traffic for apps or collections it has no manifest
 * for, so a hub only ever stores data it was explicitly configured to hold.
 *
 * Manifests are plain JSON files under <dataDir>/apps/<app>.json — editable
 * by hand, by the CLI, over the admin API, or from the console.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, isNotFound } from './fsjson.js';
import { APP_PATTERN, COLLECTION_PATTERN, RESERVED_COLLECTIONS } from './ids.js';

export type EncryptionPolicy = 'none' | 'optional' | 'required';

export type CollectionPolicy = {
  maxBytes?: number;
  historyKeep?: number;
  encryption?: EncryptionPolicy;
};

export type AppManifest = {
  app: string;
  name?: string;
  description?: string;
  collections: Record<string, CollectionPolicy>;
  /** SHA-256 hex digests of app-scoped bearer tokens (never raw tokens). */
  tokens?: string[];
  /** Serve static files from <dataDir>/apps/<app>/www at /apps/<app>/. */
  www?: boolean;
};

/** Manifest view returned by the API — token digests are never echoed. */
export type PublicManifest = {
  app: string;
  name?: string;
  description?: string;
  collections: Record<string, CollectionPolicy>;
  www: boolean;
  tokenCount: number;
};

const TOKEN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_COLLECTIONS = 100;
const MAX_TOKENS = 50;
const MAX_ARTIFACT_BYTES_CEILING = 1024 * 1024 * 1024; // 1 GiB
const MAX_HISTORY_KEEP = 1000;

export function appsDir(dataDir: string): string {
  return path.join(dataDir, 'apps');
}

export function manifestPath(dataDir: string, app: string): string {
  return path.join(appsDir(dataDir), `${app}.json`);
}

export function wwwDir(dataDir: string, app: string): string {
  return path.join(appsDir(dataDir), app, 'www');
}

export type ManifestValidation =
  | { ok: true; manifest: AppManifest }
  | { ok: false; message: string };

function invalid(message: string): ManifestValidation {
  return { ok: false, message };
}

export function validateManifest(value: unknown, expectedApp?: string): ManifestValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('Manifest must be a JSON object.');
  }
  const raw = value as Record<string, unknown>;

  const app = typeof raw.app === 'string' ? raw.app.trim() : '';
  if (!APP_PATTERN.test(app)) {
    return invalid('Manifest "app" must be 1-64 chars of lowercase a-z, 0-9, or hyphen.');
  }
  if (expectedApp && app !== expectedApp) {
    return invalid(`Manifest app "${app}" does not match the URL app "${expectedApp}".`);
  }

  const manifest: AppManifest = { app, collections: {} };

  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string' || raw.name.length > 120) {
      return invalid('Manifest "name" must be a string of at most 120 chars.');
    }
    manifest.name = raw.name;
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 2000) {
      return invalid('Manifest "description" must be a string of at most 2000 chars.');
    }
    manifest.description = raw.description;
  }

  if (
    typeof raw.collections !== 'object' ||
    raw.collections === null ||
    Array.isArray(raw.collections)
  ) {
    return invalid('Manifest "collections" must be an object of collection policies.');
  }
  const entries = Object.entries(raw.collections as Record<string, unknown>);
  if (entries.length === 0) return invalid('Manifest must declare at least one collection.');
  if (entries.length > MAX_COLLECTIONS) {
    return invalid(`Manifest declares too many collections (max ${MAX_COLLECTIONS}).`);
  }
  for (const [collection, policyRaw] of entries) {
    if (!COLLECTION_PATTERN.test(collection)) {
      return invalid(
        `Collection "${collection}" is invalid — 1-64 chars of lowercase a-z, 0-9, or hyphen.`
      );
    }
    if (RESERVED_COLLECTIONS.has(collection)) {
      return invalid(`Collection name "${collection}" is reserved.`);
    }
    if (typeof policyRaw !== 'object' || policyRaw === null || Array.isArray(policyRaw)) {
      return invalid(`Collection "${collection}" policy must be an object (use {} for defaults).`);
    }
    const p = policyRaw as Record<string, unknown>;
    const policy: CollectionPolicy = {};
    if (p.maxBytes !== undefined) {
      if (
        !Number.isInteger(p.maxBytes) ||
        (p.maxBytes as number) < 1 ||
        (p.maxBytes as number) > MAX_ARTIFACT_BYTES_CEILING
      ) {
        return invalid(`Collection "${collection}" maxBytes must be an integer between 1 and 1 GiB.`);
      }
      policy.maxBytes = p.maxBytes as number;
    }
    if (p.historyKeep !== undefined) {
      if (
        !Number.isInteger(p.historyKeep) ||
        (p.historyKeep as number) < 0 ||
        (p.historyKeep as number) > MAX_HISTORY_KEEP
      ) {
        return invalid(
          `Collection "${collection}" historyKeep must be an integer between 0 and ${MAX_HISTORY_KEEP}.`
        );
      }
      policy.historyKeep = p.historyKeep as number;
    }
    if (p.encryption !== undefined) {
      if (p.encryption !== 'none' && p.encryption !== 'optional' && p.encryption !== 'required') {
        return invalid(
          `Collection "${collection}" encryption must be "none", "optional", or "required".`
        );
      }
      policy.encryption = p.encryption;
    }
    manifest.collections[collection] = policy;
  }

  if (raw.tokens !== undefined) {
    if (!Array.isArray(raw.tokens) || raw.tokens.length > MAX_TOKENS) {
      return invalid(`Manifest "tokens" must be an array of at most ${MAX_TOKENS} digests.`);
    }
    for (const digest of raw.tokens) {
      if (typeof digest !== 'string' || !TOKEN_DIGEST_PATTERN.test(digest)) {
        return invalid(
          'Manifest "tokens" entries must be lowercase SHA-256 hex digests of app tokens.'
        );
      }
    }
    manifest.tokens = raw.tokens as string[];
  }

  if (raw.www !== undefined) {
    if (typeof raw.www !== 'boolean') return invalid('Manifest "www" must be a boolean.');
    manifest.www = raw.www;
  }

  return { ok: true, manifest };
}

export async function loadManifest(dataDir: string, app: string): Promise<AppManifest | null> {
  if (!APP_PATTERN.test(app)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(dataDir, app), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`tailhub: manifest for "${app}" is not valid JSON — treating as unregistered.`);
    return null;
  }
  const result = validateManifest(parsed, app);
  if (!result.ok) {
    console.warn(`tailhub: manifest for "${app}" is invalid (${result.message}) — treating as unregistered.`);
    return null;
  }
  return result.manifest;
}

export async function saveManifest(dataDir: string, manifest: AppManifest): Promise<void> {
  await atomicWriteJson(manifestPath(dataDir, manifest.app), manifest);
}

export async function deleteManifest(dataDir: string, app: string): Promise<boolean> {
  try {
    await fs.unlink(manifestPath(dataDir, app));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function listManifests(dataDir: string): Promise<AppManifest[]> {
  let names: string[];
  try {
    names = await fs.readdir(appsDir(dataDir));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const manifests: AppManifest[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const app = name.slice(0, -'.json'.length);
    if (!APP_PATTERN.test(app)) continue;
    const manifest = await loadManifest(dataDir, app);
    if (manifest) manifests.push(manifest);
  }
  manifests.sort((a, b) => a.app.localeCompare(b.app));
  return manifests;
}

export function publicManifest(manifest: AppManifest): PublicManifest {
  return {
    app: manifest.app,
    name: manifest.name,
    description: manifest.description,
    collections: manifest.collections,
    www: manifest.www === true,
    tokenCount: manifest.tokens?.length ?? 0,
  };
}
