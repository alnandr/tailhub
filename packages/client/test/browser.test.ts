import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createBrowserSyncState, randomId } from '../src/browser.js';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};

let previousStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  store.clear();
  previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true });
});

afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('randomId', () => {
  it('uses getRandomValues when randomUUID is unavailable (insecure context)', () => {
    const own = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      const a = randomId();
      const b = randomId();
      assert.match(a, /^[0-9a-f]{32}$/);
      assert.notEqual(a, b);
    } finally {
      if (own) Object.defineProperty(crypto, 'randomUUID', own);
      else delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
    assert.match(randomId(), /^[0-9a-f-]{36}$/);
  });
});

describe('createBrowserSyncState pending queue', () => {
  it('treats a corrupted (array) pending value as empty', () => {
    store.set('tailhub:notes:pending', JSON.stringify(['a', 'b']));
    const sync = createBrowserSyncState('notes');
    assert.deepEqual(sync.pendingKeys(), []);
    sync.markPending('notes/n1', 'offline');
    assert.deepEqual(sync.pendingKeys(), ['notes/n1']);
    assert.ok(!Array.isArray(JSON.parse(store.get('tailhub:notes:pending') ?? '')));
  });
});
