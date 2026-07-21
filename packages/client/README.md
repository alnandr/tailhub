# @tailhub/client

Universal client SDK for a [Tailhub](https://www.npmjs.com/package/tailhub)
artifact sync hub — the self-hosted backend for private, local-first apps on
your Tailscale network. Dependency-free; runs in browsers, Node ≥ 20, and
React Native. Also served by every hub at `/sdk/tailhub-client.js`, so PWAs
can use it without a bundler.

```js
import { TailhubClient, sealPayload } from '@tailhub/client';

const hub = new TailhubClient({
  baseUrl: 'https://desktop.tailnet.ts.net',
  app: 'notes',
  token: appToken,
  deviceName: 'alans-phone',
});

// create / update with conflict safety (409 carries the winning revision)
await hub.push('notes', id, { payload: { body }, baseRevision: 0, title: 'Groceries' });

// cheap polling with ETags
const result = await hub.pull('notes', id, { etag: lastEtag });
if (!result.notModified) render(result.record);

// end-to-end encrypted (hub sees ciphertext only)
const sealed = await sealPayload({ body }, passphrase);
await hub.push('notes', id, { payload: sealed.payload, encryption: sealed.encryption, baseRevision: rev });
```

Entry points:

- `@tailhub/client` — `TailhubClient` (push/pull/list/history/restore/bundles),
  `TailhubError` with conflict metadata, retry helpers, token utilities
- `@tailhub/client/crypto` — `sealPayload`/`openPayload` passphrase E2E
  encryption (PBKDF2 + AES-256-GCM)
- `@tailhub/client/browser` — localStorage plumbing a PWA wants: hub
  URL/token settings, device identity, revision/etag tracking, pending-push
  queue, sync health

Docs, hub setup, and a complete single-file example app:
**[project README](https://github.com/alnandr/tailhub#readme)**. MIT.
