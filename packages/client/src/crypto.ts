/**
 * Optional end-to-end encryption for artifact payloads.
 *
 * When an app seals payloads before pushing, the hub only ever stores
 * ciphertext — metadata (title, revision, timestamps, size) stays visible so
 * the hub console and sync logic keep working, but the content itself is
 * unreadable without the passphrase. Uses WebCrypto only: works in browsers,
 * Node >= 22, and React Native with a WebCrypto polyfill.
 *
 * Envelope: PBKDF2-SHA-256 (310k iterations) -> AES-256-GCM over the UTF-8
 * JSON serialization of the payload. Salt 16 bytes, IV 12 bytes, random per
 * seal. The passphrase is never stored or transmitted.
 *
 * Envelope versions:
 *  - v1: no additional authenticated data. A hub can move a v1 ciphertext
 *    onto a different artifact and it still decrypts.
 *  - v2 (sealed when a `context` is passed): the ciphertext is bound to
 *    `app/collection/id` via AES-GCM additional data, and the passphrase is
 *    NFC-normalized so the same visible passphrase derives the same key on
 *    every platform. Open with `requireBound: true` to refuse v1 envelopes,
 *    so a hub cannot downgrade a bound artifact.
 */

import type { EncryptionMeta } from './index.js';

export const PBKDF2_ITERATIONS = 310_000;
/** Envelopes outside this range are refused before any key derivation. */
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
export const ENCRYPTION_ALGO = 'AES-GCM-256';
export const ENCRYPTION_KDF = 'PBKDF2-SHA-256';

const SALT_BYTES = 16;
const IV_BYTES = 12;

export type SealedPayload = {
  encryption: EncryptionMeta;
  /** Base64 ciphertext — push this as the artifact payload. */
  payload: string;
};

/** The artifact a sealed payload belongs to. */
export type SealContext = {
  app: string;
  collection: string;
  id: string;
};

export type OpenOptions = {
  /**
   * The artifact you asked the hub for. Pass it for v2 envelopes; without it
   * the record's own (hub-supplied) app/collection/id are used, which only
   * proves the hub was self-consistent.
   */
  context?: SealContext;
  /** Refuse v1 envelopes (which carry no binding). */
  requireBound?: boolean;
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

function decodeField(value: unknown, name: string, expectedBytes: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    if (typeof value !== 'string') throw new Error('not a string');
    bytes = fromBase64(value);
  } catch {
    throw new Error(`Invalid encryption envelope: ${name} is not base64.`);
  }
  if (bytes.length !== expectedBytes) {
    throw new Error(`Invalid encryption envelope: ${name} must be ${expectedBytes} bytes.`);
  }
  return bytes;
}

function contextAad(context: SealContext): Uint8Array {
  for (const part of [context.app, context.collection, context.id]) {
    if (typeof part !== 'string' || !part || part.includes('\0')) {
      throw new Error('Encryption context needs non-empty app, collection, and id.');
    }
  }
  return encoder.encode(`${context.app}\0${context.collection}\0${context.id}`);
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

/**
 * Seal a payload with a passphrase before pushing it to the hub. Passing the
 * artifact's `context` produces a v2 envelope bound to that artifact.
 */
export async function sealPayload(
  payload: unknown,
  passphrase: string,
  context?: SealContext
): Promise<SealedPayload> {
  if (!passphrase) throw new Error('A passphrase is required to seal a payload.');
  const aad = context ? contextAad(context) : null;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(
    aad ? passphrase.normalize('NFC') : passphrase,
    salt,
    PBKDF2_ITERATIONS
  );
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    aad
      ? { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource }
      : { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  );
  return {
    encryption: {
      v: aad ? 2 : 1,
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
 * records are decrypted and parsed. Throws on a wrong passphrase, a
 * malformed envelope, or (v2) a ciphertext that belongs to another artifact.
 */
export async function openPayload(
  record: {
    encryption?: EncryptionMeta | null;
    payload?: unknown;
    app?: string;
    collection?: string;
    id?: string;
  },
  passphrase?: string,
  options: OpenOptions = {}
): Promise<unknown> {
  const meta = record.encryption;
  if (!meta) return record.payload;
  if ((meta.v !== 1 && meta.v !== 2) || meta.algo !== ENCRYPTION_ALGO || meta.kdf !== ENCRYPTION_KDF) {
    throw new Error(`Unsupported encryption envelope (${meta.algo}/${meta.kdf} v${meta.v}).`);
  }
  if (meta.v === 1 && options.requireBound) {
    throw new Error('This artifact was sealed without an artifact binding (v1) and bound envelopes are required.');
  }
  if (
    !Number.isInteger(meta.iterations) ||
    meta.iterations < MIN_PBKDF2_ITERATIONS ||
    meta.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error(
      `Invalid encryption envelope: iterations must be an integer between ` +
        `${MIN_PBKDF2_ITERATIONS} and ${MAX_PBKDF2_ITERATIONS}.`
    );
  }
  const salt = decodeField(meta.salt, 'salt', SALT_BYTES);
  const iv = decodeField(meta.iv, 'iv', IV_BYTES);
  if (!passphrase) throw new Error('This artifact is end-to-end encrypted — passphrase required.');
  if (typeof record.payload !== 'string') {
    throw new Error('Encrypted artifact payload must be a base64 string.');
  }

  let aad: Uint8Array | null = null;
  if (meta.v === 2) {
    const context =
      options.context ??
      (record.app && record.collection && record.id
        ? { app: record.app, collection: record.collection, id: record.id }
        : undefined);
    if (!context) {
      throw new Error('This artifact is bound to its app/collection/id — pass options.context to open it.');
    }
    aad = contextAad(context);
  }

  let ciphertext: Uint8Array;
  try {
    ciphertext = fromBase64(record.payload);
  } catch {
    throw new Error('Encrypted artifact payload must be a base64 string.');
  }
  const key = await deriveKey(aad ? passphrase.normalize('NFC') : passphrase, salt, meta.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      aad
        ? { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource }
        : { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error(
      aad
        ? 'Could not decrypt artifact — wrong passphrase, corrupted data, or a ciphertext from a different artifact.'
        : 'Could not decrypt artifact — wrong passphrase or corrupted data.'
    );
  }
}
