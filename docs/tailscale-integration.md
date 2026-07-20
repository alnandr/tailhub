# Tailscale integration

Tailhub is designed *around* Tailscale rather than merely compatible with it.
This page covers how the pieces fit today, and the path to Tailhub being
something Tailscale could offer its users as a first-class add-on.

## Why this belongs on a tailnet

Tailscale already gives every person a private network of their own devices
with stable names, mutual authentication, WireGuard encryption, and free
automatic HTTPS. What that network lacks is a *reason for normal apps to use
it*: a standard place for personal apps to keep and sync their data.

Tailhub is that missing piece — a small appliance that makes "local-first app
+ your own hub" as easy as "app + someone's cloud":

- **Serve** gives the hub a real HTTPS origin (`https://<device>.<tailnet>.ts.net`)
  — which is exactly what PWAs need for installability, service workers, and
  WebCrypto on phones.
- **MagicDNS** makes hub discovery trivial; the SDK's `suggestHubUrl()`
  defaults to the page origin on `.ts.net` pages, so hosted apps need zero
  configuration.
- **One origin for everything**: because the hub serves the app files, the
  SDK, the API, and the console on one port, a single command publishes a
  complete private app to every device you own:

  ```
  tailscale serve --bg --https=443 http://127.0.0.1:4747
  ```

## Setup today

1. Install Tailscale on the hub machine and your devices; enable MagicDNS and
   HTTPS certificates for the tailnet.
2. `tailhub start` (binds 127.0.0.1:4747 by default).
3. `tailscale serve --bg --https=443 http://127.0.0.1:4747` — or on Windows,
   `scripts/setup-tailscale-https.ps1`, which also verifies MagicDNS, local
   health, and the resulting TLS endpoint, and never resets unrelated Serve
   handlers.
4. Do **not** use Funnel with Tailhub — the hub is for your tailnet, not the
   public internet.

### Identity headers

Tailscale Serve adds `Tailscale-User-Login` / `Tailscale-User-Name` to proxied
requests. With `TAILHUB_TRUST_TAILSCALE_HEADERS=1`, Tailhub records the login
on every revision — "edited on alans-phone by alan@…" in the console — see
[security.md](security.md) for when this is safe to enable.

## What "Tailhub as a Tailscale offering" would look like

Tailscale has shown appetite for turnkey personal services (golink, tsidp,
Taildrop for files). Tailhub extends that pattern from *files* to *structured
app data*. A plausible adoption path, each step useful on its own:

1. **Today — community project.** Self-hosted Node service behind Serve; docs
   and scripts in this repo. Zero Tailscale-side changes needed.
2. **`tsnet` build.** Embed the hub in a Go (or Node + `tsnet`-sidecar)
   binary so the hub joins the tailnet as its *own node* with its own ACL
   identity — `tailhub up --authkey …` on a NAS or Pi, no local Tailscale
   daemon required. ACLs then control which devices can reach the hub at the
   network layer, per app port or tag.
3. **Verified identity.** Inside `tsnet`, the hub resolves the calling node
   and user from the connection itself (`WhoIs`), replacing bearer tokens
   with tailnet identity + per-app grants — the token UX disappears for the
   common case.
4. **A "private apps" directory.** The manifest format is deliberately tiny
   and declarative: a registry of community app manifests (+ hosted `www`
   bundles) would let a Tailscale user pick "Notes", "Recipes", "Finance"
   and have app + storage running on their own hardware in one click.

The artifact model was extracted from a real product (Bottomline) rather than
designed on paper — the conflict flow, tombstones, and history depth are all
answers to problems that actually occurred in daily multi-device use.

*Tailhub is an independent project, not affiliated with Tailscale Inc. If the
name is ever a problem, it will be changed.*
