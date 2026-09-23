/**
 * Recording timeline: gas resistance of every sensor over time, with the
 * specimens shaded behind it, and temperature, humidity and pressure below.
 * Everything is min/max-downsampled to the chart's pixel width and
 * re-downsampled on zoom, so a twelve-hour recording stays quick.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { useStudio } from '../../app/state.tsx';
import { STEPS, type Recording, type SpecimenClass } from '../../core/types.ts';
import { fmtDuration, fmtOhm, sensorColor } from '../../ui/format.ts';
import { axisStyle, fmtElapsed, TIME_INCRS, useTheme, useWidth, withAlpha, type Theme } from './chart-util.ts';
import { bucketMinMax, type Series } from './downsample.ts';

type StepChoice = 'auto' | 'all' | number;

/** The heater step whose resistance changes most over the recording (log scale, averaged over sensors). */
export function mostVariedStep(r: Recording): number {
  const bySensor = new Map<number, number[][]>();
  for (const c of r.cycles) {
    const rows = bySensor.get(c.sensor) ?? bySensor.set(c.sensor, []).get(c.sensor)!;
    rows.push(c.gas);
  }
  let best = 0;
  let bestScore = -1;
  for (let k = 0; k < STEPS; k++) {
    let score = 0;
    for (const rows of bySensor.values()) {
      let m = 0;
      let m2 = 0;
      for (const g of rows) {
        const v = Math.log10(Math.max(g[k], 1));
        m += v;
        m2 += v * v;
      }
      const n = rows.length || 1;
      score += Math.sqrt(Math.max(0, m2 / n - (m / n) ** 2));
    }
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

interface Prepared {
  sensors: number[];
  gas: Series[];
  env: { temp: Series; hum: Series; press: Series };
  /** sensor whose readings the environment charts show */
  envSensor: number | null;
  t0: number;
  t1: number;
}

function sortedSeries(t: number[], v: number[]): Series {
  const n = t.length;
  let sorted = true;
  for (let i = 1; i < n; i++) if (t[i] < t[i - 1]) { sorted = false; break; }
  if (sorted) return { t: Float64Array.from(t), v: Float32Array.from(v) };
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b]);
  return { t: Float64Array.from(idx, (i) => t[i]), v: Float32Array.from(idx, (i) => v[i]) };
}

function prepare(r: Recording, step: number | 'all'): Prepared {
  const p = r.points;
  const perT = new Map<number, number[]>();
  const perV = new Map<number, number[]>();
  const t0 = p.length ? p.t[0] : 0;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < p.length; i++) {
    if (p.error[i] !== 0) continue;
    const t = (p.t[i] - t0) / 1000;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    if (step !== 'all' && p.step[i] !== step) continue;
    const g = p.gas[i];
    if (!(g > 0)) continue;
    const s = p.sensor[i];
    (perT.get(s) ?? perT.set(s, []).get(s)!).push(t);
    (perV.get(s) ?? perV.set(s, []).get(s)!).push(g);
  }
  const sensors = [...perT.keys()].sort((a, b) => a - b);
  // Environment from one sensor, once per cycle (at its first step, as
  // AI-Studio records it). Mixing sensors or steps would show the heater's
  // own warmth as noise.
  const envSensor = r.cycles.length ? Math.min(...new Set(r.cycles.map((c) => c.sensor))) : null;
  const et: number[] = [];
  const temp: number[] = [];
  const hum: number[] = [];
  const press: number[] = [];
  for (const c of r.cycles) {
    if (c.sensor !== envSensor) continue;
    et.push((c.start - t0) / 1000);
    temp.push(c.temp);
    hum.push(c.hum);
    press.push(c.press);
  }
  return {
    sensors,
    gas: sensors.map((s) => sortedSeries(perT.get(s)!, perV.get(s)!)),
    env: { temp: sortedSeries(et, temp), hum: sortedSeries(et, hum), press: sortedSeries(et, press) },
    envSensor,
    t0: isFinite(tMin) ? tMin : 0,
    t1: isFinite(tMax) ? tMax : 1,
  };
}

