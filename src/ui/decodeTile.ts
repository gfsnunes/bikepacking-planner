import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { DecodedLayer } from '../core/tile-surface';

/** The `transportation` layer of a Mapbox Vector Tile (same decoder MapLibre uses). */
export const decodeTransportation = (bytes: Uint8Array): DecodedLayer | undefined =>
  new VectorTile(new PbfReader(bytes)).layers.transportation as unknown as DecodedLayer | undefined;
