# Bottomline on Tailhub

Bottomline's Tailscale portfolio sync is where Tailhub came from. This manifest
maps its hub onto Tailhub artifacts; `docs/migrating-bottomline.md` has the
full route-by-route mapping and what the app gains from moving (per-revision
history, tombstones, scoped tokens, optional end-to-end encryption).

```
tailhub artifact            bottomline concept
--------------------------  -----------------------------
app       "bottomline"      the app namespace
collection "portfolios"     synced portfolio records
artifact id                 portfolio id
payload                     { model, messages, planning }
title                       portfolio name
baseRevision / revision     same optimistic concurrency
```
