# Migrating Bottomline to Tailhub

Bottomline's `apps/api` sync hub is Tailhub's ancestor. This is the mapping
for retiring the bespoke hub and pointing Bottomline's `syncClient.ts` at a
Tailhub instead.

## Concept mapping

| Bottomline | Tailhub |
|---|---|
| the whole API (`/v1/sync/*`) | app `bottomline` (manifest in `examples/bottomline/manifest.json`) |
| portfolio record | artifact in collection `portfolios` |
| portfolio `id` / `name` | artifact `id` / `title` |
| `{ model, messages, planning }` fields | the artifact `payload` (one object) |
| `revision` / `baseRevision` | identical semantics, unchanged |
| `BOTTOMLINE_SYNC_TOKEN` (one shared token) | hub admin token **plus** scoped `tailhub apptoken bottomline` |
| `~/.bottomline-sync/portfolio-<id>.json` | `~/.tailhub/data/bottomline/portfolios/<id>.json` |
| index.json rebuild | not needed (hub lists from records) |
| — (none) | per-revision history (`historyKeep: 20`) |
| hard delete | tombstones (`410`, `includeDeleted`) |
| — (none) | optional end-to-end encryption |

## Route mapping

| Bottomline route | Tailhub route |
|---|---|
| `GET /v1/sync/status` | `GET /health` + `GET /v1/apps/bottomline` |
| `GET /v1/sync/portfolios` | `GET /v1/apps/bottomline/portfolios` |
| `GET /v1/sync/portfolios/:id` | `GET /v1/apps/bottomline/portfolios/:id` |
| `PUT /v1/sync/portfolios/:id` | `PUT /v1/apps/bottomline/portfolios/:id` |
| `DELETE /v1/sync/portfolios/:id` | `DELETE …?baseRevision=N` |
| `GET /v1/sync/bundle` | `GET /v1/apps/bottomline/bundle` |
| `PUT /v1/sync/bundle` | `PUT /v1/apps/bottomline/bundle` |

Body shape change on push: Bottomline sent portfolio fields at the top level
(`name`, `model`, `messages`, `planning`, `deviceId`); Tailhub wraps them —

```json
{
  "title": "<name>",
  "updatedAt": "<updatedAt>",
  "payload": { "model": …, "messages": […], "planning": … },
  "baseRevision": 3
}
```

with the device sent as `X-Tailhub-Device` / `X-Tailhub-Device-Name` headers
(handled automatically by `@tailhub/client`).

## Client migration sketch

`apps/web/src/syncClient.ts` keeps its public surface (pending queue, health,
chips, auto modes) and swaps its transport for `@tailhub/client`:

1. Replace `syncFetch` + the endpoint functions with a `TailhubClient`
   (`app: 'bottomline'`) built from the stored URL/token.
2. `pushSyncPortfolio(entry)` → `hub.push('portfolios', id, { payload, title, baseRevision, updatedAt, force })`; a `TailhubError` with `.conflict` carries
   `remote` exactly like today's 409 body.
3. Revision tracking (`bottomline-sync-revision:*`) maps 1:1 onto
   `createBrowserSyncState('bottomline').setRevision('portfolios', id, rev)`.
4. One-time data move: old hub `GET /v1/sync/bundle` → transform each
   portfolio into a bundle entry (`collection: 'portfolios'`, payload wrap)
   → new hub `PUT /v1/apps/bottomline/bundle` with `force: true` → verify in
   the console → retire the old API process and its Vite proxy (the hub's CORS
   support or same-origin hosting replaces it).

What Bottomline gains immediately: revision history for portfolios (restore
from the console after a bad merge), tombstoned deletes across devices, a
scoped token instead of the do-everything secret, and optional passphrase
sealing for portfolio payloads.
