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

Status codes beyond the route-specific ones below:

| Status | When |
|---|---|
| `400` | Invalid name, id, or body (including Windows device names such as `con` or `nul.json`). |
| `401` / `403` | Missing or unknown token / a valid token without the needed scope. |
| `409` | Revision conflict (with `remote` metadata), or `Artifact id collision`: two ids that differ only in case map to one file on a case-insensitive filesystem. |
| `413` | Body over `TAILHUB_MAX_REQUEST_BYTES` (refused from `Content-Length` before reading, and the connection is closed) or over a collection's `maxBytes`. |
| `422` | `Corrupt artifact`: the stored file could not be parsed; it has been quarantined (renamed `*.corrupt-*`), never deleted. |
| `500` | Unexpected server error. The body is always the generic `Unexpected server error.`; details go to the hub's log only. |

`GET` routes for the console, SDK, hosted app files, and `/health` also answer
`HEAD`.

## Routes

### Hub

| Route | Auth | Description |
|---|---|---|
| `GET /health` | none | `{ status, name, version }` liveness. |
| `GET /v1/hub` | admin | `{ apps, artifacts, uptimeSeconds, version, storage }`. |
| `GET /` | none | Admin console (token entered in-page). |
| `GET /sdk/tailhub-client.js` | none | Browser SDK entry point (re-exports `index.js`; `browser.js` and `crypto.js` alongside). |

### Apps

| Route | Auth | Description |
|---|---|---|
| `GET /v1/apps` | admin | All manifests (public view — token digests never returned). |
| `GET /v1/apps/:app` | admin or app | This app's manifest (public view). |
| `PUT /v1/apps/:app` | admin | Register/replace the manifest. Body: manifest JSON. Omitting `tokens` keeps the digests already on disk; sending `tokens` (including `[]`) replaces them. |
| `DELETE /v1/apps/:app` | admin | Unregister; stored artifacts are kept on disk. |
| `DELETE /v1/apps/:app/tokens` | admin | Revoke every app token for the app; the rest of the manifest is kept. Response: `{ ok, revoked, app }`. (Only `DELETE` is routed here, so a collection named `tokens` still lists normally.) |
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

`title` (200 chars) and the device fields (128 chars) are trimmed and capped,
with control characters replaced by spaces. `updatedAt` is kept only when it
is an ISO 8601 date-time no more than 24 hours ahead of the hub's clock, and
is stored in UTC; otherwise the hub's receive time is used, so a client cannot
pin entries to the top of a list with an arbitrary string.

### Bundles (whole-app export / import)

| Route | Auth | Description |
|---|---|---|
| `GET /v1/apps/:app/bundle` | admin or app | `{ format: "tailhub-bundle", version: 1, app, exportedAt, artifacts: [...] }` — tombstones included. |
| `PUT /v1/apps/:app/bundle` | admin or app | `{ artifacts: [...], force? }`. Each entry is revision-checked like a push; with `force`, raw exported records import as-is (disaster restore). Tombstone entries are skipped and listed in `skipped`. Response: `{ ok, written, conflicts, skipped }` (`409` when everything conflicted). |

## Conventions

- Payload limits: per-request cap 25 MiB (`TAILHUB_MAX_REQUEST_BYTES`);
  per-collection `maxBytes` on top.
- CORS: all origins reflected by default (the API is token-authenticated;
  restrict with `TAILHUB_CORS_ORIGINS=https://app1,https://app2`; trailing
  slashes are ignored).
- `ETag` format: `"<revision>-<hash prefix>"` — treat it as opaque.
  `If-None-Match` uses weak comparison, so `W/"…"` validators also match.
- All timestamps are ISO-8601 UTC strings.
