/**
 * Naming rules for the three levels of the artifact namespace.
 *
 * App and collection names are lowercase DNS-label-ish so they are safe in
 * URLs, filenames, and manifests on every platform. Artifact ids allow the
 * charset apps typically use for UUIDs/slugs. All three are used as path
 * segments on disk, so the patterns deliberately exclude separators, dots at
 * the start, and anything Windows treats specially.
 */

export const APP_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Path segments under /v1/apps/<app>/ that can never be collection names. */
export const RESERVED_COLLECTIONS = new Set(['bundle']);

export function isValidAppName(value: string): boolean {
  return APP_PATTERN.test(value);
}

export function isValidCollectionName(value: string): boolean {
  return COLLECTION_PATTERN.test(value) && !RESERVED_COLLECTIONS.has(value);
}

export function isValidArtifactId(value: string): boolean {
  return ARTIFACT_ID_PATTERN.test(value);
}

/** Defense in depth: ids are already validated, but never trust a filename. */
export function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
