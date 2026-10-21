import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { hikeRuns } from '../core/hike';
import { formatPoint, formatRange, pointInfo, rangeInfo } from '../core/pointinfo';
import { dragRange } from '../core/splitter';
import { useStore } from '../store';
import { dayColor } from './colors';

const GRAB_PX = 10;
const HIKE_COLOR = '#d62828';

/** '#rrggbb' or '#rgb' → rgba() with the given alpha (canvas fillStyle can't take color-mix()). */
function withAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Diagonal hatch used to shade hike-a-bike stretches. */
function hikePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const size = Math.round(8 * devicePixelRatio);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(214, 40, 40, 0.35)';
  g.lineWidth = 1.5 * devicePixelRatio;
  g.beginPath();
  g.moveTo(0, size);
  g.lineTo(size, 0);
  g.moveTo(-size / 2, size / 2);
  g.lineTo(size / 2, -size / 2);
  g.moveTo(size / 2, size * 1.5);
  g.lineTo(size * 1.5, size / 2);
  g.stroke();
  return ctx.createPattern(c, 'repeat');
}

/** Nearest index in a sorted array to value. */
function nearestSorted(arr: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && v - arr[lo - 1] < arr[lo] - v ? lo - 1 : lo;
}

/** Place a floating box horizontally centred on x (px, relative to its container), kept inside it. */
function placeBox(box: HTMLElement, container: HTMLElement, x: number, top: number) {
  const w = box.offsetWidth;
  const left = Math.max(4, Math.min(container.clientWidth - w - 4, x - w / 2));
  box.style.transform = `translate(${left}px, ${top}px)`;
}

