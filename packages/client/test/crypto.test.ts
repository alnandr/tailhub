import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openPayload, sealPayload } from '../src/crypto.js';

describe('sealPayload / openPayload', () => {
  it('round-trips a payload through AES-GCM', async () => {
    const payload = { body: 'private note', tags: ['a', 'b'], n: 42 };
    const sealed = await sealPayload(payload, 'correct horse battery staple');
    assert.equal(sealed.encryption.algo, 'AES-GCM-256');
    assert.equal(typeof sealed.payload, 'string');
    assert.ok(!sealed.payload.includes('private note'));

    const opened = await openPayload(
      { encryption: sealed.encryption, payload: sealed.payload },
      'correct horse battery staple'
    );
    assert.deepEqual(opened, payload);
  });

  it('produces a different ciphertext per seal (random salt/iv)', async () => {
    const a = await sealPayload({ x: 1 }, 'pw');
    const b = await sealPayload({ x: 1 }, 'pw');
    assert.notEqual(a.payload, b.payload);
    assert.notEqual(a.encryption.salt, b.encryption.salt);
  });

  it('rejects a wrong passphrase', async () => {
    const sealed = await sealPayload({ secret: true }, 'right');
    await assert.rejects(
      () => openPayload({ encryption: sealed.encryption, payload: sealed.payload }, 'wrong'),
      /wrong passphrase|corrupted/i
    );
  });

  it('passes plaintext records through untouched', async () => {
    const opened = await openPayload({ encryption: null, payload: { plain: true } });
    assert.deepEqual(opened, { plain: true });
  });

  it('demands a passphrase for sealed records', async () => {
    const sealed = await sealPayload({ s: 1 }, 'pw');
    await assert.rejects(
      () => openPayload({ encryption: sealed.encryption, payload: sealed.payload }),
      /passphrase required/i
    );
  });
});
