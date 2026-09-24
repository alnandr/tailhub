import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  adminTokenPath,
  loadConfigFromEnv,
  preparePrivateDataDir,
  resolveAdminToken,
  writeAdminTokenFile,
} from '../src/config.js';
import { ArtifactStore } from '../src/store.js';

const POSIX = process.platform !== 'win32';
const posixOnly = { skip: POSIX ? false : 'file modes are POSIX-only' };

let root: string;
let n = 0;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tailhub-config-'));
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function freshDir(): string {
  n += 1;
  return path.join(root, `case-${n}`, 'hub');
}

async function modeOf(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

describe('data dir and admin token permissions', () => {
  it('creates the data dir and a generated token owner-only', posixOnly, async () => {
    const dataDir = freshDir();
    const config = { ...loadConfigFromEnv({}), dataDir, adminToken: null };
    const { source } = await resolveAdminToken(config);
    assert.equal(source, 'generated');
    assert.equal(await modeOf(dataDir), 0o700);
    assert.equal(await modeOf(adminTokenPath(dataDir)), 0o600);
  });

  it('tightens an existing world-readable token file on load', posixOnly, async () => {
    const dataDir = freshDir();
    await fs.mkdir(dataDir, { recursive: true });
    const file = adminTokenPath(dataDir);
    await fs.writeFile(file, 'existing-token-0123456789abcdef0123\n', { mode: 0o644 });
    await fs.chmod(file, 0o644);

    const config = { ...loadConfigFromEnv({}), dataDir, adminToken: null };
    const { token, source } = await resolveAdminToken(config);
    assert.equal(source, 'file');
    assert.equal(token, 'existing-token-0123456789abcdef0123');
    assert.equal(await modeOf(file), 0o600);
  });

  it('rewrites an existing loose token file owner-only on rotate', posixOnly, async () => {
    const dataDir = freshDir();
    await fs.mkdir(dataDir, { recursive: true });
    const file = adminTokenPath(dataDir);
    await fs.writeFile(file, '', { mode: 0o644 });
    await fs.chmod(file, 0o644);
    await writeAdminTokenFile(dataDir, 'rotated-token');
    assert.equal(await modeOf(file), 0o600);
    assert.equal((await fs.readFile(file, 'utf8')).trim(), 'rotated-token');
  });

  it('tightens an existing shared data dir', posixOnly, async () => {
    const dataDir = freshDir();
    await fs.mkdir(dataDir, { recursive: true });
    await fs.chmod(dataDir, 0o755);
    await preparePrivateDataDir(dataDir);
    assert.equal(await modeOf(dataDir), 0o700);
  });

  it('writes artifacts and history owner-only', posixOnly, async () => {
    const dataDir = freshDir();
    const store = new ArtifactStore(dataDir);
    const result = await store.put(
      {
        app: 'demo',
        collection: 'items',
        id: 'a',
        title: 'A',
        payload: { x: 1 },
        encryption: null,
        baseRevision: 0,
      },
      {},
      { maxBytes: 1024, historyKeep: 2 }
    );
    assert.ok(result.ok);
    const collectionDir = path.join(dataDir, 'data', 'demo', 'items');
    assert.equal(await modeOf(collectionDir), 0o700);
    assert.equal(await modeOf(path.join(collectionDir, 'a.json')), 0o600);
    const historyDir = path.join(collectionDir, '.history', 'a');
    assert.equal(await modeOf(historyDir), 0o700);
    const [historyFile] = await fs.readdir(historyDir);
    assert.ok(historyFile);
    assert.equal(await modeOf(path.join(historyDir, historyFile)), 0o600);
  });
});
