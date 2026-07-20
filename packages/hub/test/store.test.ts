import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ArtifactStore } from '../src/store.js';

const LIMITS = { maxBytes: 1024 * 1024, historyKeep: 3 };

let root: string;
let store: ArtifactStore;
let n = 0;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tailhub-store-'));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  n += 1;
  store = new ArtifactStore(path.join(root, `case-${n}`));
});

function input(id: string, payload: unknown, baseRevision: number) {
  return {
    app: 'demo',
    collection: 'items',
    id,
    title: `Item ${id}`,
    payload,
    encryption: null,
    baseRevision,
  };
}

describe('ArtifactStore put/get', () => {
  it('creates at revision 1 and reads back the payload', async () => {
    const result = await store.put(input('a', { x: 1 }, 0), {}, LIMITS);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.record.revision, 1);
    assert.equal(result.created, true);
    assert.ok(result.record.hash?.startsWith('sha256:'));

    const read = await store.get('demo', 'items', 'a');
    assert.deepEqual(read?.payload, { x: 1 });
    assert.equal(read?.deleted, false);
  });

  it('rejects a stale baseRevision with the winning metadata', async () => {
    await store.put(input('a', { x: 1 }, 0), {}, LIMITS);
    await store.put(input('a', { x: 2 }, 1), {}, LIMITS);
    const stale = await store.put(input('a', { x: 99 }, 1), {}, LIMITS);
    assert.ok(!stale.ok);
    if (stale.ok) return;
    assert.equal(stale.reason, 'conflict');
    if (stale.reason !== 'conflict') return;
    assert.equal(stale.remote.revision, 2);
  });

  it('force-writes without a matching baseRevision', async () => {
    await store.put(input('a', { x: 1 }, 0), {}, LIMITS);
    const forced = await store.put(input('a', { x: 7 }, 0), { force: true }, LIMITS);
    assert.ok(forced.ok);
    if (!forced.ok) return;
    assert.equal(forced.record.revision, 2);
  });

  it('enforces the collection size limit', async () => {
    const result = await store.put(
      input('big', 'y'.repeat(200), 0),
      {},
      { maxBytes: 100, historyKeep: 0 }
    );
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.reason, 'too-large');
  });

  it('records device attribution', async () => {
    const result = await store.put(
      input('a', {}, 0),
      { deviceId: 'dev-1', deviceName: 'alans-phone' },
      LIMITS
    );
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.record.deviceName, 'alans-phone');
  });
});

describe('ArtifactStore delete + tombstones', () => {
  it('tombstones with a revision check, then resurrects', async () => {
    await store.put(input('a', { x: 1 }, 0), {}, LIMITS);

    const wrongBase = await store.remove('demo', 'items', 'a', { baseRevision: 5 }, LIMITS);
    assert.ok(!wrongBase.ok);

    const removed = await store.remove('demo', 'items', 'a', { baseRevision: 1 }, LIMITS);
    assert.ok(removed.ok);
    if (!removed.ok) return;
    assert.equal(removed.record.deleted, true);
    assert.equal(removed.record.revision, 2);

    const listed = await store.list('demo', 'items');
    assert.equal(listed.length, 0);
    const withDeleted = await store.list('demo', 'items', { includeDeleted: true });
    assert.equal(withDeleted.length, 1);

    const again = await store.remove('demo', 'items', 'a', { baseRevision: 2 }, LIMITS);
    assert.ok(!again.ok && again.reason === 'not-found');

    // Resurrect: base on the tombstone revision, created flag set again.
    const back = await store.put(input('a', { x: 2 }, 2), {}, LIMITS);
    assert.ok(back.ok);
    if (!back.ok) return;
    assert.equal(back.record.revision, 3);
    assert.equal(back.created, true);
  });
});

describe('ArtifactStore history', () => {
  it('retains the newest historyKeep revisions', async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await store.put(input('a', { v: i }, i), {}, LIMITS);
      assert.ok(result.ok);
    }
    const history = await store.history('demo', 'items', 'a');
    assert.deepEqual(history.map((h) => h.revision), [5, 4, 3]);

    const r4 = await store.historyRevision('demo', 'items', 'a', 4);
    assert.deepEqual(r4?.payload, { v: 3 });
    assert.equal(await store.historyRevision('demo', 'items', 'a', 1), null);
  });

  it('keeps no history when historyKeep is 0', async () => {
    await store.put(input('a', { v: 1 }, 0), {}, { ...LIMITS, historyKeep: 0 });
    assert.deepEqual(await store.history('demo', 'items', 'a'), []);
  });
});

describe('ArtifactStore corruption handling', () => {
  it('quarantines unparseable records during list instead of failing', async () => {
    await store.put(input('good', { ok: true }, 0), {}, LIMITS);
    const dir = path.join(root, `case-${n}`, 'data', 'demo', 'items');
    await fs.writeFile(path.join(dir, 'bad.json'), '{ not json', 'utf8');

    const listed = await store.list('demo', 'items');
    assert.deepEqual(listed.map((m) => m.id), ['good']);

    const names = await fs.readdir(dir);
    assert.ok(names.some((name) => name.includes('.corrupt-')));
    assert.ok(!names.includes('bad.json'));
  });
});

describe('ArtifactStore bundles', () => {
  it('exports live records and tombstones, imports with per-entry conflicts', async () => {
    await store.put(input('a', { v: 1 }, 0), {}, LIMITS);
    await store.put(input('b', { v: 2 }, 0), {}, LIMITS);
    await store.remove('demo', 'items', 'b', { baseRevision: 1 }, LIMITS);

    const bundle = await store.bundle('demo');
    assert.equal(bundle.artifacts.length, 2);
    assert.ok(bundle.artifacts.some((a) => a.deleted));

    const result = await store.putBundle(
      'demo',
      [
        { collection: 'items', id: 'a', title: 'A', payload: { v: 9 }, encryption: null, baseRevision: 0 },
        { collection: 'items', id: 'c', title: 'C', payload: { v: 3 }, encryption: null, baseRevision: 0 },
      ],
      {},
      () => LIMITS
    );
    assert.equal(result.written, 1); // "a" conflicts (hub at r1), "c" is new
    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0] ?? '', /items\/a/);
  });

  it('counts live artifacts only', async () => {
    await store.put(input('a', {}, 0), {}, LIMITS);
    await store.put(input('b', {}, 0), {}, LIMITS);
    await store.remove('demo', 'items', 'b', { baseRevision: 1 }, LIMITS);
    assert.equal(await store.countArtifacts(), 1);
    assert.equal(await store.countArtifacts('demo'), 1);
    assert.equal(await store.countArtifacts('other'), 0);
  });
});
