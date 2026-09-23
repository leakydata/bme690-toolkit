/**
 * Train: choose what to tell apart and from which data, train a model, see
 * an honest score (on specimens the model never saw) next to the
 * AI-Studio-style one, save it, run it, export it.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../../app/state.tsx';
import type { DatasetSpec, Project, Recording } from '../../core/types.ts';
import { buildDataset, heaterProfilesIn } from '../../ml/dataset.ts';
import { getFeatureSets } from '../../ml/features.ts';
import { pct } from '../../ml/metrics.ts';
import { getModelKind, getModelKinds, type ModelKind, type ParamSpec, type ParamValue } from '../../ml/models.ts';
import '../../ml/models/index.ts';
import { sensorColor } from '../../ui/format.ts';
import { registerView } from '../registry.ts';
import { axis, cssVar, Plot } from './chart.tsx';
import { problemWith, splitOf, toRecord, trainAndEvaluate, type Phase, type SplitMode, type TrainOutcome, type TrainRequest } from './pipeline.ts';
import { Results } from './results.tsx';
import { findHeater, labelColors, SavedModels } from './saved.tsx';
import './train.css';

/** Params shown up front; the rest go under "More options". */
const BASIC: Record<string, string[]> = {
  mlp: ['hiddenLayers', 'units', 'epochs'],
  forest: ['trees'],
  knn: ['k'],
};

interface Settings {
  include: Record<string, boolean>;
  trainAs: Record<string, string>;
  heaterProfile: string;
  featureSet: string;
  mode: 'per-sensor' | 'fused';
  /** chosen sensors; empty = all available */
  sensors: number[];
  environment: boolean;
  split: SplitMode;
  testFraction: number;
  kind: string;
  params: Record<string, Record<string, ParamValue>>;
}

const KEY = (id: string) => `bme-studio:train:${id}`;

function defaults(p: Project, recs: Recording[]): Settings {
  const withCycles = new Set<string>();
  for (const r of recs) {
    const used = new Set(r.cycles.map((c) => c.specimen));
    r.specimens.forEach((sp, i) => { if (sp.classId && used.has(i)) withCycles.add(sp.classId); });
  }
  return {
    include: Object.fromEntries(p.classes.map((c) => [c.id, withCycles.has(c.id)])),
    trainAs: {},
    heaterProfile: heaterProfilesIn(recs)[0]?.id ?? '',
    featureSet: getFeatureSets().some((f) => f.id === 'shape') ? 'shape' : getFeatureSets()[0]?.id ?? '',
    mode: 'per-sensor',
    sensors: [],
    environment: false,
    split: 'specimen',
    testFraction: 0.3,
    kind: 'mlp',
    params: {},
  };
}

function useSettings(p: Project, recs: Recording[]): [Settings, (patch: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings>(() => {
    const d = defaults(p, recs);
    try {
      const saved = JSON.parse(localStorage.getItem(KEY(p.id)) ?? 'null') as Partial<Settings> | null;
      if (saved) return { ...d, ...saved, include: { ...d.include, ...saved.include } };
    } catch {
      // storage blocked or damaged: start from defaults
    }
    return d;
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY(p.id), JSON.stringify(s));
    } catch {
      // not important
    }
  }, [p.id, s]);
  return [s, (patch) => setS((x) => ({ ...x, ...patch }))];
}

function ParamInput({ spec, value, onChange }: { spec: ParamSpec; value: ParamValue; onChange: (v: ParamValue) => void }) {
  if (spec.type === 'boolean') {
    return (
      <label className="train-check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span><b>{spec.label}</b>{spec.help && <span className="muted small"> — {spec.help}</span>}</span>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{spec.label}</span>
      {spec.type === 'select' ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type="number" value={String(value)} min={spec.min} max={spec.max} step={spec.step ?? 'any'}
          onChange={(e) => onChange(e.target.value === '' ? spec.default : Number(e.target.value))} />
      )}
      {spec.help && <span className="small">{spec.help}</span>}
    </label>
  );
}

interface RunState {
  phase: Phase;
  fraction: number;
  message: string;
  loss: Record<Phase, number[]>;
  valLoss: number[];
}

