# tailhub

**Private apps for your tailnet.** Tailhub turns any machine on your
[Tailscale](https://tailscale.com) network into a backup and sync hub for
local-first apps — apps whose data lives on your devices, not in a vendor's
cloud. Zero runtime dependencies; everything stored as plain JSON on your own
disk.

```bash
npm install -g tailhub
tailhub start
#   tailhub v0.1.0
#   Listening: http://127.0.0.1:4747
#   Admin token (generated now, shown once — also saved to the token file): ...

# expose to every device you own (once, with MagicDNS on):
tailscale serve --bg --https=443 http://127.0.0.1:4747
```

Open `https://<device>.<tailnet>.ts.net/` for the admin console. Apps register
a **manifest** declaring their collections, then push/pull **artifacts** —
opaque revisioned JSON payloads with optimistic concurrency, revision history
+ restore, tombstoned deletes, per-app scoped tokens, and optional end-to-end
encryption. The hub can also host the apps themselves (`/apps/<app>/`) and
serves the browser SDK at `/sdk/tailhub-client.js`.

```bash
tailhub help              # commands + all TAILHUB_* environment variables
tailhub token             # show the admin token
tailhub apptoken <app>    # mint a scoped token for a registered app
```

Client SDK: [`@tailhub/client`](https://www.npmjs.com/package/@tailhub/client).
Docker, service installers, security model, API reference, and the full story:
**[project README & docs](https://github.com/alnandr/tailhub#readme)**.

Independent open-source project, not affiliated with or endorsed by
Tailscale Inc. MIT.
