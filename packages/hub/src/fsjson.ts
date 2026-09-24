/**
 * Crash-safe JSON file helpers shared by the artifact store and manifest
 * registry: durable atomic replace via fsync + rename, and quarantine
 * (rename, never delete) for files that fail to parse.
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

/** Hub data is personal: directories are owner-only (umask still applies). */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

const WINDOWS = process.platform === 'win32';
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

/**
 * Durable atomic replace: the temp file is fsync-ed before the rename and the
 * directory after it, so a write the hub has acknowledged survives power loss
 * (rename alone only orders the metadata, not the file contents).
 */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temp, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDir(dir);
}

/**
 * On Windows a rename fails with EPERM/EBUSY/EACCES while another process
 * (antivirus, the search indexer, a backup tool) briefly holds the target open.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!WINDOWS || !transient || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Windows cannot open directories for fsync; some filesystems refuse it too. */
async function syncDir(dir: string): Promise<void> {
  if (WINDOWS) return;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // Best effort: the rename itself already succeeded.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Move a corrupt file aside so a human can inspect it; never destroys data. */
export async function quarantineFile(file: string): Promise<string> {
  const quarantined = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
  await fs.rename(file, quarantined);
  return quarantined;
}