function LossChart({ run, split }: { run: RunState; split: SplitMode }) {
  const n = Math.max(run.loss.main.length, run.loss.other.length);
  const hasVal = run.valLoss.length > 0;
  const pad = (a: number[]) => Array.from({ length: n }, (_, i) => a[i] ?? null);
  const data = [Array.from({ length: n }, (_, i) => i + 1), pad(run.loss.main), pad(run.loss.other), ...(hasVal ? [pad(run.valLoss)] : [])] as [number[], ...(number | null)[][]];
  const mainName = split === 'specimen' ? 'honest-test model' : 'random-test model';
  const otherName = split === 'specimen' ? 'random-test model' : 'honest-test model';
  return (
    <Plot
      label="Training loss per pass: lower means the network fits its training data better"
      optionsKey={`loss-${hasVal}-${split}`}
      height={200}
      data={data}
      options={() => ({
        legend: { show: true },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: false } },
        axes: [axis({ label: 'pass (epoch)', size: 40 }), axis({ label: 'loss', size: 50 })],
        series: [
          { label: 'pass' },
          { label: `loss, ${mainName}`, stroke: cssVar('--accent'), width: 2, points: { show: false } },
          { label: `loss, ${otherName}`, stroke: cssVar('--muted'), width: 1.5, dash: [5, 4], points: { show: false } },
          ...(hasVal ? [{ label: 'loss on held-back data', stroke: cssVar('--warn'), width: 1.5, points: { show: false } }] : []),
        ],
      })}
    />
  );
}

