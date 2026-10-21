/**
 * Build the pre-built waypoint library: download Geofabrik country extracts one at a time, keep only
 * the library categories with osmium, classify with the app's own rules and write 1°×1° tiles.
 *
 * Needs `osmium` (osmium-tool) on PATH. Run: npx tsx data-pipeline/build-tiles.ts [outDir]
 * Output: <outDir>/v1/meta.json, <outDir>/v1/tiles/<lat>_<lon>.json, <outDir>/_headers
 *
 * Data © OpenStreetMap contributors, ODbL. Extracts from https://download.geofabrik.de/.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { TILE_VERSION, featuresToItems, osmiumFilters, toTiles, type TileMeta } from '../src/core/poi-tiles';
import type { LibraryItem } from '../src/core/osm-library';

// Geofabrik's Europe sub-regions, minus the ones that repeat others (alps, dach, britain-and-ireland,
// united-kingdom). Russia is a separate top-level Geofabrik region. Downloaded one at a time (14 GB runner disk).
const REGIONS: { name: string; path: string }[] = [
  { name: 'Albania', path: 'europe/albania' },
  { name: 'Andorra', path: 'europe/andorra' },
  { name: 'Austria', path: 'europe/austria' },
  { name: 'Azores', path: 'europe/azores' },
  { name: 'Belarus', path: 'europe/belarus' },
  { name: 'Belgium', path: 'europe/belgium' },
  { name: 'Bosnia-Herzegovina', path: 'europe/bosnia-herzegovina' },
  { name: 'Bulgaria', path: 'europe/bulgaria' },
  { name: 'Croatia', path: 'europe/croatia' },
  { name: 'Cyprus', path: 'europe/cyprus' },
  { name: 'Czech Republic', path: 'europe/czech-republic' },
  { name: 'Denmark', path: 'europe/denmark' },
  { name: 'Estonia', path: 'europe/estonia' },
  { name: 'Faroe Islands', path: 'europe/faroe-islands' },
  { name: 'Finland', path: 'europe/finland' },
  { name: 'France', path: 'europe/france' },
  { name: 'Georgia', path: 'europe/georgia' },
  { name: 'Germany', path: 'europe/germany' },
  { name: 'Great Britain', path: 'europe/great-britain' },
  { name: 'Greece', path: 'europe/greece' },
  { name: 'Guernsey and Jersey', path: 'europe/guernsey-jersey' },
  { name: 'Hungary', path: 'europe/hungary' },
  { name: 'Iceland', path: 'europe/iceland' },
  { name: 'Ireland and Northern Ireland', path: 'europe/ireland-and-northern-ireland' },
  { name: 'Isle of Man', path: 'europe/isle-of-man' },
  { name: 'Italy', path: 'europe/italy' },
  { name: 'Kosovo', path: 'europe/kosovo' },
  { name: 'Latvia', path: 'europe/latvia' },
  { name: 'Liechtenstein', path: 'europe/liechtenstein' },
  { name: 'Lithuania', path: 'europe/lithuania' },
  { name: 'Luxembourg', path: 'europe/luxembourg' },
  { name: 'North Macedonia', path: 'europe/macedonia' },
  { name: 'Malta', path: 'europe/malta' },
  { name: 'Moldova', path: 'europe/moldova' },
  { name: 'Monaco', path: 'europe/monaco' },
  { name: 'Montenegro', path: 'europe/montenegro' },
  { name: 'Netherlands', path: 'europe/netherlands' },
  { name: 'Norway', path: 'europe/norway' },
  { name: 'Poland', path: 'europe/poland' },
  { name: 'Portugal', path: 'europe/portugal' },
  { name: 'Romania', path: 'europe/romania' },
  { name: 'Serbia', path: 'europe/serbia' },
  { name: 'Slovakia', path: 'europe/slovakia' },
  { name: 'Slovenia', path: 'europe/slovenia' },
  { name: 'Spain', path: 'europe/spain' },
  { name: 'Sweden', path: 'europe/sweden' },
  { name: 'Switzerland', path: 'europe/switzerland' },
  { name: 'Turkey', path: 'europe/turkey' },
  { name: 'Ukraine', path: 'europe/ukraine' },
];

const out = process.argv[2] ?? 'data-out';
const work = join(out, '..', 'data-work');
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit' });

/** Stream a geojsonseq file into library items in batches, so a large country never sits in memory as GeoJSON. */
async function readItems(file: string) {
  const items: LibraryItem[] = [];
  let batch: Parameters<typeof featuresToItems>[0] = [];
  const flush = () => {
    for (const it of featuresToItems(batch)) items.push(it);
    batch = [];
  };
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.replace(/^\u001e/, '').trim(); // geojsonseq record separator
    if (line) batch.push(JSON.parse(line));
    if (batch.length >= 20_000) flush();
  }
  flush();
  return items;
}

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, TILE_VERSION, 'tiles'), { recursive: true });
  mkdirSync(work, { recursive: true });
  const config = join(work, 'export-config.json');
  // Original OSM type and id (osmium's own ids double way numbers); closed ways as areas only.
  writeFileSync(config, JSON.stringify({ attributes: { type: true, id: true }, linear_tags: false, area_tags: true }));

  const all: LibraryItem[] = [];
  const regions: TileMeta['regions'] = [];
  for (const r of REGIONS) {
    const pbf = join(work, 'region.osm.pbf');
    const filtered = join(work, 'filtered.osm.pbf');
    const seq = join(work, 'places.geojsonseq');
    console.log(`\n== ${r.name}`);
    run('curl', ['-fsSL', '--retry', '3', '-o', pbf, `https://download.geofabrik.de/${r.path}-latest.osm.pbf`]);
    run('osmium', ['tags-filter', pbf, ...osmiumFilters(), '-o', filtered, '--overwrite']);
    rmSync(pbf); // keep disk use to one extract at a time
    run('osmium', ['export', filtered, '-f', 'geojsonseq', '--geometry-types=point,polygon', '-c', config, '-o', seq, '--overwrite']);
    const items = await readItems(seq);
    rmSync(filtered);
    rmSync(seq);
    if (!items.length) throw new Error(`${r.name}: no places found; refusing to publish an empty region`);
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const it of items) {
      w = Math.min(w, it.lon);
      e = Math.max(e, it.lon);
      s = Math.min(s, it.lat);
      n = Math.max(n, it.lat);
    }
    regions.push({ name: r.name, bbox: [+w.toFixed(3), +s.toFixed(3), +e.toFixed(3), +n.toFixed(3)] });
    console.log(`${r.name}: ${items.length} places`);
    for (const it of items) all.push(it); // spread would overflow the stack for millions
  }

  const tiles = toTiles(all);
  for (const [key, items] of tiles) writeFileSync(join(out, TILE_VERSION, 'tiles', `${key}.json`), JSON.stringify({ items }));
  const meta: TileMeta = { built: new Date().toISOString().slice(0, 10), regions, tiles: [...tiles.keys()].sort() };
  writeFileSync(join(out, TILE_VERSION, 'meta.json'), JSON.stringify(meta));
  // Readable from the app's origin; tiles change at most once per build, meta can change any build.
  writeFileSync(
    join(out, '_headers'),
    [
      '/*',
      '  Access-Control-Allow-Origin: *',
      '  X-Content-Type-Options: nosniff',
      '/v1/tiles/*',
      '  Cache-Control: public, max-age=86400',
      '/v1/meta.json',
      '  Cache-Control: public, max-age=3600',
      '',
    ].join('\n'),
  );
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  const total = [...tiles.values()].reduce((a, t) => a + t.length, 0);
  console.log(`\nWrote ${tiles.size} tiles, ${total} places, regions: ${regions.map((r) => r.name).join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
