/**
 * Token authentication. Two levels:
 *
 *  - admin: the hub token. Full access, required to register app manifests.
 *  - app:   a token whose SHA-256 digest is listed in an app's manifest.
 *           Grants access to that app's artifacts only.
 *
 * Only digests are compared (constant length) and comparison is timing-safe.
 * App manifests store token digests, never raw tokens, so a disk read leaks
 * nothing directly usable.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AppManifest } from './manifests.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function safeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const header = req.headers['x-tailhub-token'];
  if (typeof header === 'string') return header.trim();
  if (Array.isArray(header) && header[0]) return String(header[0]).trim();
  return undefined;
}

export type AuthResult = { level: 'admin' } | { level: 'app'; app: string } | null;

export function authenticate(
  providedToken: string | undefined,
  adminTokenHash: string,
  manifest: AppManifest | null
): AuthResult {
  if (!providedToken) return null;
  const providedHash = sha256Hex(providedToken);
  if (safeEqualHex(providedHash, adminTokenHash)) return { level: 'admin' };
  if (manifest?.tokens?.length) {
    // Check every digest so timing does not reveal which slot matched.
    let matched = false;
    for (const digest of manifest.tokens) {
      if (safeEqualHex(providedHash, digest)) matched = true;
    }
    if (matched) return { level: 'app', app: manifest.app };
  }
  return null;
}
