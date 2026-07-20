/**
 * Crash-safe JSON file helpers shared by the artifact store and manifest
 * registry: atomic replace via temp file + rename, and quarantine (rename,
 * never delete) for files that fail to parse.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Move a corrupt file aside so a human can inspect it; never destroys data. */
export async function quarantineFile(file: string): Promise<string> {
  const quarantined = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
  await fs.rename(file, quarantined);
  return quarantined;
}