function Trainer({ req, blocked, recordings, onDone, onStart }: {
  req: TrainRequest; blocked: string | null; recordings: Recording[];
  onDone: (o: TrainOutcome) => void; onStart: () => void;
}) {
  const s = useStudio();
  const [run, setRun] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const lastPaint = useRef(0);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    const ac = new AbortController();
    abort.current = ac;
    const st: RunState = { phase: 'main', fraction: 0, message: 'Preparing the data…', loss: { main: [], other: [] }, valLoss: [] };
    setRun({ ...st });
    setBusy(true);
    onStart();
    try {
      await new Promise((r) => setTimeout(r, 20));
      const o = await trainAndEvaluate(recordings, req, (phase, p) => {
        st.phase = phase;
        st.fraction = p.fraction;
        st.message = p.message;
        if (p.loss !== undefined) st.loss[phase].push(p.loss);
        if (p.valLoss !== undefined && phase === 'main') st.valLoss.push(p.valLoss);
        const now = performance.now();
        if (now - lastPaint.current > 60 || p.fraction >= 1) {
          lastPaint.current = now;
          setRun({ ...st, loss: { main: [...st.loss.main], other: [...st.loss.other] }, valLoss: [...st.valLoss] });
        }
      }, ac.signal);
      onDone(o);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') s.toast('Training cancelled.');
      else s.toast(`Training failed: ${err.message}`, 'error');
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const overall = run ? (run.phase === 'main' ? run.fraction * 0.5 : 0.5 + run.fraction * 0.5) : 0;
  const isNet = req.kind === 'mlp';
  return (
    <div className="card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>5. Train</h2>
        <div className="row">
          {busy
            ? <button className="btn danger" onClick={() => abort.current?.abort()}>Cancel</button>
            : <button className="btn primary" disabled={!!blocked} onClick={start}>Train and test</button>}
        </div>
      </div>
      {blocked && !busy && <div className="notice warn small" style={{ marginTop: 10 }}>{blocked}</div>}
      <p className="muted small" style={{ marginTop: 8 }}>
        Trains two models: one tested your chosen way, and one tested the other way, so you can compare the scores. The first one is the one you can save.
      </p>
      {run && (busy || isNet) && (
        <div className="stack">
          {busy && (
            <>
              <div className="train-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
                <span style={{ width: `${overall * 100}%` }} />
              </div>
              <p className="small">
                {run.phase === 'main' ? 'Training the model you will keep' : 'Training a second model to test the other way'} — {run.message}
              </p>
            </>
          )}
          {isNet && (run.loss.main.length > 0 || run.loss.other.length > 0) && <LossChart run={run} split={req.split} />}
        </div>
      )}
    </div>
  );
}

function TrainView() {
  const studio = useStudio();
  const p = studio.project!;
  const recs = studio.recordings;
  const [st, set] = useSettings(p, recs);
  const [outcome, setOutcome] = useState<TrainOutcome | null>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);

  const profiles = useMemo(() => heaterProfilesIn(recs), [recs]);
  const heaterProfile = profiles.some((h) => h.id === st.heaterProfile) ? st.heaterProfile : profiles[0]?.id ?? '';
  const availableSensors = useMemo(() => {
    const set = new Set<number>();
    for (const r of recs) for (const c of r.cycles) if (c.heaterProfile === heaterProfile) set.add(c.sensor);
    return [...set].sort((a, b) => a - b);
  }, [recs, heaterProfile]);
  const chosenSensors = st.sensors.filter((x) => availableSensors.includes(x));
  const sensors = chosenSensors.length ? chosenSensors : availableSensors;

  const labelOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of p.classes) if (st.include[c.id]) m[c.id] = (st.trainAs[c.id] ?? '').trim() || c.name;
    return m;
  }, [p.classes, st.include, st.trainAs]);

  const spec: DatasetSpec = useMemo(() => ({
    featureSet: st.featureSet,
    environment: st.environment,
    heaterProfile,
    // Per sensor with every sensor: store "any", so the model runs on any sensor with this heater profile later.
    sensors: st.mode === 'per-sensor' && sensors.length === availableSensors.length ? [] : sensors,
    mode: st.mode,
    labelOf,
  }), [st.featureSet, st.environment, heaterProfile, st.mode, sensors, availableSensors.length, labelOf]);

  // Per class: cycles and specimens with this heater profile and these sensors.
  const counts = useMemo(() => {
    const m = new Map<string, { cycles: number; specimens: Set<string> }>();
    for (const r of recs) {
      for (const c of r.cycles) {
        if (c.heaterProfile !== heaterProfile || !sensors.includes(c.sensor)) continue;
        const cls = r.specimens[c.specimen]?.classId;
        if (!cls) continue;
        const e = m.get(cls) ?? { cycles: 0, specimens: new Set<string>() };
        e.cycles++;
        e.specimens.add(`${r.id}:${c.specimen}`);
        m.set(cls, e);
      }
    }
    return m;
  }, [recs, heaterProfile, sensors]);

  const deferredSpec = useDeferredValue(spec);
  const preview = useMemo(() => {
    try {
      const ds = buildDataset(recs, deferredSpec);
      const problem = problemWith(ds);
      const split = problem ? null : splitOf(ds, st.split, st.testFraction);
      const perLabel = ds.labels.map((l, y) => {
        const own = ds.samples.filter((x) => x.y === y);
        return { label: l, samples: own.length, specimens: new Set(own.map((x) => x.group)).size };
      });
      return { ds, problem, split, perLabel };
    } catch (e) {
      return { ds: null, problem: (e as Error).message, split: null, perLabel: [] };
    }
  }, [recs, deferredSpec, st.split, st.testFraction]);

  const kinds = getModelKinds();
  const kind: ModelKind | undefined = kinds.find((k) => k.id === st.kind) ?? kinds[0];
  const params: Record<string, ParamValue> = useMemo(() => {
    const own = st.params[kind?.id ?? ''] ?? {};
    return Object.fromEntries((kind?.params ?? []).map((ps) => [ps.key, own[ps.key] ?? ps.default]));
  }, [kind, st.params]);
  const setParam = (key: string, v: ParamValue) => set({ params: { ...st.params, [kind.id]: { ...st.params[kind.id], [key]: v } } });
  const basic = BASIC[kind?.id ?? ''];
  const basicParams = kind ? kind.params.filter((x) => !basic || basic.includes(x.key)) : [];
  const moreParams = kind ? kind.params.filter((x) => basic && !basic.includes(x.key)) : [];

  const req: TrainRequest = { spec, kind: kind?.id ?? '', params, split: st.split, testFraction: st.testFraction };
  const fsets = getFeatureSets();
  const fset = fsets.find((f) => f.id === st.featureSet);
  const heater = findHeater(recs, heaterProfile);

  if (recs.length === 0) {
    return (
      <>
        <div className="pagehead"><h1>Train</h1></div>
        <div className="card empty">No recordings in this project yet. Import some on the <a href="#data">Data</a> page and give their specimens classes.</div>
        <SavedModels />
      </>
    );
  }
  if (p.classes.length === 0) {
    return (
      <>
        <div className="pagehead"><h1>Train</h1></div>
        <div className="card empty">No classes yet. On the <a href="#data">Data</a> page, create classes such as “Coffee” and “Air” and assign them to specimens.</div>
        <SavedModels />
      </>
    );
  }

  const labelGroups = [...new Set(Object.values(labelOf))].sort();
  const colorsNow = outcome ? labelColors({ labels: outcome.labels, dataset: outcome.request.spec }, p.classes) : [];

  return (
    <>
      <div className="pagehead">
        <h1>Train</h1>
        <p>Teach a model to tell your classes apart, and find out honestly how well it will work on a sample it has never smelled.</p>
      </div>

      <div className="grid train-setup">
        <div className="card">
          <h2>1. What to tell apart</h2>
          <p className="muted small">Tick the classes to use. Give several classes the same “train as” name to group them, e.g. Espresso and Filter Coffee both as “Coffee”.</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Use</th><th>Class</th><th>Train as</th><th className="num">Specimens</th><th className="num">Cycles</th></tr></thead>
              <tbody>
                {p.classes.map((c) => {
                  const n = counts.get(c.id);
                  return (
                    <tr key={c.id}>
                      <td><input type="checkbox" checked={!!st.include[c.id]} aria-label={`Use ${c.name}`}
                        onChange={(e) => set({ include: { ...st.include, [c.id]: e.target.checked } })} /></td>
                      <td><span className="swatch" style={{ background: c.color }} />{c.name}</td>
                      <td><input className="train-as" value={st.trainAs[c.id] ?? c.name} disabled={!st.include[c.id]} aria-label={`Train ${c.name} as`}
                        onChange={(e) => set({ trainAs: { ...st.trainAs, [c.id]: e.target.value } })} /></td>
                      <td className="num">{n?.specimens.size ?? 0}</td>
                      <td className="num">{(n?.cycles ?? 0).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {labelGroups.length > 0 && (
            <div className="row small" style={{ marginTop: 10 }}>
              <span className="muted">The model will answer:</span>
              {labelGroups.map((l) => {
                const ids = Object.keys(labelOf).filter((id) => labelOf[id] === l);
                const cyc = ids.reduce((a, id) => a + (counts.get(id)?.cycles ?? 0), 0);
                const spc = ids.reduce((a, id) => a + (counts.get(id)?.specimens.size ?? 0), 0);
                return <span key={l} className={`pill${spc < 2 ? ' warn' : ''}`} title={`${cyc} cycles from ${spc} specimens`}>{l}: {spc} specimen{spc === 1 ? '' : 's'}, {cyc.toLocaleString()} cycles</span>;
              })}
            </div>
          )}
          <p className="muted small" style={{ marginTop: 8 }}>Counts are for the heater profile and sensors chosen in step 2.</p>
        </div>

        <div className="card">
          <h2>2. Which data</h2>
          <div className="stack">
            <label className="field">
              <span>Heater profile</span>
              <select value={heaterProfile} onChange={(e) => set({ heaterProfile: e.target.value, sensors: [] })}>
                {profiles.map((h) => <option key={h.id} value={h.id}>{h.name} — {h.cycles.toLocaleString()} cycles</option>)}
              </select>
              <span className="small">A model learns one heater profile’s pattern, so it only uses cycles made with it.{heater && <> Steps: {heater.steps.map((x) => x[0]).join(', ')} °C.</>}</span>
            </label>
            <label className="field">
              <span>Features</span>
              <select value={st.featureSet} onChange={(e) => set({ featureSet: e.target.value })}>
                {fsets.map((f) => <option key={f.id} value={f.id}>{f.name}{f.id === 'shape' ? ' (recommended)' : ''}</option>)}
              </select>
              {fset && <span className="small">{fset.description}</span>}
            </label>
            <fieldset className="train-radios">
              <legend className="small muted">Samples</legend>
              <label className="train-check">
                <input type="radio" name="mode" checked={st.mode === 'per-sensor'} onChange={() => set({ mode: 'per-sensor' })} />
                <span><b>One sensor at a time</b> <span className="muted small">— each sensor’s cycle is a sample, as in AI-Studio. More samples, and the model runs on any one sensor.</span></span>
              </label>
              <label className="train-check">
                <input type="radio" name="mode" checked={st.mode === 'fused'} onChange={() => set({ mode: 'fused' })} />
                <span><b>All chosen sensors at once</b> <span className="muted small">— one sample holds every chosen sensor’s cycle from the same moment. Fewer samples; needs the same sensors later.</span></span>
              </label>
            </fieldset>
          </div>
        </div>

        <div className="card">
          <h2>3. How to test</h2>
          <fieldset className="train-radios">
            <label className="train-check">
              <input type="radio" name="split" checked={st.split === 'specimen'} onChange={() => set({ split: 'specimen' })} />
              <span><b>Test on specimens the model has never seen</b> <span className="pill ok">recommended</span><br />
                <span className="muted small">Whole specimens are kept out of training. The score is what to expect on a new sample.</span></span>
            </label>
            <label className="train-check">
              <input type="radio" name="split" checked={st.split === 'random'} onChange={() => set({ split: 'random' })} />
              <span><b>Random cycles</b> <span className="pill warn">like AI-Studio — optimistic</span><br />
                <span className="muted small">Cycles are picked at random, so near-identical neighbours of each test cycle were in training.</span></span>
            </label>
          </fieldset>
          {preview.split && (
            <p className="small" style={{ marginTop: 8 }}>
              Train on <b>{preview.split.train.length.toLocaleString()}</b> samples, test on <b>{preview.split.test.length.toLocaleString()}</b>
              {st.split === 'specimen' && <> from {new Set(preview.split.test.map((x) => x.group)).size} held-out specimen(s)</>}.
            </p>
          )}
          {preview.split?.warning && <div className="notice warn small">{preview.split.warning}</div>}
          <p className="muted small">Both scores are always worked out, so you can compare them.</p>
        </div>

        <div className="card">
          <h2>4. Model</h2>
          <label className="field">
            <span>Kind</span>
            <select value={kind?.id} onChange={(e) => set({ kind: e.target.value })}>
              {kinds.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
            {kind && <span className="small">{kind.description}</span>}
          </label>
          <div className="train-params">
            {basicParams.map((ps) => <ParamInput key={ps.key} spec={ps} value={params[ps.key]} onChange={(v) => setParam(ps.key, v)} />)}
          </div>
        </div>
      </div>

      <details className="card train-more">
        <summary><b>More options</b> <span className="muted small">sensors, weather inputs, test share, fine-tuning the model</span></summary>
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="stack">
            <h3>Sensors</h3>
            <p className="muted small">Sensors that ran {heater?.name ?? 'this heater profile'}. Leave out one that misbehaved.</p>
            <div className="row">
              {availableSensors.map((x) => (
                <label key={x} className="train-check inline">
                  <input type="checkbox" checked={sensors.includes(x)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...sensors, x] : sensors.filter((y) => y !== x);
                      if (next.length) set({ sensors: next.sort((a, b) => a - b) });
                    }} />
                  <span><span className="swatch" style={{ background: sensorColor(x) }} />Sensor {x}</span>
                </label>
              ))}
            </div>
            <label className="train-check">
              <input type="checkbox" checked={st.environment} onChange={(e) => set({ environment: e.target.checked })} />
              <span><b>Also use temperature, humidity and pressure</b></span>
            </label>
            {st.environment && (
              <div className="notice warn small">
                Careful: these follow the weather and the time of day. If you recorded coffee in the morning and air in the afternoon, the model can learn the
                humidity instead of the smell, score well, and fail tomorrow. Use only if the classes really differ in them.
              </div>
            )}
            <label className="field">
              <span>Share kept back for testing: <b className="num">{Math.round(st.testFraction * 100)}%</b></span>
              <input type="range" min={0.1} max={0.5} step={0.05} value={st.testFraction} onChange={(e) => set({ testFraction: Number(e.target.value) })} />
              <span className="small">30% is usual. More gives a steadier score but less to learn from.</span>
            </label>
          </div>
          {moreParams.length > 0 && (
            <div className="stack">
              <h3>{kind.name}: fine-tuning</h3>
              {moreParams.map((ps) => <ParamInput key={ps.key} spec={ps} value={params[ps.key]} onChange={(v) => setParam(ps.key, v)} />)}
              <button className="btn small" onClick={() => set({ params: { ...st.params, [kind.id]: {} } })}>Reset to defaults</button>
            </div>
          )}
        </div>
      </details>

      <Trainer req={req} blocked={preview.problem ?? (kind ? null : 'No model kinds are available.')} recordings={recs}
        onStart={() => { setOutcome(null); setSaved(false); }}
        onDone={(o) => {
          setOutcome(o);
          const kn = getModelKind(o.request.kind).name.replace(/ \(.*\)$/, '');
          setName(`${o.labels.join(' vs ')} — ${kn}`);
        }} />

      {outcome && <Results outcome={outcome} colors={colorsNow} heater={findHeater(recs, outcome.request.spec.heaterProfile)} />}

      {outcome && (
        <div className="card">
          <h2>Save</h2>
          <p className="muted small">Keeps the model with the project, with its settings and scores, so the Live page can run it and you can export it.</p>
          <form className="row" onSubmit={async (e) => {
            e.preventDefault();
            try {
              await studio.saveModel(toRecord(outcome, name));
              setSaved(true);
              studio.toast(`Saved “${name}”. Honest score ${pct(outcome.main.split === 'specimen' ? outcome.main.scores.accuracy : outcome.other?.scores.accuracy ?? NaN, 1)}.`);
            } catch (err) {
              studio.toast(`Could not save: ${(err as Error).message}`, 'error');
            }
          }}>
            <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} aria-label="Model name" style={{ flex: '1 1 240px' }} />
            <button className="btn primary" disabled={saved}>{saved ? 'Saved' : 'Save model'}</button>
          </form>
        </div>
      )}

      <SavedModels />
    </>
  );
}

registerView({ id: 'train', title: 'Train', hint: 'Models and testing', order: 30, needsProject: true, component: TrainView });
