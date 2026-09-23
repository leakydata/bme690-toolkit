/**
 * The project's saved models: list, delete, export (JSON, C header), and
 * run one over a recording to see what it says, cycle by cycle, next to
 * what each specimen really was.
 */
import { useMemo, useState } from 'react';
import type uPlot from 'uplot';
import { useStudio } from '../../app/state.tsx';
import type { HeaterProfile, ModelRecord, Recording } from '../../core/types.ts';
import { mlpToCHeader } from '../../ml/export.ts';
import { getModelKinds } from '../../ml/models.ts';
import { pct } from '../../ml/metrics.ts';
import { loadRunner } from '../../ml/run.ts';
import { download, fmtDate } from '../../ui/format.ts';
import { axis, cssVar, Plot } from './chart.tsx';
import { majorityBySpecimen, runOnRecording, type RunPoint, type SavedMetrics, type SpecimenVote } from './pipeline.ts';

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
    const cls = Object.entries(m.dataset.labelOf).find(([, v]) => v === l)?.[0];
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

function RunPanel({ model, onClose }: { model: ModelRecord; onClose: () => void }) {
  const s = useStudio();
  const [recId, setRecId] = useState(s.recordings[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<RunResult | null>(null);
  const colors = labelColors(model, s.project?.classes ?? []);

  const run = async () => {
    const rec = s.recordings.find((r) => r.id === recId);
    if (!rec) return;
    setBusy(true);
    try {
      await new Promise((r) => setTimeout(r));
      const t0 = performance.now();
      const runner = await loadRunner(model);
      const points = runOnRecording(runner, rec);
      if (points.length === 0) {
        s.toast(`No cycles in "${rec.name}" fit this model: it needs heater profile ${model.dataset.heaterProfile}${model.dataset.sensors.length ? ` on sensor(s) ${model.dataset.sensors.join(', ')}` : ''}.`, 'error');
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
      <p className="muted small">Predicts every cycle of the recording that the model can read, and compares it with the class of the specimen it came from.</p>
      <div className="row">
        <select value={recId} onChange={(e) => setRecId(e.target.value)} aria-label="Recording to run the model on">
          {s.recordings.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button className="btn primary" disabled={busy || !recId} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
      </div>
      {res && res.modelId === model.id && <RunView res={res} model={model} colors={colors} />}
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

export function SavedModels() {
  const s = useStudio();
  const models = [...(s.project?.models ?? [])].sort((a, b) => b.created - a.created);
  const [running, setRunning] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const kindName = (id: string) => getModelKinds().find((k) => k.id === id)?.name ?? id;

  if (models.length === 0) {
    return <div className="card"><h2>Saved models</h2><p className="muted">None yet. Train a model above and save it to use it on the Live page.</p></div>;
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
        <h2>Saved models</h2>
        <p className="muted small">Saved with the project. The Live page can run any of them on the board’s cycles as they arrive.</p>
        <div className="table-wrap">
          <table className="data train-saved">
            <thead><tr><th>Name</th><th>Kind</th><th>Tells apart</th><th className="num" title="Accuracy on specimens the model never saw">Honest score</th><th>Saved</th><th /></tr></thead>
            <tbody>
              {models.map((m) => {
                const met = m.metrics as Partial<SavedMetrics>;
                return (
                  <tr key={m.id}>
                    <td><b>{m.name}</b></td>
                    <td className="small">{kindName(m.kind)}</td>
                    <td className="small">{m.labels.join(', ')}</td>
                    <td className="num">{typeof met.honestAccuracy === 'number' ? pct(met.honestAccuracy, 1) : '–'}
                      {typeof met.randomAccuracy === 'number' && <div className="muted small" title="Random-cycle score, as AI-Studio reports it">AI-Studio way {pct(met.randomAccuracy, 1)}</div>}</td>
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
