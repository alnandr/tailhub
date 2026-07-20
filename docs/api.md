# HTTP API reference

Base URL: the hub origin (e.g. `https://desktop.tailnet.ts.net` behind
Tailscale Serve, or `http://127.0.0.1:4747` locally).

## Authentication

Send a bearer token on every `/v1/*` route:

```
Authorization: Bearer <token>        (or X-Tailhub-Token: <token>)
```

Two levels:

- **admin** — the hub token (`tailhub token`). Everything, including manifest
  registration and the hub overview.
- **app** — a token whose SHA-256 digest is in an app's manifest
  (`tailhub apptoken <app>`). That app's routes only.

Optional headers recorded on writes: `X-Tailhub-Device` (stable id),
`X-Tailhub-Device-Name`. When `TAILHUB_TRUST_TAILSCALE_HEADERS=1` and the hub
is fronted by Tailscale Serve, `Tailscale-User-Login` is recorded as
`tailscaleUser`.

Errors are always `{ "error": "<label>", "message": "<human sentence>" }`.

## Routes

### Hub

| Route | Auth | Description |
|---|---|---|
| `GET /health` | none | `{ status, name, version }` liveness. |
| `GET /v1/hub` | admin | `{ apps, artifacts, uptimeSeconds, version, storage }`. |
| `GET /` | none | Admin console (token entered in-page). |
| `GET /sdk/tailhub-client.js` | none | Browser SDK (`index.js`, `browser.js`, `crypto.js` alongside). |

### Apps

| Route | Auth | Description |
|---|---|---|
| `GET /v1/apps` | admin | All manifests (public view — token digests never returned). |
| `GET /v1/apps/:app` | admin or app | This app's manifest (public view). |
| `PUT /v1/apps/:app` | admin | Register/replace the manifest. Body: manifest JSON. |
| `DELETE /v1/apps/:app` | admin | Unregister; stored artifacts are kept on disk. |
| `GET /apps/:app/*` | none | Static app files when the manifest sets `www: true`. |

### Artifacts

| Route | Auth | Description |
|---|---|---|
| `GET /v1/apps/:app/:collection` | admin or app | Metadata list, newest first. `?includeDeleted=1` includes tombstones. |
| `GET /v1/apps/:app/:collection/:id` | admin or app | Latest record. Sends `ETag`; honors `If-None-Match` → `304`. Tombstone → `410` with metadata. |
| `PUT /v1/apps/:app/:collection/:id` | admin or app | Push a revision (below). |
| `DELETE /v1/apps/:app/:collection/:id?baseRevision=N[&force=1]` | admin or app | Write a tombstone revision. |
| `GET /v1/apps/:app/:collection/:id/history` | admin or app | Retained revision metadata, newest first. |
| `GET /v1/apps/:app/:collection/:id/history/:rev` | admin or app | One retained revision in full. |

**Push body**

```json
{
  "title": "Groceries",
  "updatedAt": "2026-07-20T19:16:50.853Z",
  "payload": { "any": "json" },
  "encryption": null,
  "baseRevision": 1,
  "force": false
}
```

Responses: `200 { ok, created, artifact }` (+ `ETag`) · `409` conflict with
`remote` metadata · `413` over the collection's `maxBytes` · `400` policy
violations (e.g. collection requires encryption).

### Bundles (whole-app export / import)

| Route | Auth | Description |
|---|---|---|
| `GET /v1/apps/:app/bundle` | admin or app | `{ format: "tailhub-bundle", version: 1, app, exportedAt, artifacts: [...] }` — tombstones included. |
| `PUT /v1/apps/:app/bundle` | admin or app | `{ artifacts: [...], force? }`. Each entry is revision-checked like a push; with `force`, raw exported records import as-is (disaster restore). Tombstone entries are skipped and listed in `skipped`. Response: `{ ok, written, conflicts, skipped }` (`409` when everything conflicted). |

## Conventions

- Payload limits: per-request cap 25 MiB (`TAILHUB_MAX_REQUEST_BYTES`);
  per-collection `maxBytes` on top.
- CORS: all origins reflected by default (the API is token-authenticated;
  restrict with `TAILHUB_CORS_ORIGINS=https://app1,https://app2`).
- `ETag` format: `"<revision>-<hash prefix>"` — treat it as opaque.
- All timestamps are ISO-8601 UTC strings.
