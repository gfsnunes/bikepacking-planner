import type { WaypointType } from '../core/types';

// Day colours, cycled. Chosen to stay distinct on a light basemap.
export const DAY_COLORS = ['#e4572e', '#2e86ab', '#8f2d56', '#f3a712', '#29bf12', '#6a4c93', '#00a6a6', '#d1495b'];
export const dayColor = (k: number) => DAY_COLORS[k % DAY_COLORS.length];

export const WAYPOINT_STYLE: Record<WaypointType, { color: string; label: string }> = {
  camp: { color: '#2d6a4f', label: 'Camp' },
  lodging: { color: '#1b4965', label: 'Lodging' },
  water: { color: '#1d7fd1', label: 'Water' },
  food: { color: '#c46a00', label: 'Food' },
  cafe: { color: '#8a5a2b', label: 'Café' },
  shop: { color: '#b5651d', label: 'Shop' },
  bike: { color: '#6a4c93', label: 'Bike shop' },
  town: { color: '#5a4fcf', label: 'Town' },
  viewpoint: { color: '#0f766e', label: 'Viewpoint' },
  summit: { color: '#57534e', label: 'Summit' },
  train: { color: '#374151', label: 'Train' },
  ferry: { color: '#0e7490', label: 'Ferry' },
  danger: { color: '#b91c1c', label: 'Warning' },
  other: { color: '#555', label: 'Other' },
};

export const fmtKm = (km: number) => `${km.toFixed(km < 10 ? 1 : 0)} km`;
export const fmtM = (m: number) => `${Math.round(m).toLocaleString('en-US').replace(/,/g, ' ')} m`;
export const fmtH = (h: number) => {
  const mins = Math.round(h * 60);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')} h`;
};
