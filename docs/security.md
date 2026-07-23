# Security model

Tailhub's job is to let personal data cross between *your* devices without
touching anyone else's infrastructure. The design assumes a competent but
personal deployment: one operator, a handful of devices, a private network.

## Trust boundaries

1. **The tailnet is the perimeter.** The recommended deployment binds the hub
   to `127.0.0.1` (the default) and fronts it with `tailscale serve`, so the
   only network path is WireGuard-encrypted traffic from devices you enrolled.
   The hub is never port-forwarded to the internet, and Tailscale **Funnel
   must not be used** with it.
2. **Tokens gate every data route.** Even inside the tailnet, all `/v1/*`
   routes require a bearer token — a shared laptop on your network can load
   the console page but sees no data without one.
3. **Apps are isolated from each other *on the hub*.** App tokens are scoped to
   one app's namespace. Manifests store only SHA-256 digests of tokens; all
   comparisons are digest-vs-digest via `crypto.timingSafeEqual`. This scoping
   is server-side: it limits what a token can *do*, not who can *read* it in a
   browser. Apps the hub hosts are all served from one origin (`/apps/*`) and
   the browser SDK keeps each app's token in `localStorage`, which has no
   per-key isolation within an origin — so a co-hosted app (or an XSS in one)
   can read another co-hosted app's token. Give untrusted apps their own origin
   rather than co-hosting them; do not treat same-origin co-hosting as a
   security boundary.
4. **The hub machine is trusted.** Artifacts are plaintext JSON on its disk
   unless the app seals them. Full-disk encryption and disk backups of
   `~/.tailhub` are the operator's job — the same posture Bottomline
   documented for its sync hub.

## What each party can see

| Party | Sees |
|---|---|
| Tailscale (the company) | Coordination metadata only — never payloads (WireGuard is end-to-end between your nodes; Serve terminates TLS **on your own machine**). |
| Hub disk | Artifact metadata + payloads; ciphertext only where apps seal payloads. |
| Another app on the same hub | Server-side, nothing — a token is scoped to its own app's namespace. But apps **co-hosted on the same origin** (`/apps/*`) share `localStorage`, so a co-hosted app can read another's stored token in the browser; isolate untrusted apps by origin. |
| A tailnet device without a token | `/health`, the console shell, hosted app shells (`/apps/*` static files are public-on-tailnet by design — PWA shells must load before login; never put secrets in static files). |

## End-to-end encryption

For data that should be unreadable even on the hub disk, the SDK seals
payloads client-side: PBKDF2-SHA-256 (310k iterations) → AES-256-GCM, random
salt/IV per write, WebCrypto only. The passphrase never leaves the device.
Collections can set `encryption: "required"` so the hub refuses plaintext.
Artifact **titles stay plaintext** (they are UX metadata) — apps handling
sensitive titles should put them in the payload and push a generic title.

## Identity headers

`Tailscale-User-Login` etc. are ordinary HTTP headers added by Serve. The hub
records them on revisions **only** when `TAILHUB_TRUST_TAILSCALE_HEADERS=1`,
because any client that can reach the hub directly can forge them. Only enable
this when the hub binds to loopback and Serve is the sole path in. Recorded
identity is attribution, not authorization — authorization is tokens.

## Implementation notes

- Zero runtime dependencies — the supply-chain surface is Node itself.
- Hand-validated inputs with strict charsets for `app` / `collection` / `id`;
  path traversal in static hosting is blocked by segment checks plus resolved-
  path containment (covered by tests, including encoded and backslash forms).
- Atomic writes; corrupt files are quarantined, never deleted.
- Request logs contain method/path/status only — never tokens or payloads.
- The admin token file is written with mode `0600` (effective on POSIX). On
  Windows, `start-hub.ps1` sets an owner-only NTFS ACL on the token file and on
  the generated `hub-launch`/`hub-logs` directories (which hold the token in
  cleartext); full-disk protection (BitLocker) remains the operator's job.
- The macOS launchd agent writes its logs to a per-user `0700` directory
  (`~/Library/Logs/com.tailhub.hub/`), not a shared `/tmp` path, because the
  hub prints the generated admin token to stdout on first start.

## Non-goals (v0.1)

Multi-tenant hosting, internet exposure, fine-grained per-user ACLs, and
payload-aware merging are out of scope. The hub is a personal appliance:
one tailnet, one operator, apps that trust their own devices.

## Reporting

Security reports: open a GitHub issue asking for a private contact, or email
the maintainer directly. Please do not publish exploits before a fix ships.
