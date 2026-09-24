/**
 * Hub configuration. Everything comes from environment variables with safe
 * defaults; the admin token can also live in a file under the data dir so a
 * hub restarted by a scheduler keeps its identity without env plumbing.
 *
 * The default bind is loopback: the recommended deployment fronts the hub
 * with `tailscale serve`, which terminates HTTPS on the tailnet and proxies
 * to 127.0.0.1 — the hub is then never directly reachable off-machine.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './fsjson.js';

const POSIX = process.platform !== 'win32';

export const DEFAULT_PORT = 4747;

export type HubConfig = {
  port: number;
  host: string;
  dataDir: string;
  /** Admin token from TAILHUB_TOKEN; null means resolve from file/generate. */
  adminToken: string | null;
  maxRequestBytes: number;
  defaultMaxArtifactBytes: number;
  defaultHistoryKeep: number;
  corsOrigins: '*' | string[];
  trustTailscaleHeaders: boolean;
  quiet: boolean;
};

export function defaultDataDir(): string {
  return path.join(os.homedir(), '.tailhub');
}

function intFromEnv(
  raw: string | undefined,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** Browsers send `Origin` without a trailing slash; match what they send. */
function parseCorsOrigins(raw: string | undefined): '*' | string[] {
  const cors = raw?.trim();
  if (!cors || cors === '*') return '*';
  return cors
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** Generated tokens are 64 hex chars; anything much shorter is guessable. */
export const MIN_RECOMMENDED_ADMIN_TOKEN_LENGTH = 32;

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const dataDirRaw = env.TAILHUB_DATA_DIR?.trim();
  return {
    port: intFromEnv(env.TAILHUB_PORT, DEFAULT_PORT, 1, 65535),
    host: env.TAILHUB_HOST?.trim() || '127.0.0.1',
    dataDir: dataDirRaw ? path.resolve(dataDirRaw) : defaultDataDir(),
    adminToken: env.TAILHUB_TOKEN?.trim() || null,
    maxRequestBytes: intFromEnv(env.TAILHUB_MAX_REQUEST_BYTES, 25 * 1024 * 1024),
    defaultMaxArtifactBytes: intFromEnv(env.TAILHUB_MAX_ARTIFACT_BYTES, 10 * 1024 * 1024),
    defaultHistoryKeep: intFromEnv(env.TAILHUB_HISTORY_KEEP, 20, 0),
    corsOrigins: parseCorsOrigins(env.TAILHUB_CORS_ORIGINS),
    trustTailscaleHeaders: env.TAILHUB_TRUST_TAILSCALE_HEADERS === '1',
    quiet: env.TAILHUB_QUIET === '1',
  };
}

export function adminTokenPath(dataDir: string): string {
  return path.join(dataDir, 'admin-token.txt');
}

export type AdminTokenSource = 'env' | 'file' | 'generated';

/**
 * Create the data dir owner-only and tighten an existing one. Its contents
 * (artifacts, manifests, the admin token) are then unreachable to other local
 * users even when older files inside it were written with looser modes.
 * POSIX only — Windows relies on the ACLs start-hub.ps1 applies.
 */
export async function preparePrivateDataDir(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (!POSIX) return;
  try {
    await fs.chmod(dataDir, PRIVATE_DIR_MODE);
  } catch (error) {
    console.warn(
      `tailhub: could not restrict ${dataDir} to owner-only (${(error as Error).message}). ` +
        'Other local users may be able to read hub data.'
    );
  }
}

/**
 * Write the admin token owner-only. `writeFile`'s mode only applies when the
 * file is created, so an existing file is chmod-ed explicitly as well.
 */
export async function writeAdminTokenFile(dataDir: string, token: string): Promise<void> {
  await preparePrivateDataDir(dataDir);
  const file = adminTokenPath(dataDir);
  await fs.writeFile(file, `${token}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  if (POSIX) await fs.chmod(file, PRIVATE_FILE_MODE);
}

async function tightenTokenFileMode(file: string): Promise<void> {
  if (!POSIX) return;
  try {
    const { mode } = await fs.stat(file);
    if ((mode & 0o077) === 0) return;
    await fs.chmod(file, PRIVATE_FILE_MODE);
    console.warn(
      `tailhub: ${file} was readable by other users (mode ${(mode & 0o777).toString(8)}); ` +
        'restricted it to 0600. Rotate the admin token if other accounts on this machine are untrusted.'
    );
  } catch (error) {
    console.warn(`tailhub: could not check permissions on ${file} (${(error as Error).message}).`);
  }
}

/**
 * Resolve the admin token: env var wins, then the persisted file, otherwise
 * generate a 32-byte token once and save it for future starts.
 */
export async function resolveAdminToken(
  config: HubConfig
): Promise<{ token: string; source: AdminTokenSource }> {
  if (config.adminToken) return { token: config.adminToken, source: 'env' };
  const file = adminTokenPath(config.dataDir);
  try {
    const raw = (await fs.readFile(file, 'utf8')).trim();
    if (raw) {
      await tightenTokenFileMode(file);
      return { token: raw, source: 'file' };
    }
  } catch {
    // fall through to generation
  }
  const token = randomBytes(32).toString('hex');
  await writeAdminTokenFile(config.dataDir, token);
  return { token, source: 'generated' };
}
