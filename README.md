# Bikepacking Day Planner

Browser-only web app for planning multi-day bike trips. Open a GPX route and see it on a map with an
elevation profile. Set daily limits (distance, climbing, riding time) and the route is split into
days. Drag the day ends on the map or the profile, and see per-day stats, ride descriptions and
hike-a-bike sections. Import waypoint files (GPX, KML/KMZ, GeoJSON, CSV), manage them, and export
the plan as GPX.

Routes, waypoints and settings stay in the user's browser (IndexedDB) unless they share a trip.
Shared trips are end-to-end encrypted: the small sync server (`sync-worker/`) only stores and
relays ciphertext.

## Run locally

    npm install
    npm run dev      # http://localhost:5173
    npm test         # core logic (Vitest)
    npm run build    # static site in dist/

## Deploy

A static site: `npm run build` produces `dist/`. Hosted on Cloudflare Pages and deployed by GitHub
Actions (`.github/workflows/deploy.yml`): every push to `main` runs the tests, builds and runs
`wrangler pages deploy`. The workflow needs two repository secrets: `CLOUDFLARE_API_TOKEN` (a token
with Account → Cloudflare Pages → Edit) and `CLOUDFLARE_ACCOUNT_ID`. Node version comes from `.nvmrc`.
`public/_headers` sets the security headers (Content-Security-Policy and others). If you add a
new external service, add its host to the CSP there.

## Shared trips (Save & share)

- **Links:** the AES-GCM key and the write token live in the link's fragment
  (`#trip=…&k=…&w=…`). They are never sent to the server, which only keeps a SHA-256 hash of the
  write token. A view-only link leaves out `w`.
- **Server:** `sync-worker/` is a Cloudflare Worker with one Durable Object (SQLite) per trip. It
  relays encrypted Yjs updates over a WebSocket, stores them, asks a client for an encrypted
  snapshot after 300 updates, and deletes the trip 90 days after its last write.
- **Deploy:** `.github/workflows/sync-worker.yml` deploys it; the API token needs Workers Scripts →
  Edit as well as Pages. The app finds it through `VITE_SYNC_URL` in `.env.production`; without it
  the Save & share button is hidden.
- **Local:** `npx wrangler dev --config sync-worker/wrangler.jsonc --port 8790 --var
  ALLOWED_ORIGINS:http://localhost:5173` next to `npm run dev`.

## Code layout

- `src/core/`: logic with no UI: GPX parsing, profile metrics (distance, smoothed elevation,
  climbing, time model, hike-a-bike), day splitting, stats, waypoint import, spatial index.
- `src/store.ts`: app state; day ends are stored as track-point indices.
- `src/ui/`: map (MapLibre), elevation profile (uPlot), day strip, waypoint manager.
- `src/sync/`: shared trips: encryption and links, the Yjs binding, the WebSocket client, the session.
- `sync-worker/`: the sync server (Cloudflare Worker + Durable Objects).
- `samples/`: synthetic test tracks and waypoint files (generated, no real data).

## Third-party services and terms

This is a free, non-commercial project. Some of the services below are only free for
non-commercial use.

| Service | Used for | Terms |
|---|---|---|
| [OpenFreeMap](https://openfreemap.org/) | Streets map, fonts | Free, attribution required |
| [OpenTopoMap](https://opentopomap.org/about) | Topo map | CC-BY-SA, fair use |
| [CyclOSM](https://www.cyclosm.org/) (OSM France) | Cycle map | Fair-use tile policy |
| [EOX Sentinel-2 cloudless](https://cloudless.eox.at/) | Satellite imagery | CC BY-NC-SA 4.0, **non-commercial** |
| [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api) | Missing elevation | Free tier **non-commercial**, ~600 points/min |
| [Lucide](https://lucide.dev/) | Icons | ISC |
| [Yjs](https://github.com/yjs/yjs) | Merging shared-trip edits | MIT |
| Cloudflare Workers + Durable Objects | Shared-trip sync server | Workers Free plan |

Map data © OpenStreetMap contributors. Hike-a-bike threshold background: CyclingAbout's
[gradient threshold method](https://www.cyclingabout.com/gradient-threshold-steepest-hill/).