/** Closest non-empty value to a cursor position, for the legend readout. */
function nearest(u: uPlot, si: number, idx: number | null): number | null {
  if (idx == null) return null;
  const ys = u.data[si] as (number | null)[];
  for (let d = 1; d < 40; d++) {
    const l = ys[idx - d];
    if (l != null) return l;
    const r = ys[idx + d];
    if (r != null) return r;
  }
  return null;
}

interface Span { a: number; b: number; name: string; color: string | null }

function drawSpans(u: uPlot, spans: Span[], theme: Theme, labels: boolean) {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  const dpr = devicePixelRatio || 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  for (const s of spans) {
    const x0 = Math.max(left, u.valToPos(s.a, 'x', true));
    const x1 = Math.min(left + width, u.valToPos(s.b, 'x', true));
    if (x1 <= x0) continue;
    ctx.fillStyle = s.color ? withAlpha(s.color, theme.dark ? 0.24 : 0.15) : withAlpha(theme.dark ? '#9aa0a6' : '#5f6368', 0.08);
    ctx.fillRect(x0, top, x1 - x0, height);
    ctx.fillStyle = theme.line;
    ctx.fillRect(Math.round(x0), top, dpr, height);
    if (labels) {
      ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      ctx.fillStyle = theme.muted;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      let text = s.name;
      const room = x1 - x0 - 8 * dpr;
      while (text.length > 1 && ctx.measureText(text).width > room) text = text.slice(0, -2) + '…';
      if (text.length > 1 && ctx.measureText(text).width <= room) ctx.fillText(text, x0 + 4 * dpr, top + 4 * dpr);
    }
  }
  ctx.restore();
}

export interface TimelineHandle {
  zoom(f: number): void;
  pan(f: number): void;
  reset(): void;
}

