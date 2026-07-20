/**
 * Optional end-to-end encryption for artifact payloads.
 *
 * When an app seals payloads before pushing, the hub only ever stores
 * ciphertext — metadata (title, revision, timestamps, size) stays visible so
 * the hub console and sync logic keep working, but the content itself is
 * unreadable without the passphrase. Uses WebCrypto only: works in browsers,
 * Node >= 20, and React Native with a WebCrypto polyfill.
 *
 * Envelope: PBKDF2-SHA-256 (310k iterations) -> AES-256-GCM over the UTF-8
 * JSON serialization of the payload. Salt 16 bytes, IV 12 bytes, random per
 * seal. The passphrase is never stored or transmitted.
 */

import type { EncryptionMeta } from './index.js';

export const PBKDF2_ITERATIONS = 310_000;
export const ENCRYPTION_ALGO = 'AES-GCM-256';
export const ENCRYPTION_KDF = 'PBKDF2-SHA-256';

export type SealedPayload = {
  encryption: EncryptionMeta;
  /** Base64 ciphertext — push this as the artifact payload. */
  payload: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Seal a payload with a passphrase before pushing it to the hub. */
export async function sealPayload(payload: unknown, passphrase: string): Promise<SealedPayload> {
  if (!passphrase) throw new Error('A passphrase is required to seal a payload.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  );
  return {
    encryption: {
      v: 1,
      algo: ENCRYPTION_ALGO,
      kdf: ENCRYPTION_KDF,
      iterations: PBKDF2_ITERATIONS,
      salt: toBase64(salt),
      iv: toBase64(iv),
    },
    payload: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Open a pulled artifact. Plaintext records pass through unchanged; sealed
 * records are decrypted and parsed. Throws on a wrong passphrase.
 */
export async function openPayload(
  record: { encryption?: EncryptionMeta | null; payload?: unknown },
  passphrase?: string
): Promise<unknown> {
  const meta = record.encryption;
  if (!meta) return record.payload;
  if (meta.v !== 1 || meta.algo !== ENCRYPTION_ALGO || meta.kdf !== ENCRYPTION_KDF) {
    throw new Error(`Unsupported encryption envelope (${meta.algo}/${meta.kdf} v${meta.v}).`);
  }
  if (!passphrase) throw new Error('This artifact is end-to-end encrypted — passphrase required.');
  if (typeof record.payload !== 'string') {
    throw new Error('Encrypted artifact payload must be a base64 string.');
  }
  const key = await deriveKey(passphrase, fromBase64(meta.salt), meta.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(meta.iv) as BufferSource },
      key,
      fromBase64(record.payload) as BufferSource
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('Could not decrypt artifact — wrong passphrase or corrupted data.');
  }
}
