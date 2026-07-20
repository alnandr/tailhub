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

function intFromEnv(raw: string | undefined, fallback: number, min = 1): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= min ? value : fallback;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const cors = env.TAILHUB_CORS_ORIGINS?.trim();
  const dataDirRaw = env.TAILHUB_DATA_DIR?.trim();
  return {
    port: intFromEnv(env.TAILHUB_PORT, DEFAULT_PORT),
    host: env.TAILHUB_HOST?.trim() || '127.0.0.1',
    dataDir: dataDirRaw ? path.resolve(dataDirRaw) : defaultDataDir(),
    adminToken: env.TAILHUB_TOKEN?.trim() || null,
    maxRequestBytes: intFromEnv(env.TAILHUB_MAX_REQUEST_BYTES, 25 * 1024 * 1024),
    defaultMaxArtifactBytes: intFromEnv(env.TAILHUB_MAX_ARTIFACT_BYTES, 10 * 1024 * 1024),
    defaultHistoryKeep: intFromEnv(env.TAILHUB_HISTORY_KEEP, 20, 0),
    corsOrigins:
      !cors || cors === '*' ? '*' : cors.split(',').map((s) => s.trim()).filter(Boolean),
    trustTailscaleHeaders: env.TAILHUB_TRUST_TAILSCALE_HEADERS === '1',
    quiet: env.TAILHUB_QUIET === '1',
  };
}

export function adminTokenPath(dataDir: string): string {
  return path.join(dataDir, 'admin-token.txt');
}

export type AdminTokenSource = 'env' | 'file' | 'generated';

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
    if (raw) return { token: raw, source: 'file' };
  } catch {
    // fall through to generation
  }
  const token = randomBytes(32).toString('hex');
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return { token, source: 'generated' };
}
