import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { nearestIndex } from '../core/geo';
import { newWaypointId } from '../core/gpx';
import { hikeRuns } from '../core/hike';
import { formatPoint, pointInfo } from '../core/pointinfo';
import { dragRange } from '../core/splitter';
import { sameRuns, visibleRuns } from '../core/viewport';
import { WAYPOINT_TYPES } from '../core/types';
import { useStore } from '../store';
import { WAYPOINT_STYLE, dayColor } from './colors';
import { iconImage } from './icons';
import { BASEMAPS, BASEMAP_KEY, boundsOf, savedBasemap, type BasemapKey } from './basemaps';

const LABEL_FONT = ['Noto Sans Bold'];

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

/** Our own sources and layers, added again after every basemap switch. */
function addOverlay(map: maplibregl.Map) {
  if (map.getSource('route')) return;
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#fff', 'line-width': 7 },
  });
  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
  });
  // Invisible wide line so hovering near the track (about 12 px either side) still counts.
  map.addLayer({
    id: 'route-hit',
    type: 'line',
    source: 'route',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#000', 'line-width': 24, 'line-opacity': 0 },
  });
  // Resupply gaps: a wide red band under the route where food or water can't be reached in time.
  map.addSource('resupply-gap', { type: 'geojson', data: EMPTY });
  map.addLayer(
    {
      id: 'resupply-gap',
      type: 'line',
      source: 'resupply-gap',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#d62828', 'line-width': 14, 'line-opacity': 0.3 },
    },
    'route-casing',
  );
  map.addSource('hike', { type: 'geojson', data: EMPTY });
  // Dark dashes on a white casing: stays visible on every day colour and on satellite imagery.
  map.addLayer({
    id: 'hike-casing',
    type: 'line',
    source: 'hike',
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-color': '#fff', 'line-width': 6 },
  });
  map.addLayer({
    id: 'hike',
    type: 'line',
    source: 'hike',
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-color': '#1a1a1a', 'line-width': 3, 'line-dasharray': [1.2, 0.8] },
  });
  map.addSource('selection', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'selection',
    type: 'line',
    source: 'selection',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#1d3f73', 'line-width': 7, 'line-opacity': 0.85 },
  });
  map.addSource('hover', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'hover',
    type: 'circle',
    source: 'hover',
    paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-width': 3, 'circle-stroke-color': '#222' },
  });

  // Planned resupply stops: a coloured ring under the waypoint icon (orange food, blue water).
  map.addSource('resupply', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'resupply',
    type: 'circle',
    source: 'resupply',
    paint: {
      'circle-radius': 17,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 3,
      'circle-stroke-color': ['match', ['get', 'kind'], 'food', '#c46a00', '#1d7fd1'],
    },
  });

  // Waypoints: a clustered GeoJSON layer (scales to thousands, unlike one DOM pin each).
  const pixelRatio = 2;
  for (const t of WAYPOINT_TYPES) {
    if (!map.hasImage(`wp-${t}`)) map.addImage(`wp-${t}`, iconImage(t, WAYPOINT_STYLE[t].color, 22, pixelRatio), { pixelRatio });
  }
  map.addSource('waypoints', { type: 'geojson', data: EMPTY, cluster: true, clusterMaxZoom: 11, clusterRadius: 40 });
  map.addLayer({
    id: 'wp-clusters',
    type: 'circle',
    source: 'waypoints',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#374151',
      'circle-opacity': 0.9,
      'circle-radius': ['step', ['get', 'point_count'], 13, 50, 17, 200, 22],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
  map.addLayer({
    id: 'wp-cluster-count',
    type: 'symbol',
    source: 'waypoints',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': LABEL_FONT,
      'text-size': 12,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#fff' },
  });
  map.addLayer({
    id: 'wp-icons',
    type: 'symbol',
    source: 'waypoints',
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': ['concat', 'wp-', ['get', 'type']],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  // Hovered / selected / dragged waypoint, drawn larger on top (unclustered).
  map.addSource('wp-hl', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'wp-hl',
    type: 'symbol',
    source: 'wp-hl',
    layout: {
      'icon-image': ['concat', 'wp-', ['get', 'type']],
      'icon-size': 1.4,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
}

const pointFeature = (lon: number, lat: number, properties: Record<string, unknown>) => ({
  type: 'Feature' as const,
  properties,
  geometry: { type: 'Point' as const, coordinates: [lon, lat] },
});

export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Bumped on every style load, so effects re-push data into the fresh sources.
  const [styleVersion, setStyleVersion] = useState(0);
  const [basemap, setBasemap] = useState<BasemapKey>(savedBasemap);
  const endMarkers = useRef<maplibregl.Marker[]>([]);
  const wpDrag = useRef<{ id: string; lngLat: maplibregl.LngLat | null } | null>(null);
  const popup = useRef<maplibregl.Popup | null>(null);
  const pointPopup = useRef<maplibregl.Popup | null>(null);
  const dragging = useRef<number | null>(null);

  const points = useStore((s) => s.points);
  const days = useStore((s) => s.days);
  const readOnly = useStore((s) => !!s.share && !s.share.canWrite);
  const waypoints = useStore((s) => s.waypoints);
  const selectedWaypoint = useStore((s) => s.selectedWaypoint);
  const hover = useStore((s) => s.hover);
  const emphDay = useStore((s) => s.hoverDay ?? s.selectedDay);
  const hoverWaypoint = useStore((s) => s.hoverWaypoint);
  const focusDay = useStore((s) => s.focusDay);
  const focusPoint = useStore((s) => s.focusPoint);
  const selection = useStore((s) => s.selection);
  const profile = useStore((s) => s.profile);
  const foodPlan = useStore((s) => s.foodPlan);
  const waterPlan = useStore((s) => s.waterPlan);
  const ready = styleVersion > 0;

  // Create the map once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: BASEMAPS[savedBasemap()].style,
      center: [16.4, 61.35],
      zoom: 5,
      attributionControl: { compact: true },
      // North-up and flat: the map view is then exactly map.getBounds(), which the profile greying uses.
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('style.load', () => {
      addOverlay(map);
      setStyleVersion((v) => v + 1);
    });

    // Hover along the route -> shared hover index (drives the profile crosshair and day-card highlight).
    map.on('mousemove', 'route-hit', (e) => {
      const pts = useStore.getState().points;
      const { idx } = nearestIndex(pts, e.lngLat.lat, e.lngLat.lng);
      useStore.getState().setHover(idx, 'map');
      map.getCanvas().style.cursor = useStore.getState().addingWaypoint ? 'crosshair' : 'pointer';
    });
    map.on('mouseleave', 'route-hit', () => {
      useStore.getState().setHover(null, null);
      map.getCanvas().style.cursor = useStore.getState().addingWaypoint ? 'crosshair' : '';
    });

    map.on('click', (e) => {
      const s = useStore.getState();
      if (!s.addingWaypoint) {
        // A click on the map (not on a waypoint) clears the selected day.
        const layers = ['wp-icons', 'wp-clusters'].filter((l) => map.getLayer(l));
        const onWaypoint = layers.length > 0 && map.queryRenderedFeatures(e.point, { layers }).length > 0;
        if (!onWaypoint && s.selectedDay != null) s.clearSelectedDay();
        return;
      }
      s.addWaypoint({
        id: newWaypointId('u'),
        lat: e.lngLat.lat,
        lon: e.lngLat.lng,
        name: `Waypoint ${s.waypoints.length + 1}`,
        type: 'camp',
      });
      s.setAddingWaypoint(false);
    });

    // Waypoint layer interaction: hover (name), click (select), drag (move), cluster click (zoom in).
    const wpId = (e: maplibregl.MapLayerMouseEvent) => e.features?.[0]?.properties?.id as string | undefined;
    map.on('mousemove', 'wp-icons', (e) => {
      const id = wpId(e);
      if (id && id !== useStore.getState().hoverWaypoint) useStore.getState().setHoverWaypoint(id);
      if (!wpDrag.current) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'wp-icons', () => {
      if (wpDrag.current) return;
      useStore.getState().setHoverWaypoint(null);
      map.getCanvas().style.cursor = '';
    });
    map.on('click', 'wp-icons', (e) => {
      const id = wpId(e);
      if (id && !useStore.getState().addingWaypoint) useStore.getState().selectWaypoint(id);
    });
    map.on('mousedown', 'wp-icons', (e) => {
      const id = wpId(e);
      const st = useStore.getState();
      if (!id || e.originalEvent.button !== 0 || st.addingWaypoint || (st.share && !st.share.canWrite)) return;
      e.preventDefault(); // stop the map panning
      wpDrag.current = { id, lngLat: null };
      map.getCanvas().style.cursor = 'grabbing';
      const onMove = (ev: maplibregl.MapMouseEvent) => {
        wpDrag.current!.lngLat = ev.lngLat;
        map.setFilter('wp-icons', ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'id'], id]]);
        const w = useStore.getState().waypoints.find((x) => x.id === id);
        if (w) (map.getSource('wp-hl') as GeoJSONSource).setData(pointFeature(ev.lngLat.lng, ev.lngLat.lat, { id, type: w.type }));
      };
      map.on('mousemove', onMove);
      map.once('mouseup', () => {
        map.off('mousemove', onMove);
        const ll = wpDrag.current?.lngLat;
        wpDrag.current = null;
        map.setFilter('wp-icons', ['!', ['has', 'point_count']]);
        map.getCanvas().style.cursor = '';
        if (ll) useStore.getState().updateWaypoint(id, { lat: ll.lat, lon: ll.lng });
      });
    });
    map.on('click', 'wp-clusters', async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const zoom = await (map.getSource('waypoints') as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: (f.geometry as { coordinates: [number, number] }).coordinates, zoom });
    });
    map.on('mouseenter', 'wp-clusters', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'wp-clusters', () => (map.getCanvas().style.cursor = ''));

    popup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 16, className: 'wp-popup' });
    pointPopup.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: 'point-popup',
      maxWidth: 'none',
    });
    // Tell the profile which stretches are in view (at most once per frame while moving).
    let frame = 0;
    const syncView = () => {
      frame = 0;
      const b = map.getBounds();
      const s = useStore.getState();
      const runs = s.points.length
        ? visibleRuns(s.points, { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() })
        : null;
      if (!sameRuns(runs, s.visibleRuns)) s.setVisibleRuns(runs);
    };
    const scheduleSync = () => (frame ||= requestAnimationFrame(syncView));
    map.on('move', scheduleSync);
    map.on('moveend', syncView);
    map.on('resize', scheduleSync);
    const unsubPoints = useStore.subscribe((s, prev) => s.points !== prev.points && scheduleSync());

    // The layout changes height when a track loads, not only on window resize.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current!);
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __map: maplibregl.Map }).__map = map; // debugging aid
    return () => {
      cancelAnimationFrame(frame);
      unsubPoints();
      ro.disconnect();
      setStyleVersion(0);
      endMarkers.current = [];
      map.remove();
    };
  }, []);

  // Basemap switch (our layers are re-added on style.load).
  const chooseBasemap = (key: BasemapKey) => {
    setBasemap(key);
    try {
      localStorage.setItem(BASEMAP_KEY, key);
    } catch {
      /* storage unavailable */
    }
    mapRef.current?.setStyle(BASEMAPS[key].style);
  };

  // Fit to a newly loaded track.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !points.length || !map) return;
    map.resize(); // the container may have just changed size (track loaded), before the observer fires
    map.fitBounds(boundsOf(points), { padding: 40, duration: 0 });
  }, [points, ready]); // ready flips once; basemap switches don't refit

  // Fit to a day when its card is clicked.
  useEffect(() => {
    const d = focusDay && useStore.getState().days[focusDay.k];
    if (d && mapRef.current) mapRef.current.fitBounds(boundsOf(points.slice(d.start, d.end + 1)), { padding: 60 });
  }, [focusDay, points]);

  // Route coloured per day.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('route') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: days.map((d, k) => ({
        type: 'Feature',
        properties: { color: dayColor(k), day: k },
        geometry: { type: 'LineString', coordinates: points.slice(d.start, d.end + 1).map((p) => [p.lon, p.lat]) },
      })),
    });
  }, [days, points, styleVersion, ready]);

  // Highlight the hovered (else the selected) day: thicker line, other days faded.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const on = emphDay != null;
    map.setPaintProperty('route', 'line-width', on ? ['case', ['==', ['get', 'day'], emphDay], 8, 4] : 4);
    map.setPaintProperty('route-casing', 'line-width', on ? ['case', ['==', ['get', 'day'], emphDay], 12, 7] : 7);
    map.setPaintProperty('route', 'line-opacity', on ? ['case', ['==', ['get', 'day'], emphDay], 1, 0.45] : 1);
  }, [emphDay, styleVersion, ready]);

  // Draggable day-end markers (one per day except the last).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const wanted = Math.max(0, days.length - 1);
    const list = endMarkers.current;
    while (list.length > wanted) list.pop()!.remove();
    while (list.length < wanted) {
      const k = list.length;
      const el = document.createElement('div');
      el.className = 'end-marker';
      el.textContent = String(k + 1);
      const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([0, 0]).addTo(map);
      m.on('dragstart', () => (dragging.current = k));
      m.on('drag', () => {
        const s = useStore.getState();
        const [lo, hi] = dragRange(s.days, k);
        if (lo > hi) return;
        const ll = m.getLngLat();
        const { idx } = nearestIndex(s.points, ll.lat, ll.lng, lo, hi);
        if (idx !== s.days[k].end) s.dragEnd(k, idx);
        s.setHover(idx, 'map');
      });
      m.on('dragend', () => {
        dragging.current = null;
        const s = useStore.getState();
        const p = s.points[s.days[k].end];
        m.setLngLat([p.lon, p.lat]);
        s.setHover(null, null);
      });
      list.push(m);
    }
    list.forEach((m, k) => {
      const d = days[k];
      const el = m.getElement();
      el.style.background = dayColor(k);
      el.classList.toggle('pinned', d.pinned);
      el.title = `End of day ${k + 1}${d.pinned ? ' (placed by hand)' : ''}${d.snappedTo ? ` - at ${d.snappedTo}` : ''}`;
      if (dragging.current !== k) m.setLngLat([points[d.end].lon, points[d.end].lat]);
      m.setDraggable(!readOnly);
    });
  }, [days, points, ready, readOnly]);

  // Waypoints into the clustered source.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('waypoints') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: waypoints.map((w) => pointFeature(w.lon, w.lat, { id: w.id, type: w.type })),
    });
  }, [waypoints, styleVersion, ready]);

  // Hovered and selected waypoints drawn larger, plus the hovered one's name.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || wpDrag.current) return;
    const ids = [...new Set([hoverWaypoint, selectedWaypoint].filter(Boolean))];
    const list = ids.map((id) => waypoints.find((x) => x.id === id)).filter((w) => !!w);
    (map.getSource('wp-hl') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: list.map((w) => pointFeature(w.lon, w.lat, { id: w.id, type: w.type })),
    });
    const w = hoverWaypoint ? list.find((x) => x.id === hoverWaypoint) : null;
    if (w) popup.current!.setLngLat([w.lon, w.lat]).setText(w.name).addTo(map);
    else popup.current!.remove();
  }, [hoverWaypoint, selectedWaypoint, waypoints, styleVersion, ready]);

  // Fly to a waypoint picked in the manager.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusPoint) return;
    map.flyTo({ center: [focusPoint.lon, focusPoint.lat], zoom: Math.max(map.getZoom(), 13), duration: 800 });
  }, [focusPoint]);

  // Hover dot (from either view).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const p = hover != null ? points[hover] : null;
    (map.getSource('hover') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: p ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }] : [],
    });
    // Same info as the profile tip; hidden while measuring or dragging a day end.
    if (p && profile && !selection && dragging.current == null) {
      pointPopup.current!.setLngLat([p.lon, p.lat]).setText(formatPoint(pointInfo(profile, hover!), profile.hasElevation)).addTo(map);
    } else pointPopup.current!.remove();
  }, [hover, points, profile, selection, styleVersion, ready]);

  // Hike-a-bike stretches as red dashes over the route.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const runs = profile ? hikeRuns(profile.hike) : [];
    (map.getSource('hike') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: runs.map(([a, b]) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: points.slice(a, b + 1).map((q) => [q.lon, q.lat]) },
      })),
    });
  }, [profile, points, styleVersion, ready]);

  // Resupply stops (rings) and gaps (red bands).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const rings = [
      ...(foodPlan?.stops ?? []).map((s) => ({ s, kind: 'food' })),
      ...(waterPlan?.stops ?? []).map((s) => ({ s, kind: 'water' })),
    ];
    const byId = new Map(waypoints.map((w) => [w.id, w]));
    (map.getSource('resupply') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: rings
        .map(({ s, kind }) => ({ w: byId.get(s.waypointId), kind }))
        .filter((x) => !!x.w)
        .map(({ w, kind }) => pointFeature(w!.lon, w!.lat, { kind })),
    });
    const gaps = [...(foodPlan?.gaps ?? []), ...(waterPlan?.gaps ?? [])];
    (map.getSource('resupply-gap') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: gaps.map((g) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: points.slice(g.fromIdx, g.toIdx + 1).map((q) => [q.lon, q.lat]) },
      })),
    });
  }, [foodPlan, waterPlan, waypoints, points, styleVersion, ready]);

  // Stretch being measured on the profile.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const [a, b] = selection ? [Math.min(...selection), Math.max(...selection)] : [0, -1];
    (map.getSource('selection') as GeoJSONSource).setData(
      b > a
        ? {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: points.slice(a, b + 1).map((q) => [q.lon, q.lat]) },
          }
        : EMPTY,
    );
  }, [selection, points, styleVersion, ready]);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      <div className="layer-control" role="group" aria-label="Map layer">
        {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
          <button key={k} className={k === basemap ? 'active' : ''} onClick={() => chooseBasemap(k)}>
            {BASEMAPS[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}
