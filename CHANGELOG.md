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

## [0.1.0] - 2026-07

Initial release: artifact model (revisions, optimistic concurrency, history +
restore, tombstones, bundles), app manifests with per-collection policies,
scoped app tokens, optional end-to-end encryption, app hosting + browser SDK
serving, admin console, `tailhub` CLI, Windows/POSIX run scripts. Extracted
and generalized from Bottomline.
