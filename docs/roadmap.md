# Roadmap & sustainability

Tailhub's goal is for "private apps on your tailnet" to become a category —
which only happens if people can trust both the software and the project's
future. This page states, up front, what stays free and how the project plans
to sustain itself. The short version: **everything Tailhub does today is MIT
and stays free forever; sustainability will come from a future paid tier of
team-oriented additions, never from moving existing features behind a
paywall.**

## Free forever (the core)

Everything in this repository is MIT-licensed and will remain so — including
every feature that exists today:

- the hub: artifacts, revisions, optimistic concurrency, history + restore,
  tombstones, bundles, app hosting, the admin console
- the client SDK (`@tailhub/client`), including end-to-end encryption
- scoped app tokens and the whole security model
- personal and homelab use at any scale, forever

Features never migrate from free to paid. If a feature ships in the MIT core,
it stays there. (The projects that broke this promise lost their communities;
we intend to keep ours.)

## Near-term open-source roadmap

Deliverability first — making a hub trivial to install and keep running:

- [ ] First npm publish of `tailhub` + `@tailhub/client` (tag-driven release
      automation with provenance is in place; tagging v0.1.0 ships it)
- [x] Docker image build + Tailscale-sidecar compose deployment ([docs](docker.md))
- [x] Start-at-login installers for macOS (launchd), Linux (systemd), and
      Windows (Scheduled Task)
- [ ] Change notifications (SSE) instead of polling
- [ ] Tombstone replay through bundle import
- [ ] Per-user attribution → access rules based on Tailscale identity
- [ ] `tsnet`-style embedding so the hub can join the tailnet as its own node
- [ ] Swift/Kotlin client kits
- [ ] A community directory of app manifests ("private apps" people can adopt)

## Planned paid tier: Tailhub Pro (for teams)

A hub shared by one person's devices is a personal appliance. A hub shared by
a *team* wants things a personal hub doesn't need. Those team features are the
planned paid tier — additions, sold as a separate licensed package, roughly:

- **Roles & per-user access** — Tailscale-identity-based authorization
  (viewer/editor/admin per app), beyond the core's single admin token
- **Audit log** — a durable, exportable record of who changed what, when,
  from which device
- **Aggregate quotas & metrics** — per-app storage budgets, usage stats,
  Prometheus export
- **Multi-hub replication** — a second hub as live backup/failover
- **Extended retention** — time-based and unlimited history policies
- **Priority support**

Pricing is not final; the intent is flat per-hub team pricing (personal use
stays free, forever, on the MIT core). If you'd pay for one of these — or
need something not listed — please open an issue and say so; it directly
shapes what gets built first.
