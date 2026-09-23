/**
 * Fingerprints: per class, the typical value (median) and the middle half
 * (interquartile band) of each feature across the ten heater steps.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { useStudio } from '../../app/state.tsx';
import type { HeaterProfile } from '../../core/types.ts';
import { heaterProfilesIn } from '../../ml/dataset.ts';
import { getFeatureSet, getFeatureSets } from '../../ml/features.ts';
import { fmtOhm } from '../../ui/format.ts';
import { axisStyle, ySize, useTheme, useWidth, withAlpha } from './chart-util.ts';
import { quantile } from './checks.ts';

interface ClassStats {
  id: string;
  name: string;
  color: string;
  cycles: number;
  /** per feature: [q1, median, q3] */
  q: [number, number, number][];
}

export function Fingerprints({ profile, setProfile }: { profile: string; setProfile(id: string): void }) {
  const s = useStudio();
  const theme = useTheme();
  const recs = s.recordings;
  const classes = s.project?.classes ?? [];
  const profiles = useMemo(() => heaterProfilesIn(recs), [recs]);
  const [sensor, setSensor] = useState<number | 'all'>('all');
  const [fsId, setFsId] = useState('shape');
  const fs = getFeatureSet(fsId);

  const hp: HeaterProfile | undefined = useMemo(() => {
    for (const r of recs) {
      const h = r.config.heaterProfiles.find((x) => x.id === profile);
      if (h) return h;
    }
    return undefined;
  }, [recs, profile]);

  const sensorsOnProfile = useMemo(() => {
    const set = new Set<number>();
    for (const r of recs) for (const c of r.cycles) if (c.heaterProfile === profile) set.add(c.sensor);
    return [...set].sort((a, b) => a - b);
  }, [recs, profile]);
  const sensorSel = sensor !== 'all' && !sensorsOnProfile.includes(sensor) ? 'all' : sensor;

  const { names, stats, stepIdx, otherIdx } = useMemo(() => {
    const names = fs.names({ environment: false });
    const rows = new Map<string, number[][]>();
    for (const r of recs) {
      for (const c of r.cycles) {
        if (c.heaterProfile !== profile) continue;
        if (sensorSel !== 'all' && c.sensor !== sensorSel) continue;
        const cls = r.specimens[c.specimen]?.classId;
        if (!cls) continue;
        (rows.get(cls) ?? rows.set(cls, []).get(cls)!).push(fs.extract(c, { environment: false }));
      }
    }
    const stats: ClassStats[] = [];
    for (const c of classes) {
      const rs = rows.get(c.id);
      if (!rs || rs.length < 3) continue;
      const q = names.map((_, j) => {
        const col = Float64Array.from(rs, (row) => row[j]).sort();
        return [quantile(col, 0.25), quantile(col, 0.5), quantile(col, 0.75)] as [number, number, number];
      });
      stats.push({ id: c.id, name: c.name, color: c.color, cycles: rs.length, q });
    }
    // Features that follow the heater steps go on the chart; the rest (like
    // "level") are listed below it.
    const stepIdx = names.map((n, i) => (/step/i.test(n) ? i : -1)).filter((i) => i >= 0).slice(0, 10);
    const chartIdx = stepIdx.length ? stepIdx : names.map((_, i) => i);
    const otherIdx = names.map((_, i) => i).filter((i) => !chartIdx.includes(i));
    return { names, stats, stepIdx: chartIdx, otherIdx };
  }, [recs, classes, profile, sensorSel, fs]);

  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const plotEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!width || !plotEl.current || stats.length === 0) return;
    const narrow = width < 560;
    const all = stats.flatMap((st) => stepIdx.flatMap((j) => st.q[j]));
    const positive = all.every((v) => v > 0);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const log = positive && hi / lo > 50;
    const ohms = fsId === 'aistudio';
    const ax = axisStyle(theme);
    const xs = stepIdx.map((_, i) => i + 1);
    const data: (number | null)[][] = [xs];
    const series: uPlot.Series[] = [{ label: 'Step' }];
    const bands: uPlot.Band[] = [];
    for (const st of stats) {
      const base = data.length;
      data.push(stepIdx.map((j) => st.q[j][0]), stepIdx.map((j) => st.q[j][2]), stepIdx.map((j) => st.q[j][1]));
      series.push(
        { label: `${st.name} 25%`, stroke: 'transparent', width: 0, points: { show: false } },
        { label: `${st.name} 75%`, stroke: 'transparent', width: 0, points: { show: false } },
        { label: st.name, stroke: st.color, width: 2, points: { show: true, size: 5, fill: st.color } },
      );
      bands.push({ series: [base + 1, base], fill: withAlpha(st.color, theme.dark ? 0.3 : 0.2) });
    }
    const fmt = (v: number) => (ohms ? fmtOhm(v) : Math.abs(v) >= 100 ? v.toFixed(0) : +v.toFixed(2) + '');
    const u = new uPlot({
      width,
      height: narrow ? 240 : 300,
      legend: { show: false },
      cursor: { drag: { x: false, y: false, setScale: false }, points: { show: false } },
      scales: { x: { time: false, range: [0.6, xs.length + 0.4] }, y: log ? { distr: 3, log: 10 } : {} },
      bands,
      axes: [
        {
          ...ax,
          incrs: [1],
          size: hp && stepIdx.length === 10 ? 44 : 30,
          values: (_u, vals) => vals.map((v) => {
            if (!Number.isInteger(v) || v < 1 || v > xs.length) return '';
            const temp = hp && stepIdx.length === 10 ? hp.steps[v - 1]?.[0] : undefined;
            return temp !== undefined && !narrow ? `${v}\n${temp}°C` : String(v);
          }),
          label: narrow ? undefined : 'heater step',
          labelSize: 16,
        },
        { ...ax, size: ySize, values: (_u, vals) => vals.map((v) => (v == null ? '' : fmt(v))) },
      ],
      series,
    }, data as uPlot.AlignedData, plotEl.current);
    return () => u.destroy();
  }, [stats, stepIdx, width, theme, hp, fsId]);

  const hasClasses = classes.length > 0 && recs.some((r) => r.specimens.some((sp) => sp.classId));

  return (
    <div className="card">
      <h2>Fingerprints</h2>
      <p className="muted small">
        Each class's typical response across the heater steps: the line is the median cycle, the band holds the middle half of
        its cycles. Where the bands don't overlap, the sensor can tell these apart.
      </p>
      <div className="row ex-controls">
        <label className="field">Heater profile
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.cycles.toLocaleString()} cycles)</option>)}
          </select>
        </label>
        <label className="field">Sensor
          <select value={String(sensorSel)} onChange={(e) => setSensor(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All sensors on this profile</option>
            {sensorsOnProfile.map((n) => <option key={n} value={n}>Sensor {n}</option>)}
          </select>
        </label>
        <label className="field">Features
          <select value={fsId} onChange={(e) => setFsId(e.target.value)}>
            {getFeatureSets().map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      </div>
      <p className="muted small ex-hint">{fs.description}</p>
      {!hasClasses ? (
        <div className="notice info">No specimen has a class yet. Assign classes on the <a href="#data">Data page</a> to compare fingerprints.</div>
      ) : stats.length === 0 ? (
        <div className="notice info">No classified cycles use this heater profile{sensorSel !== 'all' ? ' on this sensor' : ''}. Pick another one above.</div>
      ) : (
        <>
          <div ref={box} className="ex-chart-box"><div ref={plotEl} /></div>
          <div className="row small ex-legend">
            {stats.map((st) => (
              <span key={st.id}><span className="swatch" style={{ background: st.color }} />{st.name} <span className="muted">({st.cycles.toLocaleString()} cycles)</span></span>
            ))}
          </div>
          {otherIdx.length > 0 && (
            <div className="table-wrap">
              <table className="data ex-other">
                <thead><tr><th>Class</th>{otherIdx.map((j) => <th key={j} className="num">{names[j]}: median (middle half)</th>)}</tr></thead>
                <tbody>
                  {stats.map((st) => (
                    <tr key={st.id}>
                      <td><span className="swatch" style={{ background: st.color }} />{st.name}</td>
                      {otherIdx.map((j) => (
                        <td key={j} className="num">{st.q[j][1].toFixed(2)} <span className="muted">({st.q[j][0].toFixed(2)}–{st.q[j][2].toFixed(2)})</span></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {fsId === 'shape' && otherIdx.length > 0 && (
            <p className="muted small ex-hint">Level is the average log10 resistance of a cycle (5 means about 100 kΩ). It drifts with humidity and sensor age, so a difference in level alone is weaker evidence than a difference in shape.</p>
          )}
        </>
      )}
    </div>
  );
}
