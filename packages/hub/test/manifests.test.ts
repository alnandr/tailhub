import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { sha256Hex } from '../src/auth.js';
import {
  MAX_APP_TOKENS,
  appendAppTokenDigest,
  loadManifest,
  saveManifest,
  validateManifest,
} from '../src/manifests.js';

let dataDir: string;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tailhub-manifests-'));
});

after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('appendAppTokenDigest', () => {
  it('refuses the digest past the cap and leaves the saved manifest loadable', async () => {
    const tokens = Array.from({ length: MAX_APP_TOKENS }, (_, i) => sha256Hex(`token-${i}`));
    const validated = validateManifest({
      app: 'notes',
      collections: { notes: {} },
      tokens,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    await saveManifest(dataDir, validated.manifest);

    const extra = appendAppTokenDigest(validated.manifest, sha256Hex('one-more'));
    assert.equal(extra.ok, false);
    if (extra.ok) return;
    assert.match(extra.message, new RegExp(String(MAX_APP_TOKENS)));

    const loaded = await loadManifest(dataDir, 'notes');
    assert.equal(loaded?.app, 'notes');
    assert.equal(loaded?.tokens?.length, MAX_APP_TOKENS);
  });

  it('appends a digest under the cap without mutating the input', () => {
    const validated = validateManifest({
      app: 'notes',
      collections: { notes: {} },
      tokens: [sha256Hex('existing')],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const before = validated.manifest.tokens?.length;
    const next = appendAppTokenDigest(validated.manifest, sha256Hex('another'));
    assert.equal(next.ok, true);
    if (!next.ok) return;
    assert.equal(next.manifest.tokens?.length, 2);
    assert.equal(validated.manifest.tokens?.length, before);
    assert.equal(Object.getPrototypeOf(next.manifest.collections), null);
  });
});
