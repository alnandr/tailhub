# Tailnotes — example private app

A single-file notes PWA that stores every note as a Tailhub artifact. It
demonstrates the full private-app loop in ~400 lines with no build step:

- loads the SDK straight from the hub (`/sdk/tailhub-client.js`)
- pushes with `baseRevision` and shows a real conflict banner (edit the same
  note on two devices to see it)
- optional end-to-end sealing with a passphrase (`/sdk/crypto.js`) — the hub
  then stores ciphertext only
- installable (web manifest + a tiny service worker for the offline shell)

## Install onto a hub

```powershell
# from the repo root, with the hub running
$token = node packages/hub/dist/cli.js token
$dataDir = "$HOME\.tailhub"

# 1. register the manifest
Invoke-RestMethod -Method Put -Uri http://127.0.0.1:4747/v1/apps/notes `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' -Body (Get-Content examples/notes/manifest.json -Raw)

# 2. copy the app files where the hub serves them
New-Item -ItemType Directory -Force "$dataDir\apps\notes\www" | Out-Null
Copy-Item examples/notes/www/* "$dataDir\apps\notes\www\" -Recurse -Force

# 3. mint a scoped token for the app
node packages/hub/dist/cli.js apptoken notes
```

Open `http://127.0.0.1:4747/apps/notes/` (or `https://<device>.<tailnet>.ts.net/apps/notes/`
once Tailscale Serve is set up), paste the app token into Settings, and write a
note. Open the same URL on your phone — same note.

A real production app would additionally keep its own local store (IndexedDB)
and sync in the background; Tailnotes stays intentionally small and reads the
hub directly.
