/**
 * The project's saved models: list, delete, export (JSON, C header), and
 * run one over a recording to see what it says, cycle by cycle, next to
 * what each specimen really was.
 */
import { useMemo, useRef, useState } from 'react';
import type uPlot from 'uplot';
import { useStudio } from '../../app/state.tsx';
import type { HeaterProfile, ModelRecord, Recording } from '../../core/types.ts';
import { mlpToCHeader } from '../../ml/export.ts';
import { getModelKind, getModelKinds } from '../../ml/models.ts';
import { newId } from '../../core/ids.ts';
import { pct } from '../../ml/metrics.ts';
import { loadRunner } from '../../ml/run.ts';
import { fmtValue, unitOf } from '../../core/values.ts';
import { download, fmtDate, sensorColor } from '../../ui/format.ts';
import { axis, cssVar, Plot } from './chart.tsx';
import {
  headlineOf, majorityBySpecimen, meanBySpecimen, modelTask, runOnRecording, runRegressionOnRecording,
  type RegRunPoint, type RunPoint, type SpecimenMean, type SpecimenVote,
} from './pipeline.ts';

const TRUTH_OFFSET = 0.3;

const fileName = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';

export function findHeater(recs: Recording[], id: string): HeaterProfile | undefined {
  for (const r of recs) {
    const h = r.config.heaterProfiles.find((x) => x.id === id);
    if (h) return h;
  }
  return undefined;
}

