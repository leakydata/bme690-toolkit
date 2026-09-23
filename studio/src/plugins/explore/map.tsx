/**
 * Separation map: every cycle as a dot in 2-D (PCA or UMAP), coloured by
 * class, plus a plain-English verdict on whether the classes can be told
 * apart, from a leave-one-specimen-out nearest-neighbour check.
 */
import { useEffect, useMemo, useState } from 'react';
import { useStudio } from '../../app/state.tsx';
import type { DatasetSpec } from '../../core/types.ts';
import { buildDataset, heaterProfilesIn } from '../../ml/dataset.ts';
import { getFeatureSet, getFeatureSets } from '../../ml/features.ts';
import { pca } from '../../ml/pca.ts';
import { describeSeparability, stratifiedSubsample, type SeparabilityResult } from '../../ml/separability.ts';
import { fmtDuration } from '../../ui/format.ts';
import { profileName } from './checks.ts';
import type { WorkerReply, WorkerRequest } from './explore.worker.ts';
import { Scatter } from './scatter.tsx';

const MAP_POINTS = 3000;
const SEP_POINTS = 1500;

function runJob(req: WorkerRequest, onMsg: (m: WorkerReply) => void): () => void {
  const w = new Worker(new URL('./explore.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<WorkerReply>) => {
    onMsg(e.data);
    if (e.data.kind !== 'progress') w.terminate();
  };
  w.onerror = (e) => {
    onMsg({ kind: 'error', message: e.message || 'The background worker failed to start.' });
    w.terminate();
  };
  w.postMessage(req);
  return () => w.terminate();
}

const fmtSec = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function SeparationMap({ profile, setProfile }: { profile: string; setProfile(id: string): void }) {
  const s = useStudio();
  const recs = s.recordings;
  const classes = s.project?.classes ?? [];
  const profiles = useMemo(() => heaterProfilesIn(recs), [recs]);
  const [mode, setMode] = useState<DatasetSpec['mode']>('per-sensor');
  const [fsId, setFsId] = useState('shape');
  const [environment, setEnvironment] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [proj, setProj] = useState<'pca' | 'umap'>('pca');

  const sensorsOnProfile = useMemo(() => {
    const set = new Set<number>();
    for (const r of recs) for (const c of r.cycles) if (c.heaterProfile === profile) set.add(c.sensor);
    return [...set].sort((a, b) => a - b);
  }, [recs, profile]);
  const sensors = picked.filter((n) => sensorsOnProfile.includes(n));

  const labelOf = useMemo(() => Object.fromEntries(classes.map((c) => [c.id, c.name])), [classes]);
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of classes) if (!m.has(c.name)) m.set(c.name, c.color);
    return m;
  }, [classes]);

  const ds = useMemo(() => {
    if (!profile) return null;
    const t0 = performance.now();
    const d = buildDataset(recs, { featureSet: fsId, environment, heaterProfile: profile, sensors, mode, labelOf });
    return { ...d, ms: performance.now() - t0 };
  }, [recs, fsId, environment, profile, sensors.join(','), mode, labelOf]);

  const sub = useMemo(() => (ds ? stratifiedSubsample(ds.samples.map((x) => x.y), MAP_POINTS, 7) : []), [ds]);
  const X = useMemo(() => (ds ? sub.map((i) => ds.samples[i].x) : []), [ds, sub]);
  const pcaRes = useMemo(() => (X.length >= 3 ? pca(X, 2) : null), [X]);
  const colors = useMemo(() => (ds ? sub.map((i) => colorOf.get(ds.labels[ds.samples[i].y]) ?? '#888') : []), [ds, sub, colorOf]);

  // UMAP, in a worker, restarted when the data changes.
  const [umap, setUmap] = useState<{ key: number[][]; emb: number[][] | null; done: number; total: number; ms: number | null; error: string | null } | null>(null);
  useEffect(() => {
    if (proj !== 'umap' || X.length < 5) return;
    setUmap({ key: X, emb: null, done: 0, total: 1, ms: null, error: null });
    return runJob({ kind: 'umap', x: X, seed: 42 }, (m) => {
      setUmap((u) => {
        if (!u || u.key !== X) return u;
        if (m.kind === 'progress') return { ...u, done: m.done, total: m.total, emb: m.embedding ?? u.emb };
        if (m.kind === 'umap-done') return { ...u, emb: m.embedding, done: u.total, ms: m.ms };
        if (m.kind === 'error') return { ...u, error: m.message };
        return u;
      });
    });
  }, [proj, X]);

  // Separability, in a worker, whenever the dataset changes.
  const [sep, setSep] = useState<{ key: unknown; result: SeparabilityResult | null; ms: number | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!ds || ds.samples.length < 10) {
      setSep(null);
      return;
    }
    const idx = stratifiedSubsample(ds.samples.map((x) => x.y), SEP_POINTS, 3);
    const input = {
      x: idx.map((i) => ds.samples[i].x),
      y: idx.map((i) => ds.samples[i].y),
      group: idx.map((i) => ds.samples[i].group),
      t: idx.map((i) => ds.samples[i].t),
      labels: ds.labels,
    };
    setSep({ key: ds, result: null, ms: null, error: null });
    return runJob({ kind: 'separability', input, maxPoints: SEP_POINTS }, (m) => {
      setSep((cur) => {
        if (!cur || cur.key !== ds) return cur;
        if (m.kind === 'separability-done') return { ...cur, result: m.result, ms: m.ms };
        if (m.kind === 'error') return { ...cur, error: m.message };
        return cur;
      });
    });
  }, [ds]);

  const hasClasses = classes.length > 0 && recs.some((r) => r.specimens.some((sp) => sp.classId));
  const pName = profileName(recs, profile);
  const umapCurrent = umap && umap.key === X ? umap : null;
  const points = proj === 'pca' ? pcaRes?.points ?? null : umapCurrent?.emb ?? null;
  const verdicts = sep?.result ? describeSeparability(sep.result, pName) : [];
  const fs = getFeatureSet(fsId);

  const tooltip = (i: number) => {
    if (!ds) return null;
    const smp = ds.samples[sub[i]];
    const r = recs.find((x) => x.id === smp.recordingId);
    const sp = r?.specimens[smp.specimen];
    const t0 = r?.points.length ? r.points.t[0] : 0;
    return (
      <>
        <div><span className="swatch" style={{ background: colors[i] }} /><b>{ds.labels[smp.y]}</b></div>
        <div>{sp?.name ?? 'specimen'}{smp.sensor !== null ? `, sensor ${smp.sensor}` : ''}</div>
        <div className="muted">{r?.name}, at {fmtDuration(smp.t - t0)}</div>
      </>
    );
  };

  const toggleSensor = (n: number) => {
    const cur = sensors.length ? sensors : sensorsOnProfile;
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b);
    if (next.length === 0) return;
    setPicked(next.length === sensorsOnProfile.length ? [] : next);
  };

  return (
    <div className="card">
      <h2>Separation map</h2>
      <p className="muted small">
        Every dot is one cycle, placed so that cycles with similar fingerprints sit close together. If each colour forms its own
        cloud, a model will find the classes easy to tell apart; where colours mix, it will confuse them.
      </p>
      <div className="row ex-controls">
        <label className="field">Heater profile
          <select value={profile} onChange={(e) => { setProfile(e.target.value); setPicked([]); }}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">Features
          <select value={fsId} onChange={(e) => setFsId(e.target.value)}>
            {getFeatureSets().map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className="field">Sensors
          <select value={mode} onChange={(e) => setMode(e.target.value as DatasetSpec['mode'])}>
            <option value="per-sensor">Each sensor on its own</option>
            <option value="fused">Sensors combined</option>
          </select>
        </label>
        <label className="field">Map
          <select value={proj} onChange={(e) => setProj(e.target.value as 'pca' | 'umap')}>
            <option value="pca">PCA (fast, faithful)</option>
            <option value="umap">UMAP (shows clusters)</option>
          </select>
        </label>
      </div>
      <div className="row ex-controls small">
        {sensorsOnProfile.length > 1 && (
          <div className="row ex-chips" role="group" aria-label="Sensors to include">
            <span className="muted">Use sensors:</span>
            {sensorsOnProfile.map((n) => {
              const on = sensors.length === 0 || sensors.includes(n);
              return (
                <label key={n} className={`ex-chip${on ? ' on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleSensor(n)} /> {n}
                </label>
              );
            })}
          </div>
        )}
        <label className="ex-chip on">
          <input type="checkbox" checked={environment} onChange={(e) => setEnvironment(e.target.checked)} /> Include temperature, humidity, pressure
        </label>
      </div>
      <p className="muted small ex-hint">
        {mode === 'fused'
          ? 'Sensors combined: one dot per moment, joining the cycles all chosen sensors ran at about the same time. '
          : 'Each sensor on its own: one dot per cycle of each sensor. '}
        {fs.description}
        {environment && ' With temperature, humidity and pressure included, the map can separate classes by the weather they were recorded in rather than by their smell.'}
      </p>

      {!hasClasses ? (
        <div className="notice info">No specimen has a class yet. Assign classes on the <a href="#data">Data page</a> to see whether they separate.</div>
      ) : !ds || ds.samples.length < 5 ? (
        <div className="notice info">Too few classified cycles with these settings. Try another heater profile{mode === 'fused' ? ', or "Each sensor on its own"' : ''}.</div>
      ) : (
        <div className="ex-map">
          <div className="ex-verdict">
            <h3>Can the classes be told apart?</h3>
            {sep?.error && <div className="notice error">The check failed: {sep.error}</div>}
            {!sep?.result && !sep?.error && <p className="muted small">Checking…</p>}
            {verdicts.map((v, i) => (
              <div key={i} className={`notice small ${v.level === 'ok' ? 'ok' : v.level === 'warn' ? 'warn' : 'error'}`}>{v.text}</div>
            ))}
            {sep?.result && (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Class</th><th className="num">Specimens</th><th className="num" title="Share of cycles whose nearest cycles from other specimens are of the same class">With own class</th><th>Mixed with</th></tr></thead>
                    <tbody>
                      {sep.result.classes.map((c) => (
                        <tr key={c.label}>
                          <td className="ex-nowrap"><span className="swatch" style={{ background: colorOf.get(c.label) ?? '#888' }} />{c.label}</td>
                          <td className="num">{c.specimens}{c.halved && <span className="muted" title="Only one specimen: tested against the other half of it"> *</span>}</td>
                          <td className="num">{Math.round(c.recall * 100)}%</td>
                          <td className="small">{c.recall < 0.98 && c.confusedWith ? c.confusedWith : <span className="muted">–</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted small ex-hint">
                  How this is worked out: each cycle looks at its {sep.result.k} nearest cycles from <i>other</i> specimens and takes their
                  majority class, like a very simple model tested on specimens it has not seen. Based on {sep.result.n.toLocaleString()} of
                  {' '}{ds.samples.length.toLocaleString()} cycles{sep.ms !== null ? `, took ${fmtSec(sep.ms)}` : ''}.
                </p>
              </>
            )}
          </div>
          <div>
            {proj === 'umap' && umapCurrent && !umapCurrent.ms && !umapCurrent.error && (
              <div className="ex-progress small">
                <span>Arranging the map… {Math.round((100 * umapCurrent.done) / Math.max(umapCurrent.total, 1))}%</span>
                <progress max={umapCurrent.total} value={umapCurrent.done} />
              </div>
            )}
            {umapCurrent?.error && proj === 'umap' && <div className="notice error">UMAP failed: {umapCurrent.error}</div>}
            {points ? (
              <Scatter
                points={points}
                colors={colors}
                faded={proj === 'umap' && !umapCurrent?.ms}
                xLabel={proj === 'pca' && pcaRes ? `PC1: ${Math.round(pcaRes.explained[0] * 100)}% of the variation` : 'UMAP 1'}
                yLabel={proj === 'pca' && pcaRes ? `PC2: ${Math.round(pcaRes.explained[1] * 100)}%` : 'UMAP 2'}
                tooltip={tooltip}
              />
            ) : (
              <div className="ex-scatter-placeholder muted small">Preparing the map…</div>
            )}
            <div className="row small ex-legend">
              {ds.labels.filter((l) => ds.samples.some((x) => ds.labels[x.y] === l)).map((l) => (
                <span key={l}><span className="swatch" style={{ background: colorOf.get(l) ?? '#888' }} />{l}</span>
              ))}
            </div>
            <p className="muted small ex-hint">
              {proj === 'pca'
                ? 'PCA flattens the data along its two biggest differences, keeping distances honest. If the classes separate here, they differ strongly.'
                : 'UMAP bends the data to keep close neighbours together, so it shows clusters PCA can miss, but gaps and distances between clouds do not mean much.'}
              {' '}Showing {sub.length.toLocaleString()} of {ds.samples.length.toLocaleString()} cycles
              {proj === 'umap' && umapCurrent?.ms ? `; arranged in ${fmtSec(umapCurrent.ms)}` : ''}. Hover or tap a dot to see where it came from.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
