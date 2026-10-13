# Bikepacking Day Planner

Browser-only web app for planning multi-day bike trips. Open a GPX route and see it on a map with an
elevation profile. Set daily limits (distance, climbing, riding time) and the route is split into
days. Drag the day ends on the map or the profile, and see per-day stats, ride descriptions and
hike-a-bike sections. Import waypoint files (GPX, KML/KMZ, GeoJSON, CSV), manage them, and export
the plan as GPX.

There is no backend: routes, waypoints and settings stay in the user's browser (IndexedDB).

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

## Code layout

- `src/core/`: logic with no UI: GPX parsing, profile metrics (distance, smoothed elevation,
  climbing, time model, hike-a-bike), day splitting, stats, waypoint import, spatial index.
- `src/store.ts`: app state; day ends are stored as track-point indices.
- `src/ui/`: map (MapLibre), elevation profile (uPlot), day strip, waypoint manager.
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

Map data © OpenStreetMap contributors. Hike-a-bike threshold background: CyclingAbout's
[gradient threshold method](https://www.cyclingabout.com/gradient-threshold-steepest-hill/).