export function ElevationProfile() {
  const wrap = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const selBox = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const profile = useStore((s) => s.profile);
  const days = useStore((s) => s.days);
  const emphDay = useStore((s) => s.hoverDay ?? s.selectedDay);

  // (Re)create the chart when the profile changes.
  useEffect(() => {
    if (!profile || !wrap.current) return;
    const el = wrap.current;
    const xs = Float64Array.from(profile.dist, (m) => m / 1000);
    let dragging: number | null = null; // day index whose end is being dragged
    let sel: { a: number; b: number } | null = null; // range being measured
    const runs = hikeRuns(profile.hike);
    let hatch: CanvasPattern | null = null;

    const drawBands = (u: uPlot) => {
      const { ctx, bbox } = u;
      const { days: ds, hoverDay: hd, selectedDay } = useStore.getState();
      const emph = hd ?? selectedDay;
      ctx.save();
      ds.forEach((d, k) => {
        const x0 = u.valToPos(xs[d.start], 'x', true);
        const x1 = u.valToPos(xs[d.end], 'x', true);
        ctx.fillStyle = dayColor(k) + (k === emph ? '55' : k % 2 ? '1a' : '10');
        ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
      });
      if (runs.length) {
        hatch ??= hikePattern(ctx);
        ctx.fillStyle = hatch ?? 'rgba(214, 40, 40, 0.15)';
        for (const [a, b] of runs) {
          const x0 = u.valToPos(xs[a], 'x', true);
          ctx.fillRect(x0, bbox.top, Math.max(1, u.valToPos(xs[b], 'x', true) - x0), bbox.height);
        }
      }
      if (sel) {
        const x0 = u.valToPos(xs[Math.min(sel.a, sel.b)], 'x', true);
        const x1 = u.valToPos(xs[Math.max(sel.a, sel.b)], 'x', true);
        ctx.fillStyle = 'rgba(40, 90, 160, 0.22)';
        ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
      }
      ctx.restore();
    };

    const vline = (u: uPlot, x: number, color: string, width: number, dash: number[] = []) => {
      const { ctx, bbox } = u;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x, bbox.top);
      ctx.lineTo(x, bbox.top + bbox.height);
      ctx.stroke();
    };

    const drawMarkers = (u: uPlot) => {
      const { ctx, bbox } = u;
      const s = useStore.getState();
      const dpr = devicePixelRatio;
      ctx.save();
      // Hike-a-bike stretches of the elevation line in red.
      ctx.strokeStyle = HIKE_COLOR;
      ctx.lineWidth = 2.5 * dpr;
      ctx.lineJoin = 'round';
      for (const [a, b] of runs) {
        ctx.beginPath();
        for (let i = a; i <= b; i++) {
          const x = u.valToPos(xs[i], 'x', true);
          const y = u.valToPos(profile.ele[i], 'y', true);
          if (i === a) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Grey out what's outside the map view (drawn before the day handles, so those stay crisp).
      if (s.visibleRuns) {
        const edges: number[] = [];
        let from = 0; // first index of the current hidden stretch
        const hide = (a: number, b: number) => {
          if (b <= a) return;
          const x0 = u.valToPos(xs[a], 'x', true);
          ctx.fillRect(x0, bbox.top, u.valToPos(xs[b], 'x', true) - x0, bbox.height);
        };
        ctx.fillStyle = dim;
        for (const [a, b] of s.visibleRuns) {
          hide(from, a);
          if (a > 0) edges.push(a);
          if (b < xs.length - 1) edges.push(b);
          from = b;
        }
        hide(from, xs.length - 1);
        if (!s.visibleRuns.length) hide(0, xs.length - 1);
        for (const i of edges) vline(u, u.valToPos(xs[i], 'x', true), muted, 1 * dpr);
      }
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      s.days.slice(0, -1).forEach((d, k) => {
        const x = u.valToPos(xs[d.end], 'x', true);
        vline(u, x, dayColor(k), 2 * dpr, d.pinned ? [] : [5 * dpr, 4 * dpr]);
        ctx.fillStyle = dayColor(k);
        ctx.beginPath();
        ctx.arc(x, bbox.top + 9 * dpr, 9 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(k + 1), x, bbox.top + 13 * dpr);
      });
      if (sel) {
        for (const i of [sel.a, sel.b]) vline(u, u.valToPos(xs[i], 'x', true), 'rgba(40, 90, 160, 0.9)', 1.5 * dpr);
      } else if (s.hover != null && s.hoverSource === 'map') {
        // uPlot only draws its cursor for hovers on the chart itself; mirror a map hover here.
        const x = u.valToPos(xs[s.hover], 'x', true);
        const y = u.valToPos(profile.ele[s.hover], 'y', true);
        vline(u, x, '#222', 1 * dpr);
        ctx.setLineDash([]);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    };

    // Floating tip (hover) and range box (selection), positioned relative to the wrapper.
    const overOffset = () => {
      const o = u.over.getBoundingClientRect();
      const w = el.getBoundingClientRect();
      return { left: o.left - w.left, top: o.top - w.top };
    };
    const updateTip = () => {
      const t = tip.current!;
      const { hover } = useStore.getState();
      if (hover == null || sel || dragging != null) {
        t.hidden = true;
        return;
      }
      t.hidden = false;
      t.textContent = formatPoint(pointInfo(profile, hover), profile.hasElevation);
      const off = overOffset();
      const x = off.left + u.valToPos(xs[hover], 'x');
      const y = off.top + u.valToPos(profile.ele[hover], 'y');
      placeBox(t, el, x, Math.max(2, y - t.offsetHeight - 10));
    };
    const updateSelBox = () => {
      const b = selBox.current!;
      if (!sel) {
        b.hidden = true;
        return;
      }
      b.hidden = false;
      b.textContent = formatRange(rangeInfo(profile, sel.a, sel.b), profile.hasElevation);
      const off = overOffset();
      const mid = (xs[sel.a] + xs[sel.b]) / 2;
      placeBox(b, el, off.left + u.valToPos(mid, 'x'), off.top + 4);
    };

    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue('--muted').trim() || '#666';
    const grid = css.getPropertyValue('--grid').trim() || '#eee';
    const line = css.getPropertyValue('--fg').trim() || '#333';
    const panel = css.getPropertyValue('--panel').trim() || '#fff';
    const dim = withAlpha(panel, 0.65);
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: el.clientHeight,
      cursor: { drag: { x: false, y: false }, points: { size: 8 } },
      legend: { show: false },
      scales: { x: { time: false } },
      axes: [
        { label: 'km', size: 36, labelSize: 14, stroke: muted, grid: { stroke: grid }, ticks: { stroke: grid } },
        { label: 'm', size: 52, labelSize: 14, stroke: muted, grid: { stroke: grid }, ticks: { stroke: grid } },
      ],
      series: [{}, { stroke: line, width: 1.5, fill: 'rgba(120,120,120,0.25)', points: { show: false } }],
      hooks: {
        drawClear: [drawBands],
        draw: [drawMarkers],
        setCursor: [
          (u) => {
            if (dragging != null || sel) return;
            const idx = u.cursor.idx;
            const s = useStore.getState();
            if (idx == null) {
              if (s.hoverSource === 'profile') s.setHover(null, null);
            } else s.setHover(idx, 'profile');
          },
        ],
      },
    };
    const u = new uPlot(opts, [xs as unknown as number[], profile.ele as unknown as number[]], el);
    plot.current = u;

    // Pointer: near a day-end line drags it; anywhere else measures a range while held.
    const over = u.over;
    const idxAt = (clientX: number) => nearestSorted(xs, u.posToVal(clientX - over.getBoundingClientRect().left, 'x'));
    const near = (clientX: number) => {
      const x = clientX - over.getBoundingClientRect().left;
      let best: number | null = null;
      let bestD = GRAB_PX;
      useStore
        .getState()
        .days.slice(0, -1)
        .forEach((d, k) => {
          const dist = Math.abs(u.valToPos(xs[d.end], 'x') - x);
          if (dist <= bestD) (best = k), (bestD = dist);
        });
      return best;
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const k = near(e.clientX);
      if (k != null) dragging = k;
      else {
        const i = idxAt(e.clientX);
        sel = { a: i, b: i };
        useStore.getState().setSelection([i, i]);
        updateSelBox();
      }
      updateTip();
      over.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (sel) {
        const i = Math.max(0, Math.min(xs.length - 1, idxAt(e.clientX)));
        if (i !== sel.b) {
          sel.b = i;
          useStore.getState().setSelection([sel.a, sel.b]);
          u.redraw(false);
          updateSelBox();
        }
        return;
      }
      const k = dragging;
      if (k == null) {
        over.style.cursor = near(e.clientX) != null ? 'ew-resize' : 'crosshair';
        return;
      }
      const s = useStore.getState();
      const [lo, hi] = dragRange(s.days, k);
      if (lo > hi) return;
      const idx = Math.min(hi, Math.max(lo, idxAt(e.clientX)));
      if (idx !== s.days[k].end) s.dragEnd(k, idx);
      s.setHover(idx, 'profile');
    };
    const onUp = (e: PointerEvent) => {
      if (dragging == null && !sel) return;
      dragging = null;
      if (sel) {
        sel = null;
        useStore.getState().setSelection(null);
        updateSelBox();
        u.redraw(false);
      }
      if (over.hasPointerCapture(e.pointerId)) over.releasePointerCapture(e.pointerId);
      updateTip();
    };
    over.addEventListener('pointerdown', onDown);
    over.addEventListener('pointermove', onMove);
    over.addEventListener('pointerup', onUp);
    over.addEventListener('pointercancel', onUp);
    over.style.touchAction = 'pan-y';
    over.style.cursor = 'crosshair';

    // Hover changes come from both views; update the tip without a React render per mouse move.
    const unsub = useStore.subscribe((s, prev) => {
      if (s.visibleRuns !== prev.visibleRuns) u.redraw(false);
      if (s.hover === prev.hover && s.hoverSource === prev.hoverSource) return;
      if (s.hoverSource === 'map' || prev.hoverSource === 'map') u.redraw(false);
      updateTip();
    });

    const ro = new ResizeObserver(() => {
      u.setSize({ width: el.clientWidth, height: el.clientHeight });
      updateTip();
    });
    ro.observe(el);
    return () => {
      unsub();
      ro.disconnect();
      u.destroy();
      plot.current = null;
      useStore.getState().setSelection(null);
    };
  }, [profile]);

  // Redraw overlays when days or the highlighted day change.
  useEffect(() => {
    plot.current?.redraw(false);
  }, [days, emphDay]);

  return (
    <div ref={wrap} className="profile">
      <div ref={tip} className="profile-tip" hidden />
      <div ref={selBox} className="profile-sel" hidden />
    </div>
  );
}
