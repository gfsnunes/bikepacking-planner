import {
  BedDouble,
  Bike,
  Building2,
  Coffee,
  Droplet,
  Eye,
  MapPin,
  Mountain,
  Ship,
  ShoppingCart,
  Tent,
  TrainFront,
  TriangleAlert,
  Utensils,
  type IconNode,
} from 'lucide';
import { safeType, type WaypointType } from '../core/types';

// Lucide icons (ISC licence), one per waypoint type.
const ICONS: Record<WaypointType, IconNode> = {
  camp: Tent,
  lodging: BedDouble,
  water: Droplet,
  food: Utensils,
  cafe: Coffee,
  shop: ShoppingCart,
  bike: Bike,
  town: Building2,
  viewpoint: Eye,
  summit: Mountain,
  train: TrainFront,
  ferry: Ship,
  danger: TriangleAlert,
  other: MapPin,
};

const attr = (a: Record<string, string | number | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');

/**
 * Map icon bitmap for a waypoint type: the Lucide icon in white on a rounded square of the type's
 * colour. Drawn with Path2D so it's synchronous (MapLibre needs the pixels when the style loads).
 */
export function iconImage(type: WaypointType, color: string, cssSize = 22, pixelRatio = 2): ImageData {
  const size = Math.round(cssSize * pixelRatio);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const r = 5 * pixelRatio;
  const b = 1.5 * pixelRatio; // white border
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(b, b, size - 2 * b, size - 2 * b, r - b / 2);
  ctx.fill();
  // Icon: 24-unit Lucide viewBox scaled into the middle 64% of the square.
  const inner = size * 0.64;
  ctx.save();
  ctx.translate((size - inner) / 2, (size - inner) / 2);
  ctx.scale(inner / 24, inner / 24);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [tag, a] of ICONS[safeType(type)]) {
    if (tag === 'path') ctx.stroke(new Path2D(String(a.d)));
    else if (tag === 'circle') {
      ctx.beginPath();
      ctx.arc(Number(a.cx), Number(a.cy), Number(a.r), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

/** SVG markup for a waypoint type's icon, drawn in currentColor. */
export function iconSvg(type: WaypointType, size = 14): string {
  const body = ICONS[safeType(type)].map(([tag, a]) => `<${tag} ${attr(a)}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