export function labelColors(m: Pick<ModelRecord, 'labels' | 'dataset'>, classes: { id: string; color: string }[]): string[] {
  const fallback = ['#4c8dff', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#64748b'];
  return m.labels.map((l, i) => {
    const cls = Object.entries(m.dataset?.labelOf ?? {}).find(([, v]) => v === l)?.[0];
    return classes.find((c) => c.id === cls)?.color ?? fallback[i % fallback.length];
  });
}

interface RunResult {
  modelId: string;
  recording: Recording;
  points: RunPoint[];
  votes: SpecimenVote[];
  ms: number;
}

interface RegRunResult {
  modelId: string;
  recording: Recording;
  points: RegRunPoint[];
  means: SpecimenMean[];
  ms: number;
}

function RunPanel({ model, onClose }: { model: ModelRecord; onClose: () => void }) {
  const s = useStudio();
  const [recId, setRecId] = useState(s.recordings[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RunResult | null>(null);
  const [reg, setReg] = useState<RegRunResult | null>(null);
  const regress = modelTask(model) === 'regress';
  const colors = labelColors(model, s.project?.classes ?? []);

  const run = async () => {
    const rec = s.recordings.find((r) => r.id === recId);
    if (!rec) return;
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r));
      const t0 = performance.now();
      const runner = await loadRunner(model);
      const nothing = () => s.toast(`No cycles in "${rec.name}" fit this model: it needs heater profile ${model.dataset.heaterProfile}${model.dataset.sensors?.length ? ` on sensor(s) ${model.dataset.sensors.join(', ')}` : ''}.`, 'error');
      if (runner.task === 'regress') {
        const points = runRegressionOnRecording(runner, rec);
        if (points.length === 0) {
          nothing();
          setReg(null);
          return;
        }
        setReg({ modelId: model.id, recording: rec, points, means: meanBySpecimen(points, rec), ms: performance.now() - t0 });
        return;
      }
      const points = runOnRecording(runner, rec);
      if (points.length === 0) {
        nothing();
        setRes(null);
        return;
      }
      setRes({ modelId: model.id, recording: rec, points, votes: majorityBySpecimen(points, rec, model.labels), ms: performance.now() - t0 });
    } catch (e) {
      s.toast(`Could not run the model: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card train-run">
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Run “{model.name}” on a recording</h3>
        <button className="btn small" onClick={onClose}>Close</button>
      </div>
      <p className="muted small">{regress
        ? `Estimates ${model.labels[0] ?? 'the value'} for every cycle of the recording that the model can read, and compares it with the value measured for the specimen it came from.`
        : 'Predicts every cycle of the recording that the model can read, and compares it with the class of the specimen it came from.'}</p>
      <div className="row">
        <select value={recId} onChange={(e) => setRecId(e.target.value)} aria-label="Recording to run the model on">
          {s.recordings.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button className="btn primary" disabled={busy || !recId} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
      </div>
      {!regress && res && res.modelId === model.id && <RunView res={res} model={model} colors={colors} />}
      {regress && reg && reg.modelId === model.id && <RegRunView res={reg} model={model} />}
    </div>
  );
}

function RunView({ res, model, colors }: { res: RunResult; model: ModelRecord; colors: string[] }) {
  const labels = model.labels;
  const t0 = res.recording.points.length ? res.recording.points.t[0] : res.points[0].t;
  const data = useMemo(() => {
    const xs = res.points.map((p) => (p.t - t0) / 60000);
    const series: (number | null)[][] = labels.map((_, li) => res.points.map((p) => (p.predicted === li ? li : null)));
    // Drawn a little above the predictions so both stay visible.
    const truth = res.points.map((p) => (p.truth >= 0 ? p.truth + TRUTH_OFFSET : null));
    return [xs, truth, ...series] as uPlot.AlignedData;
  }, [res, labels, t0]);
  const known = res.points.filter((p) => p.truth >= 0);
  const agree = known.filter((p) => p.truth === p.predicted).length;
  const specimensRight = res.votes.filter((v) => v.truth >= 0 && v.truth === v.majority).length;
  const specimensKnown = res.votes.filter((v) => v.truth >= 0).length;

  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <p className="small">
        {res.points.length.toLocaleString()} cycles predicted in {res.ms < 1000 ? `${res.ms.toFixed(0)} ms` : `${(res.ms / 1000).toFixed(1)} s`}.
        {known.length > 0 && <> On cycles from specimens with a known class it agreed <b>{pct(agree / known.length, 1)}</b> of the time;
          by majority vote it named <b>{specimensRight} of {specimensKnown}</b> specimens correctly.</>}
        {' '}Cycles the model also trained on are included, so this is not a fair test on its own.
      </p>
      <Plot
        label="Predicted label of each cycle over time, with the specimen's true class as a line"
        optionsKey={`run-${res.modelId}-${res.recording.id}-${res.points.length}`}
        height={Math.max(160, 70 + labels.length * 34)}
        data={data}
        options={() => ({
          legend: { show: true },
          cursor: { drag: { x: true, y: false } },
          scales: { x: { time: false }, y: { range: [-0.6, labels.length - 0.4] } },
          axes: [
            axis({ label: 'minutes into the recording', size: 40 }),
            axis({ size: 110, splits: () => labels.map((_, i) => i), values: (_u: uPlot, v: number[]) => v.map((i) => labels[i] ?? '') }),
          ],
          series: [
            { label: 'min', value: (_u, v) => (v == null ? '–' : v.toFixed(1)) },
            { label: 'Specimen is', stroke: cssVar('--muted'), width: 2, dash: [6, 4], spanGaps: false,
              value: (_u, v) => (v == null ? 'no class' : labels[Math.round(v - TRUTH_OFFSET)] ?? '') },
            ...labels.map((l, i) => ({
              label: `Said ${l}`,
              stroke: colors[i],
              fill: colors[i],
              width: 0,
              paths: () => null,
              points: { show: true, size: 5, stroke: colors[i], fill: colors[i] },
              value: (_u: uPlot, v: number | null) => (v == null ? '' : '●'),
            })),
          ],
        })}
      />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Specimen</th><th>Really</th><th className="num">Cycles</th><th>Majority said</th><th className="num">Share</th><th /></tr></thead>
          <tbody>
            {res.votes.map((v) => (
              <tr key={v.specimen}>
                <td>{v.name}</td>
                <td>{v.truth >= 0 ? <><span className="swatch" style={{ background: colors[v.truth] }} />{labels[v.truth]}</> : <span className="muted">not in model</span>}</td>
                <td className="num">{v.cycles}</td>
                <td><span className="swatch" style={{ background: colors[v.majority] }} />{labels[v.majority]}</td>
                <td className="num">{pct(v.share)}</td>
                <td>{v.truth < 0 ? null : v.truth === v.majority ? <span className="pill ok">right</span> : <span className="pill err">wrong</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RegRunView({ res, model }: { res: RegRunResult; model: ModelRecord }) {
  const target = model.labels[0] ?? '';
  const unit = unitOf(target);
  const t0 = res.recording.points.length ? res.recording.points.t[0] : res.points[0].t;
  const sensors = useMemo(() => [...new Set(res.points.map((p) => p.sensor))].sort((a, b) => (a ?? -1) - (b ?? -1)), [res]);
  const data = useMemo(() => {
    const xs = res.points.map((p) => (p.t - t0) / 60000);
    const truth = res.points.map((p) => p.truth);
    const series = sensors.map((s) => res.points.map((p) => (p.sensor === s ? p.value : null)));
    return [xs, truth, ...series] as uPlot.AlignedData;
  }, [res, sensors, t0]);
  const known = res.means.filter((m) => m.truth !== null);
  const withTruth = res.points.filter((p) => p.truth !== null);
  const mae = withTruth.length ? withTruth.reduce((a, p) => a + Math.abs(p.value - p.truth!), 0) / withTruth.length : NaN;
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <p className="small">
        {res.points.length.toLocaleString()} cycles estimated in {res.ms < 1000 ? `${res.ms.toFixed(0)} ms` : `${(res.ms / 1000).toFixed(1)} s`}.
        {withTruth.length > 0 && <> On cycles from {known.length} specimen{known.length === 1 ? '' : 's'} with a measured value it was off by <b>{fmtValue(mae, unit)}</b> on average.</>}
        {' '}Cycles the model also trained on are included, so this is not a fair test on its own.
      </p>
      <Plot
        label={`Estimated ${target} of each cycle over time, with the specimen's measured value as a dashed line`}
        optionsKey={`regrun-${res.modelId}-${res.recording.id}-${res.points.length}`}
        height={260}
        data={data}
        options={() => ({
          legend: { show: true },
          cursor: { drag: { x: true, y: false } },
          scales: { x: { time: false } },
          axes: [axis({ label: 'minutes into the recording', size: 40 }), axis({ label: target, size: 60 })],
          series: [
            { label: 'min', value: (_u, v) => (v == null ? '–' : v.toFixed(1)) },
            { label: 'Measured', stroke: cssVar('--text'), width: 2, dash: [6, 4], spanGaps: false, points: { show: false },
              value: (_u, v) => (v == null ? 'no value' : fmtValue(v, unit)) },
            ...sensors.map((sn) => {
              const c = sn === null ? cssVar('--accent') : sensorColor(sn);
              return {
                label: sn === null ? 'Estimate' : `Sensor ${sn}`,
                stroke: c, fill: c, width: 0, paths: () => null,
                points: { show: true, size: 4, stroke: c, fill: c },
                value: (_u: uPlot, v: number | null) => (v == null ? '' : fmtValue(v, unit)),
              };
            }),
          ],
        })}
      />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Specimen</th><th className="num">Measured</th><th className="num">Average estimate</th><th className="num">Off by</th><th className="num">Cycles</th></tr></thead>
          <tbody>
            {res.means.map((m) => (
              <tr key={m.specimen}>
                <td>{m.name}</td>
                <td className="num">{m.truth === null ? <span className="muted">not measured</span> : fmtValue(m.truth, unit)}</td>
                <td className="num">{fmtValue(m.mean, unit)}</td>
                <td className="num">{m.truth === null ? '' : `${m.mean >= m.truth ? '+' : '−'}${fmtValue(Math.abs(m.mean - m.truth), unit)}`}</td>
                <td className="num">{m.cycles}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Bring in a model file: one exported from another project, or trained in
 *  the Python lab. Class ids differ between projects, so classes the file
 *  names are matched to this project's classes by name. */
function ImportModel() {
  const s = useStudio();
  const input = useRef<HTMLInputElement>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      let m: ModelRecord;
      try {
        m = JSON.parse(await f.text());
      } catch {
        throw new Error('That file is not a model (it is not JSON).');
      }
      if (!m || typeof m !== 'object' || !m.kind || !m.dataset || !Array.isArray(m.labels) || !Array.isArray(m.featureNames)) {
        throw new Error('That file is not a BME Studio model (.bmemodel.json).');
      }
      if (!getModelKinds().some((k) => k.id === m.kind)) {
        throw new Error(`This model is a "${m.kind}", which this version of the studio can't run.`);
      }
      await getModelKind(m.kind).load(m.state);   // fails early on a damaged file
      const classes = s.project?.classes ?? [];
      const labelOf: Record<string, string> = {};
      const unmatched: string[] = [];
      for (const [k, v] of Object.entries(m.dataset.labelOf ?? {})) {
        const c = classes.find((x) => x.id === k) ?? classes.find((x) => x.name.toLowerCase() === k.toLowerCase());
        if (c) labelOf[c.id] = v;
        else unmatched.push(k);
      }
      const taken = (s.project?.models ?? []).some((x) => x.id === m.id);
      await s.saveModel({ ...m, id: taken || !m.id ? newId('mdl') : m.id, dataset: { ...m.dataset, labelOf } });
      s.toast(unmatched.length
        ? `Imported "${m.name}". This project has no class called ${unmatched.join(', ')}; the model still runs, but can't be scored against those.`
        : `Imported "${m.name}".`);
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <button className="btn small" onClick={() => input.current?.click()} title="A .bmemodel.json from another project or the Python lab">Import model…</button>
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </>
  );
}

export function SavedModels() {
  const s = useStudio();
  const models = [...(s.project?.models ?? [])].sort((a, b) => b.created - a.created);
  const [running, setRunning] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const kindName = (id: string) => getModelKinds().find((k) => k.id === id)?.name ?? id;

  if (models.length === 0) {
    return (
      <div className="card">
        <div className="row spread"><h2 style={{ margin: 0 }}>Saved models</h2><ImportModel /></div>
        <p className="muted" style={{ marginTop: 8 }}>None yet. Train a model above and save it to use it on the Live page, or import one.</p>
      </div>
    );
  }
  const exportJson = (m: ModelRecord) => download(`${fileName(m.name)}.bmemodel.json`, JSON.stringify(m), 'application/json');
  const exportC = (m: ModelRecord) => {
    try {
      download(`${fileName(m.name)}.h`, mlpToCHeader(m, { heaterProfile: findHeater(s.recordings, m.dataset.heaterProfile) }), 'text/x-c');
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };
  const runModel = models.find((m) => m.id === running);

  return (
    <>
      <div className="card">
        <div className="row spread"><h2 style={{ margin: 0 }}>Saved models</h2><ImportModel /></div>
        <p className="muted small" style={{ marginTop: 8 }}>Saved with the project. The Live page can run any of them on the board’s cycles as they arrive.</p>
        <div className="table-wrap">
          <table className="data train-saved">
            <thead><tr><th>Name</th><th>Kind</th><th>What it does</th><th className="num" title="On specimens the model never saw: accuracy, or for estimates the average error">Honest score</th><th>Saved</th><th /></tr></thead>
            <tbody>
              {models.map((m) => {
                const h = headlineOf(m);
                const show = (v: number) => (h.task === 'regress' ? `±${fmtValue(v, h.unit)}` : pct(v, 1));
                return (
                  <tr key={m.id}>
                    <td><b>{m.name}</b></td>
                    <td className="small">{kindName(m.kind)}</td>
                    <td className="small">{h.task === 'regress'
                      ? <><span className="pill">estimates</span> {h.target}</>
                      : <><span className="pill">tells apart</span> {(m.labels ?? []).join(', ')}</>}</td>
                    <td className="num" title={h.task === 'regress' ? 'Average error on specimens the model never saw' : 'Accuracy on specimens the model never saw'}>
                      {h.honest !== null ? show(h.honest) : '–'}
                      {h.random !== null && <div className="muted small" title="Random-cycle score, as AI-Studio reports it">AI-Studio way {show(h.random)}</div>}</td>
                    <td className="small">{fmtDate(m.created)}</td>
                    <td>
                      <div className="row train-actions">
                        <button className="btn small" onClick={() => setRunning(running === m.id ? null : m.id)}>Run…</button>
                        <button className="btn small" onClick={() => exportJson(m)} title="The whole model as JSON, to keep or share">JSON</button>
                        {m.kind === 'mlp' && <button className="btn small" onClick={() => exportC(m)} title="C header for the ESP32 firmware">C header</button>}
                        {confirm === m.id ? (
                          <>
                            <button className="btn small danger" onClick={async () => { await s.deleteModel(m.id); setConfirm(null); if (running === m.id) setRunning(null); }}>Delete</button>
                            <button className="btn small" onClick={() => setConfirm(null)}>Keep</button>
                          </>
                        ) : <button className="btn small danger" onClick={() => setConfirm(m.id)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {runModel && <RunPanel key={runModel.id} model={runModel} onClose={() => setRunning(null)} />}
    </>
  );
}
