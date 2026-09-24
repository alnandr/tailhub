# Changelog

All notable changes to Tailhub. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org) (pre-1.0: minor bumps may break).

## [Unreleased]

### Added

- npm publish readiness for `tailhub` and `@tailhub/client` (metadata,
  provenance, prepack build guards) and tag-driven release automation
  (`.github/workflows/release.yml`: npm publish + GitHub Release + GHCR image).
- Docker: multi-stage `Dockerfile` and a Tailscale-sidecar
  `deploy/docker-compose.yml` that preserves the loopback-only security model
  ([docs/docker.md](docs/docker.md)).
- Start-at-login installers for macOS (launchd) and Linux (systemd user unit):
  `scripts/install-hub-startup.sh` / `uninstall-hub-startup.sh`, templates in
  `deploy/`.
- Version discipline: `scripts/check-versions.mjs` (CI-enforced) and
  `scripts/set-version.mjs`.
- Public roadmap + sustainability statement ([docs/roadmap.md](docs/roadmap.md)).
- The Tailhub whitepaper ([WHITEPAPER.md](WHITEPAPER.md)).
- Artifact-bound encryption: `sealPayload(payload, passphrase, { app, collection, id })`
  seals a v2 envelope authenticated with the artifact's address (AES-GCM
  additional data) and an NFC-normalized passphrase; open it with
  `openPayload(record, passphrase, { context })`. `requireBound: true`
  refuses unbound v1 envelopes. v1 data keeps opening. The hub accepts both.
- `DELETE /v1/apps/:app/tokens` (admin) revokes every app token without
  resending the manifest, and the console has a **Revoke all app tokens**
  button and a **Disconnect** button.
- `TailhubNetworkError` for timeouts and unreachable hubs, and `randomId()` in
  `@tailhub/client/browser`.
- Docker images for `linux/arm64` as well as `linux/amd64`.

### Changed

- **Breaking (client):** `TailhubClient.remove()` requires `baseRevision`
  unless `force: true`, and throws before sending a request that the hub would
  reject with 409.
- **Breaking:** Node 22 or later is required (`engines: >=22`); Node 20 reached
  end of life in April 2026 and is no longer tested.
- `isTransientError` / `withRetry` retry only `TailhubNetworkError` and HTTP
  408/425/429/5xx — no longer arbitrary errors such as programmer mistakes.
- `PUT /v1/apps/:app` keeps the stored token digests when the body omits
  `tokens`; sending `tokens` (including `[]`) still replaces them.
- App, collection, and artifact ids may not be Windows device names (`con`,
  `nul`, `com1`, … with any extension).
- `updatedAt` is kept only as a sane ISO 8601 date-time (stored in UTC, at most
  24 h ahead); otherwise the hub's receive time is used. Control characters in
  titles and device fields become spaces.
- Error responses: a corrupt stored artifact returns 422 (after quarantine),
  an id case-collision returns 409, and unexpected errors return a generic 500
  body with details only in the hub log.
- Prerelease tags publish to the npm `next` dist-tag and never move `latest`
  on npm or GHCR.

### Fixed

- `TailhubClient.health()` no longer requires a token.
- `tailhub apptoken` refuses to exceed the 50-token cap instead of writing a
  manifest the hub then ignores.
- Hosted app files can no longer follow a symlink out of `www/`.
- The hub's server errors after startup are logged instead of swallowed;
  `close()` is idempotent and cuts off in-flight requests after a grace period;
  a second Ctrl-C no longer exits with an error; port conflicts print a clear
  message.
- Oversized `Content-Length` bodies get 413 before being read. `HEAD` works for
  the console, SDK, and hosted files, and weak ETags match `If-None-Match`.
- History reads apply the same id-collision check as current reads.
- Writes are fsync-ed (file and directory) so acknowledged writes survive power
  loss, and transient Windows rename failures are retried.
- `/sdk/tailhub-client.js` re-exports `index.js` instead of being a second copy,
  so errors from a `browser.js` client pass `instanceof TailhubError` (the notes
  example's conflict banner never appeared when served from a hub).
- Notes example: a save conflict no longer discards the text being edited
  ("Keep mine" pushed the old text); the service worker caches only successful
  responses.
- The console forgets a token the hub refused and refreshes its counts after
  deletes and restores.
- The Docker image declares `"type": "module"` instead of relying on Node's
  ES module auto-detection.
- `start-hub.sh` / `start-hub.ps1` clean up after a failed health check, and the
  stop scripts only kill processes that are actually the hub.
- `TAILHUB_CORS_ORIGINS` ignores trailing slashes; out-of-range ports fall back
  to the default.

### Security

- On Linux and macOS the data dir is `0700` and every file the hub writes is
  `0600`; existing data dirs and loose token files are tightened at startup.
  `start-hub.sh` and the systemd unit keep logs (which can contain a freshly
  generated admin token) owner-only.
- `openPayload` refuses PBKDF2 iteration counts outside 100,000–2,000,000 and
  wrong-sized salts or IVs, so a hostile hub cannot stall clients.
- The console is served with `frame-ancestors 'none'` / `X-Frame-Options: DENY`,
  and all responses send `X-Content-Type-Options: nosniff`.
- The notes example keeps its passphrase in memory instead of `sessionStorage`,
  and ids come from `getRandomValues` where `randomUUID` is unavailable.
- A startup warning flags admin tokens shorter than 32 characters.

## [0.1.0] - 2026-07

Initial release: artifact model (revisions, optimistic concurrency, history +
restore, tombstones, bundles), app manifests with per-collection policies,
scoped app tokens, optional end-to-end encryption, app hosting + browser SDK
serving, admin console, `tailhub` CLI, Windows/POSIX run scripts. Extracted
and generalized from Bottomline.