function Charts({ prep, spans, theme, rangeRef, handle, recId }: {
  prep: Prepared;
  spans: Span[];
  theme: Theme;
  rangeRef: { current: [number, number] | null };
  handle: { current: TimelineHandle | null };
  recId: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const gasEl = useRef<HTMLDivElement>(null);
  const envEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!width || !gasEl.current || !envEl.current) return;
    const narrow = width < 560;
    const span = prep.t1 - prep.t0;
    const full: [number, number] = [prep.t0, prep.t1];
    let [a, b] = rangeRef.current ?? full;
    const buckets = Math.max(100, Math.min(4000, width));
    const syncKey = `explore-tl-${recId}`;
    const ax = axisStyle(theme);
    const xAxis = (show: boolean): uPlot.Axis => ({
      ...ax,
      show,
      incrs: TIME_INCRS,
      values: (u, vals) => vals.map((v) => fmtElapsed(v, (u.scales.x.max ?? span) - (u.scales.x.min ?? 0))),
      size: show ? 30 : 0,
    });
    const xSeries: uPlot.Series = { label: 'Time', value: (_u, v) => (v == null ? '–' : fmtElapsed(v, span)) };
    const cursor = (): uPlot.Cursor => ({
      sync: { key: syncKey, setSeries: false },
      drag: { x: true, y: false, setScale: true },
      // Double-click shows everything; handled below, since uPlot's own
      // reset would only reset to the (downsampled, zoomed) data it holds.
      bind: { dblclick: () => () => null },
    });
    let busy = false;
    const charts: { u: uPlot; series: Series[] }[] = [];
    const apply = (lo: number, hi: number) => {
      if (busy) return;
      const minSpan = Math.min(span, 30);
      if (hi - lo < minSpan) {
        const mid = (lo + hi) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
      }
      lo = Math.max(full[0], lo);
      hi = Math.min(full[1], hi);
      busy = true;
      try {
        a = lo;
        b = hi;
        rangeRef.current = lo <= full[0] && hi >= full[1] ? null : [lo, hi];
        for (const c of charts) {
          c.u.batch(() => {
            c.u.setData(bucketMinMax(c.series, lo, hi, buckets) as uPlot.AlignedData, false);
            c.u.setScale('x', { min: lo, max: hi });
          });
        }
      } finally {
        busy = false;
      }
    };
    const onScale = (u: uPlot, key: string) => {
      if (key !== 'x' || busy) return;
      const { min, max } = u.scales.x;
      if (min != null && max != null) apply(min, max);
    };

    const gasOpts: uPlot.Options = {
      width,
      height: narrow ? 240 : 320,
      cursor: cursor(),
      scales: { x: { time: false, auto: false, min: a, max: b }, y: { distr: 3, log: 10 } },
      legend: { show: true, live: true },
      axes: [
        xAxis(true),
        { ...ax, size: 76, values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtOhm(v))), label: narrow ? undefined : 'gas resistance', labelSize: 16 },
      ],
      series: [
        xSeries,
        ...prep.sensors.map((s) => ({
          label: `Sensor ${s}`,
          stroke: sensorColor(s),
          width: 1.25,
          spanGaps: true,
          points: { show: false },
          value: (u: uPlot, v: number | null, si: number, idx: number | null) => {
            const near = v ?? nearest(u, si, idx);
            return near == null ? '–' : fmtOhm(near);
          },
        })),
      ],
      hooks: { drawClear: [(u) => drawSpans(u, spans, theme, true)], setScale: [onScale] },
    };
    const padding: uPlot.Padding = [8, 14, 0, 0];
    gasOpts.padding = padding;
    const gas = new uPlot(gasOpts, bucketMinMax(prep.gas, a, b, buckets) as uPlot.AlignedData, gasEl.current);
    charts.push({ u: gas, series: prep.gas });

    const envDefs: { key: 'temp' | 'hum' | 'press'; label: string; unit: string; digits: number }[] = [
      { key: 'temp', label: 'Temperature', unit: '°C', digits: 1 },
      { key: 'hum', label: 'Humidity', unit: '%RH', digits: 1 },
      { key: 'press', label: 'Pressure', unit: 'hPa', digits: 1 },
    ];
    envDefs.forEach((d, i) => {
      const last = i === envDefs.length - 1;
      const el = document.createElement('div');
      envEl.current!.appendChild(el);
      const u = new uPlot({
        width,
        height: (narrow ? 96 : 110) + (last ? 30 : 0),
        padding,
        cursor: cursor(),
        scales: { x: { time: false, auto: false, min: a, max: b } },
        legend: { show: true, live: true },
        axes: [
          xAxis(last),
          { ...ax, size: 76, values: (_u, vals) => vals.map((v) => `${+v.toFixed(2)} ${d.unit}`), label: narrow ? undefined : d.label.toLowerCase(), labelSize: 16 },
        ],
        series: [
          xSeries,
          {
            label: prep.envSensor !== null ? `${d.label} (sensor ${prep.envSensor})` : d.label,
            stroke: theme.muted,
            width: 1.25,
            spanGaps: true,
            points: { show: false },
            value: (uu, v, si, idx) => {
              const near = v ?? nearest(uu, si, idx);
              return near == null ? '–' : `${near.toFixed(d.digits)} ${d.unit}`;
            },
          },
        ],
        hooks: { drawClear: [(uu) => drawSpans(uu, spans, theme, false)], setScale: [onScale] },
      }, bucketMinMax([prep.env[d.key]], a, b, buckets) as uPlot.AlignedData, el);
      charts.push({ u, series: [prep.env[d.key]] });
    });

    const onDbl = () => apply(full[0], full[1]);
    for (const c of charts) c.u.over.addEventListener('dblclick', onDbl);
    handle.current = {
      zoom: (f) => {
        const mid = (a + b) / 2;
        const h = ((b - a) / 2) * f;
        apply(mid - h, mid + h);
      },
      pan: (f) => {
        const d = (b - a) * f;
        const lo = Math.max(full[0], Math.min(full[1] - (b - a), a + d));
        apply(lo, lo + (b - a));
      },
      reset: () => apply(full[0], full[1]),
    };
    const envBox = envEl.current;
    return () => {
      handle.current = null;
      for (const c of charts) c.u.destroy();
      envBox.innerHTML = '';
    };
  }, [prep, spans, theme, width, recId, rangeRef, handle]);

  return (
    <div ref={box} className="tl-charts">
      <div ref={gasEl} />
      <div ref={envEl} className="tl-env" />
    </div>
  );
}

