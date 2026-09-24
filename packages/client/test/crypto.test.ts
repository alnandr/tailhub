import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  openPayload,
  sealPayload,
} from '../src/crypto.js';

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

describe('envelope validation', () => {
  it('refuses iteration counts outside the allowed range before deriving', async () => {
    const sealed = await sealPayload({ s: 1 }, 'pw');
    for (const iterations of [
      MIN_PBKDF2_ITERATIONS - 1,
      MAX_PBKDF2_ITERATIONS + 1,
      10_000_000,
      310_000.5,
    ]) {
      const started = Date.now();
      await assert.rejects(
        () =>
          openPayload(
            { encryption: { ...sealed.encryption, iterations }, payload: sealed.payload },
            'pw'
          ),
        /iterations/
      );
      assert.ok(Date.now() - started < 500, `took too long for ${iterations}`);
    }
  });

  it('refuses a salt or iv of the wrong size', async () => {
    const sealed = await sealPayload({ s: 1 }, 'pw');
    await assert.rejects(
      () =>
        openPayload(
          { encryption: { ...sealed.encryption, salt: btoa('short') }, payload: sealed.payload },
          'pw'
        ),
      /salt must be 16 bytes/
    );
    await assert.rejects(
      () =>
        openPayload(
          { encryption: { ...sealed.encryption, iv: btoa('x'.repeat(16)) }, payload: sealed.payload },
          'pw'
        ),
      /iv must be 12 bytes/
    );
    await assert.rejects(
      () =>
        openPayload(
          { encryption: { ...sealed.encryption, salt: '***' }, payload: sealed.payload },
          'pw'
        ),
      /salt is not base64/
    );
  });
});

describe('artifact-bound (v2) envelopes', () => {
  const ctx = { app: 'notes', collection: 'notes', id: 'n1' };

  it('seals v2 with a context and opens with the same context', async () => {
    const sealed = await sealPayload({ body: 'bound' }, 'pw', ctx);
    assert.equal(sealed.encryption.v, 2);
    const opened = await openPayload(sealed, 'pw', { context: ctx, requireBound: true });
    assert.deepEqual(opened, { body: 'bound' });
  });

  it('fails when the ciphertext is moved to another artifact', async () => {
    const sealed = await sealPayload({ body: 'bound' }, 'pw', ctx);
    await assert.rejects(
      () => openPayload(sealed, 'pw', { context: { ...ctx, id: 'n2' } }),
      /different artifact/
    );
  });

  it('falls back to the record fields when no context is passed', async () => {
    const sealed = await sealPayload({ body: 'bound' }, 'pw', ctx);
    assert.deepEqual(await openPayload({ ...sealed, ...ctx }, 'pw'), { body: 'bound' });
    await assert.rejects(() => openPayload(sealed, 'pw'), /options\.context/);
  });

  it('keeps opening v1 envelopes unless bound envelopes are required', async () => {
    const legacy = await sealPayload({ body: 'old' }, 'pw');
    assert.equal(legacy.encryption.v, 1);
    assert.deepEqual(await openPayload(legacy, 'pw', { context: ctx }), { body: 'old' });
    await assert.rejects(
      () => openPayload(legacy, 'pw', { context: ctx, requireBound: true }),
      /bound envelopes are required/
    );
  });

  it('normalizes v2 passphrases to NFC so composed and decomposed forms match', async () => {
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    const sealed = await sealPayload({ body: 'nfc' }, composed, ctx);
    assert.deepEqual(await openPayload(sealed, decomposed, { context: ctx }), { body: 'nfc' });
  });
});
