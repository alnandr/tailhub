# The artifact model

An **artifact** is the unit Tailhub stores and syncs: an opaque JSON payload
plus the metadata that makes multi-device sync safe. Apps define what their
artifacts are; the hub never interprets payloads.

Namespace: `app / collection / id`.

- **app** — `[a-z0-9-]{1,64}`, e.g. `bottomline`, `notes`
- **collection** — same charset, e.g. `portfolios`, `notes` (`bundle` is reserved)
- **id** — `[A-Za-z0-9._-]{1,128}`, no leading dot (UUIDs, slugs)

## App manifests

A hub only accepts artifacts for apps it has a **manifest** for — registering
the manifest *is* configuring the artifact types. Manifests live at
`<dataDir>/apps/<app>.json` and can be managed by hand, via
`PUT /v1/apps/<app>` (admin token), or from the console.

```json
{
  "app": "notes",
  "name": "Tailnotes",
  "description": "Example private notes app",
  "collections": {
    "notes": {
      "maxBytes": 262144,
      "historyKeep": 10,
      "encryption": "optional"
    }
  },
  "tokens": ["<sha256 hex of an app token>"],
  "www": true
}
```

Per-collection policy:

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | hub default (10 MiB) | Max serialized payload size; larger pushes get `413`. |
| `historyKeep` | hub default (20) | Revisions retained per artifact for restore. `0` disables history. |
| `encryption` | `optional` | `none` (reject sealed payloads), `optional`, or `required` (reject plaintext). |

Top-level:

- `tokens` — SHA-256 digests of app-scoped bearer tokens. Raw tokens are never
  stored; mint one with `tailhub apptoken <app>`.
- `www` — serve static files from `<dataDir>/apps/<app>/www/` at
  `/apps/<app>/` so the hub hosts the PWA itself.
- `launchUrl` — absolute `http(s)://` URL to open for apps the hub doesn't
  host (e.g. a PWA published elsewhere on the tailnet, like `bottomline`
  running as its own `tailscale serve`). Ignored when `www` is true, since the
  hub's own hosted URL takes precedence. The URL is stored in normalized form,
  and the API's public manifest view omits `launchUrl` entirely when it is not
  operative (hub-hosted or `kind: "service"`), so clients never need to
  reimplement these precedence rules.
- `kind` — `"app"` (default) or `"service"`. Apps that host files (`www`) or
  declare a `launchUrl` get a **Launch** button in the console; services are
  background/invocable integrations (sync targets, webhooks, headless tools)
  and are never offered for launch, even when they host files.

Removing a manifest (`DELETE /v1/apps/<app>`) stops traffic for the app but
keeps its stored artifacts on disk.

## Artifact records

What the hub stores (and returns from `GET`):

```json
{
  "format": "tailhub-artifact",
  "version": 1,
  "app": "notes",
  "collection": "notes",
  "id": "9b6d…",
  "title": "Groceries",
  "revision": 2,
  "updatedAt": "2026-07-20T19:16:50.853Z",
  "receivedAt": "2026-07-20T19:16:50.853Z",
  "deviceId": "…",
  "deviceName": "alans-phone",
  "tailscaleUser": "alan@github",
  "hash": "sha256:4488…",
  "bytes": 30,
  "deleted": false,
  "encryption": null,
  "payload": { "body": "eggs, coffee, bread" }
}
```

- `title` is app-supplied, human-readable metadata — it stays plaintext even
  for encrypted payloads so lists and the console keep working.
- `updatedAt` is the client's clock (when the data changed); `receivedAt` is
  the hub's clock (when the revision was accepted).
- `hash`/`bytes` describe the stored payload serialization.
- Listing endpoints return **metadata only** (everything above except
  `payload`/`encryption`, plus `encrypted: true|false`).

## Revisions and conflicts

Revisions are per-artifact integers starting at 1. Every push carries
`baseRevision` — the revision the client last saw (0 when creating). If the
hub is ahead, the push is refused:

```
409 { "error": "Conflict", "message": "...", "remote": { ...winning metadata... } }
```

The app decides: pull-and-merge, ask the user, or push again with
`force: true` (which still writes a *new* revision — history is never
rewritten). This is exactly the scheme proven in Bottomline's portfolio sync;
Tailhub adds retained history so even a wrong forced overwrite is recoverable.

## Tombstones

`DELETE` writes a revision with `deleted: true` instead of removing the file,
so other devices observe the deletion instead of re-uploading stale data. A
deleted artifact answers `410 Gone` (with metadata), is hidden from lists
unless `?includeDeleted=1`, and can be resurrected by pushing with
`baseRevision` equal to the tombstone revision.

## History

After every accepted write the hub copies the full record to
`.history/<id>/r<revision>.json` and prunes to `historyKeep`. History powers
the console's per-revision **Restore** (which pushes the old payload as a new
revision) and gives every private app rollback without writing any code.

## End-to-end encryption

The SDK's `sealPayload(payload, passphrase)` produces a ciphertext payload
plus an envelope:

```json
"encryption": {
  "v": 1, "algo": "AES-GCM-256", "kdf": "PBKDF2-SHA-256",
  "iterations": 310000, "salt": "<b64>", "iv": "<b64>"
}
```

The hub stores both verbatim and never sees the passphrase. `openPayload`
reverses it on any device with the same passphrase. Collections can make this
mandatory with `encryption: "required"`.

## On-disk layout

```
~/.tailhub/
  admin-token.txt
  apps/
    notes.json               ← manifest
    notes/www/…              ← hosted app files (www: true)
  data/
    notes/
      notes/
        <id>.json            ← latest revision
        .history/<id>/r000000002.json
```

Writes are atomic (temp file + rename), all store operations serialize through
one lock, and unparseable files are quarantined (renamed `*.corrupt-*`), never
deleted. Plain JSON on your own disk — greppable, backupable, no database.
