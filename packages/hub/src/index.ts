/**
 * Public API for embedding a Tailhub hub in another Node process.
 * Most deployments use the CLI (`tailhub start`) instead.
 */

export { createHub } from './http.js';
export type { Hub, HubOptions } from './http.js';
export { ArtifactStore, toMeta } from './store.js';
export type {
  ArtifactBundle,
  ArtifactMeta,
  CollectionLimits,
  EncryptionMeta,
  PutArtifactInput,
  PutArtifactResult,
  RemoveArtifactResult,
  StoredArtifact,
  WriteContext,
} from './store.js';
export {
  deleteManifest,
  listManifests,
  loadManifest,
  publicManifest,
  saveManifest,
  validateManifest,
} from './manifests.js';
export type { AppManifest, CollectionPolicy, EncryptionPolicy, PublicManifest } from './manifests.js';
export { authenticate, extractToken, sha256Hex } from './auth.js';
export {
  DEFAULT_PORT,
  adminTokenPath,
  defaultDataDir,
  loadConfigFromEnv,
  resolveAdminToken,
} from './config.js';
export type { HubConfig } from './config.js';
export { TAILHUB_NAME, TAILHUB_VERSION } from './version.js';
