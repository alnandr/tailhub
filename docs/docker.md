# Running Tailhub in Docker

The image is published as `ghcr.io/alnandr/tailhub` (also buildable from the
repo's `Dockerfile`). It contains only Node and the hub's compiled `dist/` —
no runtime dependencies — and stores everything under the `/data` volume
(`TAILHUB_DATA_DIR`).

## Recommended: Tailscale sidecar (compose)

The bare-metal deployment binds the hub to `127.0.0.1` and lets
`tailscale serve` terminate HTTPS ([security model](security.md)). The compose
file in [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) reproduces
that exactly in containers:

- a `tailscale/tailscale` sidecar joins your tailnet as its own node
  (hostname `tailhub`, so MagicDNS gives you `https://tailhub.<tailnet>.ts.net`),
- the hub container shares the sidecar's network namespace
  (`network_mode: service:tailscale`) and binds loopback there,
- the sidecar's `TS_SERVE_CONFIG` ([`deploy/tailscale-serve.json`](../deploy/tailscale-serve.json))
  proxies HTTPS 443 → `http://127.0.0.1:4747`.

Nothing is published to the host or the internet; the hub is reachable only
from your tailnet.

```bash
cd deploy
TS_AUTHKEY=tskey-auth-...  docker compose up -d   # key: https://login.tailscale.com/admin/settings/keys
docker compose logs tailhub                        # admin token is printed on first start
```

Because only `tailscale serve` can reach the hub in this topology, the compose
file sets `TAILHUB_TRUST_TAILSCALE_HEADERS=1` so revisions record which
tailnet user wrote them.

## Standalone (hub only, Tailscale on the host)

If Tailscale runs on the Docker host itself, run just the hub and keep the
port bound to the host's loopback:

```bash
docker run -d --name tailhub \
  -p 127.0.0.1:4747:4747 \
  -v tailhub-data:/data \
  ghcr.io/alnandr/tailhub:latest
tailscale serve --bg --https=443 http://127.0.0.1:4747
```

Always publish as `127.0.0.1:4747:4747`, never `-p 4747:4747` — a bare `-p`
binds every interface and exposes the hub beyond your machine, which the
[security model](security.md) forbids.

## Administration

```bash
docker exec tailhub node /app/cli.js token           # show the admin token
docker exec tailhub node /app/cli.js apptoken notes  # mint a scoped app token
```

## Backup and upgrade

All state lives in the `/data` volume — artifacts, manifests, history, and
`admin-token.txt` — as plain JSON files. Back it up by archiving the volume;
upgrade by pulling a newer image and recreating the container with the same
volume:

```bash
docker compose pull && docker compose up -d
```