export function Timeline() {
  const s = useStudio();
  const theme = useTheme();
  const recs = s.recordings;
  const [recId, setRecId] = useState(recs[0]?.id ?? '');
  const rec = recs.find((r) => r.id === recId) ?? recs[0];
  const [step, setStep] = useState<StepChoice>('auto');
  const auto = useMemo(() => (rec ? mostVariedStep(rec) : 0), [rec]);
  const chosen: number | 'all' = step === 'auto' ? auto : step;
  const prep = useMemo(() => (rec ? prepare(rec, chosen) : null), [rec, chosen]);
  const rangeRef = useRef<[number, number] | null>(null);
  const handle = useRef<TimelineHandle | null>(null);
  const classes = s.project?.classes ?? [];

  const spans = useMemo<Span[]>(() => {
    if (!rec || !rec.points.length) return [];
    const t0 = rec.points.t[0];
    return rec.specimens.map((sp) => {
      const c = classes.find((x) => x.id === sp.classId);
      return { a: (sp.start - t0) / 1000, b: (sp.end - t0) / 1000, name: c ? `${sp.name} · ${c.name}` : sp.name, color: c?.color ?? null };
    });
  }, [rec, classes]);

  const usedClasses = useMemo(() => {
    const ids = new Set(rec?.specimens.map((sp) => sp.classId));
    return { list: classes.filter((c: SpecimenClass) => ids.has(c.id)), unclassed: rec?.specimens.some((sp) => !sp.classId) ?? false };
  }, [rec, classes]);

  if (!rec || !prep) return null;
  const len = rec.points.length ? rec.points.t[rec.points.length - 1] - rec.points.t[0] : 0;

  return (
    <div className="card">
      <h2>Recording timeline</h2>
      <p className="muted small">
        Gas resistance of each sensor over time, with each specimen shaded in its class colour. Look for a clear, repeatable
        step up or down whenever a specimen starts; a slow drift across the whole recording is the sensor settling, not the smell.
      </p>
      <div className="row ex-controls">
        <label className="field">Recording
          <select value={rec.id} onChange={(e) => { rangeRef.current = null; setRecId(e.target.value); }}>
            {recs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label className="field">Heater step
          <select value={String(step)} onChange={(e) => setStep(e.target.value === 'auto' || e.target.value === 'all' ? e.target.value : Number(e.target.value))}>
            <option value="auto">Step {auto + 1} (changes most)</option>
            <option value="all">All steps</option>
            {Array.from({ length: STEPS }, (_, k) => <option key={k} value={k}>Step {k + 1}</option>)}
          </select>
        </label>
        <div className="row ex-zoom" role="group" aria-label="Zoom and pan">
          <button className="btn small" onClick={() => handle.current?.pan(-0.5)} aria-label="Pan left" title="Pan left">◀</button>
          <button className="btn small" onClick={() => handle.current?.zoom(0.5)} aria-label="Zoom in" title="Zoom in">+</button>
          <button className="btn small" onClick={() => handle.current?.zoom(2)} aria-label="Zoom out" title="Zoom out">−</button>
          <button className="btn small" onClick={() => handle.current?.pan(0.5)} aria-label="Pan right" title="Pan right">▶</button>
          <button className="btn small" onClick={() => handle.current?.reset()}>Show all</button>
        </div>
      </div>
      <p className="muted small ex-hint">
        {fmtDuration(len)}, {prep.sensors.length} sensor{prep.sensors.length === 1 ? '' : 's'}, {rec.cycles.length.toLocaleString()} cycles.
        Drag across a chart to zoom in, double-click to see it all. Click a sensor below the chart to hide it.
      </p>
      <Charts prep={prep} spans={spans} theme={theme} rangeRef={rangeRef} handle={handle} recId={rec.id} />
      {(usedClasses.list.length > 0 || usedClasses.unclassed) && (
        <div className="row small ex-legend">
          {usedClasses.list.map((c) => <span key={c.id}><span className="swatch" style={{ background: c.color }} />{c.name}</span>)}
          {usedClasses.unclassed && <span><span className="swatch ex-swatch-none" />no class</span>}
        </div>
      )}
    </div>
  );
}
