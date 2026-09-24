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

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Windows maps these names to devices whatever their extension ("con",
 * "NUL.json", "com1.backup"), so they can never be files. Refused on every
 * platform so data stays portable between hubs via bundles.
 */
export function isWindowsDeviceName(segment: string): boolean {
  return WINDOWS_DEVICE_NAME.test(segment.split('.')[0] ?? '');
}

export function isValidAppName(value: string): boolean {
  return APP_PATTERN.test(value) && !isWindowsDeviceName(value);
}

export function isValidCollectionName(value: string): boolean {
  return (
    COLLECTION_PATTERN.test(value) && !RESERVED_COLLECTIONS.has(value) && !isWindowsDeviceName(value)
  );
}

export function isValidArtifactId(value: string): boolean {
  return ARTIFACT_ID_PATTERN.test(value) && !isWindowsDeviceName(value);
}

/** Defense in depth: ids are already validated, but never trust a filename. */
export function sanitizeForFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
