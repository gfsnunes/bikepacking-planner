/** Shared MapLibre setup for the main map and the crop overlay: worker URL, basemaps, bounds. */
import * as maplibregl from 'maplibre-gl';
import type { LngLatBoundsLike, StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre 6 derives its worker URL from its own module URL, which Vite's bundling breaks.
maplibregl.setWorkerUrl(workerUrl);

// Font source for our own labels (waypoint cluster counts) on the raster basemaps.
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

function raster(tiles: string[], attribution: string, maxzoom: number): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { base: { type: 'raster', tiles, tileSize: 256, maxzoom, attribution } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

const abc = (url: string) => ['a', 'b', 'c'].map((s) => url.replace('{s}', s));

// Terms checked 2026-09-27: OpenFreeMap (free, attribution), OpenTopoMap (CC-BY-SA, fair use),
// CyclOSM (OSM France fair-use tile policy), EOX Sentinel-2 cloudless (CC BY-NC-SA 4.0: non-commercial).
export const BASEMAPS = {
  streets: { label: 'Streets', style: 'https://tiles.openfreemap.org/styles/liberty' as string | StyleSpecification },
  topo: {
    label: 'Topo',
    style: raster(
      abc('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'),
      'Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA)',
      17,
    ),
  },
  cycle: {
    label: 'Cycle',
    style: raster(
      abc('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png'),
      '© CyclOSM | Map data © OpenStreetMap contributors',
      20,
    ),
  },
  satellite: {
    label: 'Satellite',
    style: raster(
      ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'],
      'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)',
      15,
    ),
  },
};
export type BasemapKey = keyof typeof BASEMAPS;
export const BASEMAP_KEY = 'bikepacking-planner:basemap';

export function savedBasemap(): BasemapKey {
  try {
    const v = localStorage.getItem(BASEMAP_KEY);
    if (v && v in BASEMAPS) return v as BasemapKey;
  } catch {
    /* storage unavailable */
  }
  return 'streets';
}

export function boundsOf(pts: { lat: number; lon: number }[]): LngLatBoundsLike {
  let [w, s, e, n] = [180, 90, -180, -90];
  for (const p of pts) {
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return [
    [w, s],
    [e, n],
  ];
}
