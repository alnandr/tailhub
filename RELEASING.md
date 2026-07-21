# Releasing Tailhub

Releases are tag-driven: pushing a `v*` tag publishes both npm packages (with
provenance), creates a GitHub Release, and pushes the Docker image to GHCR
(`.github/workflows/release.yml`).

## One-time setup (before the first release)

1. **GitHub repo**: done — the repository lives at
   `github.com/alnandr/tailhub`, and that owner is baked into the package.json
   `repository`/`homepage`/`bugs` fields, README links, docs, and deploy
   files. (npm provenance requires those `repository` URLs to match the repo
   that runs the workflow — if the repo ever moves, update them together.)
2. **npm account/org**: the hub publishes as unscoped `tailhub` (name is
   free as of 2026-07). The client is `@tailhub/client`, which requires
   creating the free npm **org named `tailhub`** — do that at
   npmjs.com → Add Organization. If the org name turns out to be taken,
   rename the client package to `tailhub-client` (verified free) and update
   the release workflow + imports in docs.
3. **`NPM_TOKEN` secret**: create an npm *granular access token* with
   read/write on both packages (or the org), and add it as a repository
   secret named `NPM_TOKEN`.
4. Docker images publish to `ghcr.io/alnandr/tailhub` using the built-in
   `GITHUB_TOKEN` — no extra setup, but make the package public afterwards
   (GitHub → Packages → tailhub → settings).

## Every release

```bash
node scripts/set-version.mjs 0.2.0   # updates all five version locations
npm install                          # refresh package-lock.json
# update CHANGELOG.md: move Unreleased → [0.2.0]
npm run check-versions && npm run build && npm test
git commit -am "Release v0.2.0"
git tag v0.2.0
git push && git push --tags          # ← this triggers the release workflow
```

The workflow re-verifies that the tag matches every version constant
(`scripts/check-versions.mjs v0.2.0`), builds, tests, then publishes
`@tailhub/client` before `tailhub` (the hub bundles the client's built SDK).

## Verifying a release

- `npm view tailhub version` / `npm view @tailhub/client version`
- `npx tailhub@latest --version`
- `docker run --rm ghcr.io/alnandr/tailhub:latest --version`
- The GitHub Release page has auto-generated notes; tidy them if needed.
