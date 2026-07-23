# Notes for Claude

## The build runs twice in CI — this is deliberate

`npm install` / `npm ci` builds the workspace on its own, via the root
`prepare` script:

```json
"prepare": "npm run build && npm rebuild"
```

CI then runs an explicit `npm run build` step as well, so the build happens
twice per job. That is intentional, not an oversight — don't "optimize" it away
by deleting the explicit step. It costs a few seconds and keeps build failures
surfacing at an obviously-named step instead of inside dependency installation,
where the error is far harder to read.

### Why `prepare` exists at all

`packages/hub` declares `bin: { "tailhub": "dist/cli.js" }`. npm links bin
shims during **tree reification**, which happens *before* lifecycle scripts run.
On a fresh clone `dist/cli.js` does not exist yet, so npm silently skips
creating the shim — no error, just no `tailhub` command. Building on install
fixes that.

### Why `npm rebuild` is part of it

`"prepare": "npm run build"` alone does **not** work. Because prepare runs after
reification, the build lands too late to be linked — verified on a clean clone:
`dist/cli.js` was built and `node_modules/.bin` still had no `tailhub`.
`npm rebuild` relinks bins afterwards, which is what actually creates the shim.
It runs the install lifecycle, not `prepare`, so there is no recursion.

Keep the two halves together. Dropping `npm rebuild` silently reintroduces the
original bug: everything still builds, so it looks fine, and only a fresh clone
reveals the missing command.

## Consequences to remember

- **The Dockerfile must install with `--ignore-scripts`.** It runs `npm ci` at a
  layer holding only the manifests, before `COPY packages ./packages`, for layer
  caching. Without the flag the prepare build runs there with no sources present
  and `tsc` exits 1, breaking the release image.
- **`npm install --ignore-scripts` skips the build.** Anyone using that flag
  needs `npm run build` manually.
