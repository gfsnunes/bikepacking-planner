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

// Start with the Nordics; add Geofabrik region paths here to grow coverage.
const REGIONS: { name: string; path: string }[] = [
  { name: 'Sweden', path: 'europe/sweden' },
  { name: 'Norway', path: 'europe/norway' },
  { name: 'Finland', path: 'europe/finland' },
  { name: 'Denmark', path: 'europe/denmark' },
];

const out = process.argv[2] ?? 'data-out';
const work = join(out, '..', 'data-work');
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: 'inherit' });

async function readSeq(file: string) {
  const features = [];
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.replace(/^\u001e/, '').trim(); // geojsonseq record separator
    if (line) features.push(JSON.parse(line));
  }
  return features;
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
    const items = featuresToItems(await readSeq(seq));
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
    all.push(...items);
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
