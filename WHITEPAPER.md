# Tailhub: Private Apps for Your Tailnet

**A whitepaper on giving personal networks a data layer — so ordinary apps can
run on infrastructure their users own.**

*v1.0 — July 2026 · [Alan Garcia](https://github.com/alnandr) ·
[github.com/alnandr/tailhub](https://github.com/alnandr/tailhub) · MIT*

---

## Abstract

Overlay networks like Tailscale have quietly given millions of people
something that used to belong only to institutions: a private network of
their own devices, with strong identity, encrypted transport, stable names,
and automatic HTTPS. Yet almost no consumer software *uses* it. Applications
still default to a vendor's cloud, because a cloud bundles five things an app
needs — identity, reachability, TLS, **storage**, and distribution — and a
tailnet, out of the box, provides only four. There is no standard place for
an app to *keep things*.

Tailhub is a proposal — and a working, tested implementation — for that
missing piece: a small, self-hosted **artifact hub** that turns any machine
on a tailnet into the sync-and-backup backend for *local-first* applications.
Apps declare what they store in a manifest; the hub stores it as opaque,
revisioned JSON **artifacts** with optimistic concurrency, per-artifact
history, tombstoned deletion, scoped per-app tokens, and optional end-to-end
encryption. The hub also hosts the apps themselves, so one `tailscale serve`
command publishes app, data API, and admin console on a single private HTTPS
origin.

The thesis of this paper: **"local-first app + a hub you own" can be made as
easy as "app + someone's cloud" — and the tailnet is the substrate that
makes it possible.** We describe the model, the security design, what exists
today, how individuals, app developers, and teams can adopt it, and what a
first-class version of this idea could look like inside a platform like
Tailscale.

---

## 1. The missing half of the private internet

Two movements have been converging for a decade without quite meeting.

**Private networking became personal.** WireGuard made modern VPN tunnels
cheap; Tailscale wrapped them in identity (your existing SSO login), NAT
traversal, MagicDNS names, ACLs, and automatic TLS certificates. The result
is that a normal person can now own what amounts to a private internet: every
device they use, reachable by name, over encrypted links, with no ports
exposed to the public network.

**Software became local-first — in theory.** The local-first ideal
([Ink & Switch, 2019](https://www.inkandswitch.com/local-first/)) says your
data should live on your devices, work offline, sync when connected, and
outlive any vendor. The research produced real technology — CRDTs, sync
engines, conflict-free merges — but left a stubbornly practical question
unanswered: **where does the always-on peer run, and who operates it?** In
practice, "local-first" apps still sync through a startup's servers, because
asking users to deploy a backend is a non-starter.

These two movements are each other's missing half. The tailnet *is* the
personal cloud — identity, network, names, TLS, an always-on machine most
enthusiasts already have (a desktop, a NAS, a $150 mini-PC). What it lacks is
a **convention**: a standard endpoint an app can be pointed at, with a data
model strong enough to build real software against. Every app that wants to
sync over a tailnet today must invent storage, revisions, conflict handling,
deletion semantics, tokens, and backup — so none do.

Tailhub is that convention, packaged as one small server.

---

## 2. The artifact model

Tailhub's core design decision is that the hub understands **sync**, not
**apps**. It never interprets application data. Apps get one primitive — the
artifact — with the semantics every syncing app eventually needs, built in
once, correctly.

### Manifests: apps declare, hubs enforce

An app doesn't get raw storage. It registers a **manifest** naming its
collections and each collection's policy; registering the manifest *is* the
configuration:

```json
{
  "app": "notes",
  "name": "Tailnotes",
  "collections": {
    "notes": { "maxBytes": 262144, "historyKeep": 10, "encryption": "optional" }
  },
  "www": true
}
```

### Artifacts: opaque payloads, strong metadata

An artifact is an app-defined JSON payload addressed as
`app / collection / id`, wrapped in metadata the hub *does* understand.
Every artifact gets, for free:

- **Optimistic concurrency.** A push names the revision it built on
  (`baseRevision`); a stale push is refused with the winning revision's
  metadata, so the app can merge or deliberately force. There is no
  last-write-wins data loss, ever.
- **Revision history.** The hub retains the last N revisions per artifact
  for one-click restore. Rollback is the insurance policy that makes people
  trust sync software.
- **Tombstones.** Deletion writes a propagating marker instead of removing
  a row, so a deleted note cannot resurrect from a stale device.
- **Attribution.** Every revision records the writing device, and — when
  fronted by Tailscale Serve — optionally the tailnet identity of the writer.
- **Optional end-to-end encryption.** The client SDK seals payloads with a
  passphrase (PBKDF2 → AES-256-GCM) before they leave the device; the hub
  stores ciphertext, and a collection's policy can *require* it. The hub
  operator does not have to be trusted with plaintext.
- **Scoped tokens.** Each app is granted bearer tokens whose SHA-256 digests
  live in its manifest; a token authenticates for that app's data only. One
  admin token, for the operator, governs the hub. Raw tokens are never
  stored on disk.
- **Bundles.** Whole-app export/import in one call — disaster recovery and
  hub migration as a first-class operation, not a script someone writes
  after losing data.

Deliberately absent: payload-aware merging. CRDTs and domain merges belong in
apps and libraries; the hub's job is to make conflicts *detectable and
recoverable*, not to resolve them. This keeps the hub small, general, and
neutral — the property that lets unrelated apps share one.

### The hub hosts the apps too

A manifest can declare `www: true`, and the hub will serve the app's static
files at `/apps/<app>/` and the browser SDK at `/sdk/tailhub-client.js`. This
matters more than it sounds: it means **one machine, one
`tailscale serve` command** publishes the app, its data API, and the admin
console on a single private HTTPS origin — which is exactly what a PWA needs
to be installable on a phone (real origin, service worker, WebCrypto), with
zero client configuration (`suggestHubUrl()` defaults to the page's origin).

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  phone PWA  │      │ laptop PWA  │      │ native app  │
│ (local data)│      │ (local data)│      │ (local data)│
└──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │    push / pull artifacts over the tailnet │
       └────────────────────┼──────────────────────┘
                            ▼
              https://desktop.your-tailnet.ts.net
              ┌─────────────────────────────────┐
              │          Tailhub hub            │
              │  artifacts · revisions · history│
              │  tombstones · app hosting · SDK │
              │        ~/.tailhub on disk       │
              └─────────────────────────────────┘
```

---

## 3. Architecture and security model

Tailhub is built to be *trustable by inspection*, because it asks to hold
personal data.

- **~1,500 lines of TypeScript, zero runtime dependencies.** The hub uses
  only Node's standard library. There is no framework, no database, no
  dependency tree to audit — the entire server can be read in one sitting.
- **Plain JSON on disk.** Artifacts, manifests, and history live as files
  under `~/.tailhub`. Writes are atomic (temp file + rename); unparseable
  files are quarantined, never deleted; backup is `tar`.
- **The tailnet is the perimeter.** The hub binds `127.0.0.1` by default and
  is published by `tailscale serve`, which terminates HTTPS on the same
  machine. Nothing listens on a public interface; Funnel (public exposure)
  is explicitly unsupported by the security model.
- **Tokens authorize; identity attributes.** Authorization is bearer-token
  based (admin, or per-app scoped tokens, compared timing-safely as
  digests). Tailscale identity headers, when enabled, are *recorded* on
  revisions as attribution — deliberately not used as authorization while
  header forgery is possible for directly-reachable hubs. (Verified
  identity via `WhoIs` is the roadmap's answer; see §6.)
- **E2E encryption bounds operator trust.** For sensitive collections, the
  hub stores only ciphertext. The threat model documents exactly what a hub
  operator, a device thief, and a network observer can and cannot see.
- **No telemetry.** The hub phones home to no one. This is a feature, and
  it is permanent.

The full model, including what is deliberately out of scope (multi-tenancy,
internet exposure, per-user ACLs in v0.1), is in
[`docs/security.md`](docs/security.md).

---

## 4. What exists today

Tailhub v0.1 is not a sketch; it is the generalization of a hub that has been
daily-driven for months as the sync backend of
[Bottomline](docs/migrating-bottomline.md), a local-first personal-finance
PWA used across desktop and phone. The extraction replaced the
portfolio-specific parts with the artifact model and shipped with:

- **The hub** — HTTP API (health, manifests, artifacts, history, bundles,
  static hosting), admin console (register apps, browse artifacts, inspect
  history, restore revisions, launch hosted apps), `tailhub` CLI (start,
  token management, scoped app-token minting).
- **The SDK** — `@tailhub/client`: dependency-free, runs in browsers,
  Node ≥ 20, and React Native; typed errors with conflict metadata; ETag
  polling; retry helpers; `crypto` and `browser` entry points (E2E sealing;
  localStorage plumbing for PWAs). Also served by every hub, so a PWA needs
  no bundler.
- **A complete example** — [Tailnotes](examples/notes): a functioning
  synced, offline-capable, installable, optionally end-to-end-encrypted
  notes app in a single HTML file, including real conflict UI.
- **An install story** — npm (`npm i -g tailhub`, or `npx tailhub`), a
  Docker image with a Tailscale-sidecar compose file that preserves the
  loopback security model, start-at-login installers for macOS (launchd),
  Linux (systemd), and Windows (Scheduled Task), and tag-driven release
  automation with npm provenance.
- **Tests where they matter** — conflict handling, tombstone lifecycle,
  auth scoping, encryption-policy enforcement, corruption quarantine, and
  path-traversal defenses, run in CI on Linux, macOS, and Windows.

Everything above is MIT-licensed and stays that way
([roadmap & pledge](docs/roadmap.md)).

---

## 5. Adoption paths

**For individuals.** Install the hub on any always-on machine
(`npx tailhub`, Docker, or an installer), run one `tailscale serve` command,
and point apps at it. Time-to-running-hub is about two minutes; the console
and the Tailnotes example make the first artifact tangible.

**For app developers — the audience that matters most.** Tailhub's pitch to
a developer of a notes app, a habit tracker, a budget tool, a photo
organizer: *you do not have to run servers, operate a database, build an
account system, or take custody of user data — and you still get sync,
backup, history, and multi-device.* Register a manifest, use the SDK (or the
`/sdk` script tag), and every device the user owns becomes your backend. The
[migration guide](docs/migrating-bottomline.md) documents a real app's move
route-by-route.

**For teams.** A hub shared by a team on a shared tailnet wants roles,
audit, quotas, and replication. Those are roadmapped as a sustainably-priced
paid tier on top of the free core ([details](docs/roadmap.md)) — relevant
here because it means the project intends to fund its own maintenance.

**For the ecosystem.** The endgame is a commons: a public directory of app
manifests — "private apps" anyone can adopt by clicking Register on their own
hub. Each app added makes every hub more valuable; each hub installed widens
the audience for private apps. That flywheel is what could make "private
apps on your tailnet" a *category* rather than a project.

---

## 6. Alignment with the Tailscale platform

Tailhub is an independent project, but it is deliberately built *with* the
platform's grain rather than beside it. The relationship to existing
primitives:

| Tailscale primitive | What it provides | What Tailhub adds on top |
|---|---|---|
| WireGuard + identity | Encrypted transport, SSO-rooted device identity | A reason for ordinary apps to use them |
| MagicDNS + Serve | Stable names, automatic private HTTPS | The application behind the name: storage, sync, hosting |
| **Taildrop** | Ad-hoc file *transfer* between devices | A *store*: revisioned, conflict-safe, queryable, restorable |
| **Services** (`svc:`) | Stable service names, multi-host routing, failover | The stateful service worth naming — a hub behind `svc:tailhub` survives host migration; replicated hubs (roadmap) make it HA |
| **tsidp** | Tailnet-native OIDC identity | The natural issuer for per-user hub access in team deployments |
| **tsnet** | Apps that join the tailnet as first-class nodes | The pattern a future embedded hub follows (`tailhub up --authkey …`) |

None of these primitives store, version, or reconcile application data —
they end at the socket. Tailhub begins there. That is the layer this paper
argues the private-networking stack is missing.

**What a first-class version could look like.** If a platform like Tailscale
adopted the private-apps idea natively, the shape is visible from here:

1. **The hub as a tailnet node** — embedded connectivity (tsnet-style), so
   `tailhub up --authkey …` joins the tailnet directly with no local daemon,
   published as a Service with a stable `svc:` name.
2. **Verified identity replacing tokens** — `WhoIs`-based per-user
   authorization expressed in the tailnet policy file ("alice may read
   `notes`, bob may not"), collapsing Tailhub's token layer into the ACL
   system operators already use.
3. **An app directory** — curated manifests installable in one click, making
   the tailnet client the distribution channel for private apps.
4. **A managed encrypted replica** — optional, ciphertext-only offsite
   backup as the convenience tier that funds the whole thing.

Each step is incremental; the first two are already on Tailhub's public
roadmap as an independent project. The distance between "community project"
and "platform feature" here is short — by design.

---

## 7. Honest limitations

- **One operator, one tailnet.** v0.1 is a personal appliance. Multi-tenant
  hosting is a non-goal; team features are roadmap.
- **Polling, not push.** Clients poll with ETags (cheap, but not instant);
  SSE change notifications are the next protocol addition.
- **JSON payloads only.** Artifacts are JSON documents with size caps —
  the sweet spot is app *state*, not video libraries. (Large-binary
  artifacts are an open design question, not a promise.)
- **Conflicts are surfaced, not resolved.** By design (§2) — apps that want
  automatic merge bring their own CRDT and store its state in the payload.
- **It is not** a package registry, a general object store, or a file-drop
  tool; adjacent tools (Verdaccio, S3, Taildrop) do those jobs. Tailhub's
  niche is *live application data with sync semantics*.

---

## 8. Sustainability, licensing, and an invitation

The core is MIT and the project has published a binding line: everything
shipped in the open-source hub stays free forever; sustainability comes from
future team-oriented additions, never from clawing back the commons
([the pledge](docs/roadmap.md)). The design bet is that trust is the
distribution engine for infrastructure software, and the graveyard of
projects that broke that trust is warning enough.

**To platform builders — Tailscale most of all:** this problem is worth
solving natively, and this codebase is a working, tested, small,
liberally-licensed head start on it. If the ideas here fit your roadmap —
as a community integration, a supported pattern, or a first-party
capability — the maintainer would genuinely welcome that conversation:
collaboration, licensing arrangements, or helping build the first-party
version. Reach out via
[GitHub](https://github.com/alnandr/tailhub/issues) or directly to
[@alnandr](https://github.com/alnandr).

**To everyone else:** run a hub, build a private app against it, and tell us
what broke. The category gets built one app at a time.

---

*Tailhub is an independent open-source project, not affiliated with or
endorsed by Tailscale Inc. Tailscale is a trademark of Tailscale Inc.
Whitepaper and implementation © 2026 Alan Garcia, MIT licensed.*
