import { describe, expect, it } from 'vitest';
import { iconSvg } from '../ui/icons';
import { safeType, sanitizeWaypoint, type WaypointType } from './types';

describe('waypoint type safety', () => {
  const evil = '<img src=x onerror=alert(1)>' as unknown as WaypointType;

  it('maps unknown or malformed types to other', () => {
    expect(safeType('camp')).toBe('camp');
    expect(safeType(evil)).toBe('other');
    expect(safeType(undefined)).toBe('other');
    expect(safeType(42)).toBe('other');
    expect(safeType('__proto__')).toBe('other');
  });

  it('sanitises a waypoint from a corrupted saved trip', () => {
    const w = sanitizeWaypoint({ id: 'a', lat: 61, lon: 16, name: 'X', type: evil });
    expect(w.type).toBe('other');
  });

  it('draws a fallback icon instead of throwing, and never echoes the type', () => {
    const svg = iconSvg(evil);
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('onerror');
    expect(svg).toBe(iconSvg('other'));
  });
});
