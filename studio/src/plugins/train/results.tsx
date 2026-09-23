/**
 * What a training run found, in words first and numbers second: the honest
 * score next to the AI-Studio-style one, the mistakes, how confidence trades
 * against coverage, and which heater steps mattered.
 */
import { useMemo, useState } from 'react';
import type { HeaterProfile } from '../../core/types.ts';
import { atThreshold, pct, summarize, type Scores } from '../../ml/metrics.ts';
import { axis, cssVar, Plot } from './chart.tsx';
import type { Evaluation, TrainOutcome } from './pipeline.ts';

export const SPLIT_NAME = {
  specimen: 'Specimens it never saw',
  random: 'Random cycles (AI-Studio way)',
} as const;

/** Headline: both scores side by side, and why they differ. */
export function ScorePair({ main, other }: { main: { split: 'specimen' | 'random'; accuracy: number; nTest: number; testSpecimens: number; warning: string | null }; other: { split: 'specimen' | 'random'; accuracy: number; nTest: number; testSpecimens: number; warning: string | null } | null }) {
  const honest = main.split === 'specimen' ? main : other;
  const random = main.split === 'random' ? main : other;
  const gap = honest && random ? random.accuracy - honest.accuracy : null;
  const warning = honest?.warning ?? null;
  return (
    <div className="stack">
      <div className="train-scores">
        {honest && (
          <div className="train-score">
            <div className="small muted">Honest score: {SPLIT_NAME.specimen.toLowerCase()}</div>
            <div className="train-big num">{pct(honest.accuracy, 1)}</div>
            <div className="small muted">{honest.nTest.toLocaleString()} test cycles from {honest.testSpecimens} specimen{honest.testSpecimens === 1 ? '' : 's'} left out of training</div>
          </div>
        )}
        {random && (
          <div className="train-score">
            <div className="small muted">What AI-Studio would report: random cycles</div>
            <div className="train-big num muted">{pct(random.accuracy, 1)}</div>
            <div className="small muted">{random.nTest.toLocaleString()} test cycles picked at random; their neighbours were in training</div>
          </div>
        )}
      </div>
      {gap !== null && (
        <p className="small">
          {gap > 0.02
            ? <>The random test scores <b>{(gap * 100).toFixed(1)} points higher</b>. That gap is flattery, not skill: neighbouring cycles of one specimen are nearly identical, so a random test is full of near-copies of what the model trained on. Expect the honest score on a new sample.</>
            : gap < -0.02
              ? <>The honest score is higher this time, which happens by chance with few specimens. Treat both numbers as rough.</>
              : <>Both tests agree to within {Math.max(Math.abs(gap * 100), 0.1).toFixed(1)} points: a good sign the model learned the smell itself rather than recognising individual specimens.</>}
        </p>
      )}
      {warning && <div className="notice warn small">{warning}</div>}
    </div>
  );
}

export function Confusion({ confusion, labels, colors, caption }: { confusion: number[][]; labels: string[]; colors: string[]; caption?: string }) {
  const max = Math.max(1, ...confusion.flat());
  return (
    <div className="table-wrap">
      <table className="data train-confusion">
        {caption && <caption className="small muted">{caption}</caption>}
        <thead>
          <tr>
            <th>Was ↓ / Model said →</th>
            {labels.map((l, j) => <th key={j} className="num"><span className="swatch" style={{ background: colors[j] }} />{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {confusion.map((row, i) => (
            <tr key={i}>
              <th scope="row"><span className="swatch" style={{ background: colors[i] }} />{labels[i]}</th>
              {row.map((c, j) => {
                const share = c / max;
                const tone = i === j ? 'var(--ok)' : 'var(--err)';
                return (
                  <td key={j} className="num" title={`${c} cycles of ${labels[i]} were called ${labels[j]}`}
                    style={{ background: c ? `color-mix(in srgb, ${tone} ${Math.round(12 + share * 55)}%, transparent)` : undefined, fontWeight: c ? 600 : 400 }}>
                    {c}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PerLabel({ s, labels, colors }: { s: Pick<Scores, 'precision' | 'recall' | 'support'>; labels: string[]; colors: string[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Label</th>
            <th className="num">Test cycles</th>
            <th className="num" title="Of the real cycles of this label, the share the model recognised">Found (recall)</th>
            <th className="num" title="When the model said this label, the share of times it was right">Right when it said so (precision)</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={i}>
              <td><span className="swatch" style={{ background: colors[i] }} />{l}</td>
              <td className="num">{s.support[i]}</td>
              <td className="num">{pct(s.recall[i])}</td>
              <td className="num">{pct(s.precision[i])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Not sure" below a confidence: how many answers remain, and how good they are. */
export function Threshold({ ev }: { ev: Evaluation }) {
  const [t, setT] = useState(0.8);
  const at = useMemo(() => atThreshold(ev.yTest, ev.probs, t), [ev, t]);
  const data = useMemo(() => {
    const xs: number[] = [];
    const cov: number[] = [];
    const acc: (number | null)[] = [];
    for (let v = 0.3; v <= 1.0001; v += 0.01) {
      const p = atThreshold(ev.yTest, ev.probs, v);
      xs.push(Math.round(v * 100));
      cov.push(p.coverage * 100);
      acc.push(Number.isFinite(p.accuracy) ? p.accuracy * 100 : null);
    }
    return [xs, cov, acc] as [number[], number[], (number | null)[]];
  }, [ev]);
  const tRef = t;
  return (
    <div className="stack">
      <label className="field">
        <span>Answer “not sure” below <b className="num">{Math.round(t * 100)}%</b> confidence</span>
        <input type="range" min={0.3} max={0.99} step={0.01} value={t} onChange={(e) => setT(Number(e.target.value))} />
      </label>
      <p className="small">
        At {Math.round(t * 100)}% it answers <b>{pct(at.coverage)}</b> of the test cycles and is right on <b>{pct(at.accuracy, 1)}</b> of those;
        it says “not sure” for the other {pct(1 - at.coverage)}. {at.coverage < 0.999 && at.accuracy > ev.scores.accuracy + 0.005
          ? 'Holding back unsure answers makes the ones it gives more trustworthy.'
          : 'Raising the bar would not buy much accuracy here.'}
      </p>
      <Plot
        label="Share of cycles answered and accuracy of those answers, for each confidence threshold"
        optionsKey={`thr-${tRef}`}
        height={180}
        data={data}
        options={() => ({
          legend: { show: true },
          cursor: { drag: { x: false, y: false } },
          scales: { x: { time: false }, y: { range: [0, 100] } },
          axes: [axis({ label: 'confidence threshold %', size: 40 }), axis({ label: '%', size: 44 })],
          series: [
            { label: 'threshold' },
            { label: 'answered', stroke: cssVar('--accent'), width: 2, points: { show: false }, value: (_u, v) => (v == null ? '–' : `${v.toFixed(0)}%`) },
            { label: 'right when answering', stroke: cssVar('--ok'), width: 2, points: { show: false }, value: (_u, v) => (v == null ? '–' : `${v.toFixed(1)}%`) },
          ],
          hooks: {
            draw: [(u) => {
              const x = u.valToPos(Math.round(tRef * 100), 'x', true);
              const ctx = u.ctx;
              ctx.save();
              ctx.strokeStyle = cssVar('--muted');
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
              ctx.restore();
            }],
          },
        })}
      />
    </div>
  );
}

/** Heater step (1-based) of a feature name like "shape step 4", or null. */
export function stepOf(name: string): number | null {
  const m = /step (\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

export function Importance({ names, values, heater }: { names: string[]; values: number[]; heater?: HeaterProfile }) {
  const describe = (step: number) => {
    const s = heater?.steps[step - 1];
    return s ? `step ${step} at ${s[0]} °C` : `step ${step}`;
  };
  const byStep = new Map<number, number>();
  names.forEach((n, i) => {
    const st = stepOf(n);
    if (st) byStep.set(st, (byStep.get(st) ?? 0) + values[i]);
  });
  const topStep = [...byStep.entries()].sort((a, b) => b[1] - a[1])[0];
  const rows = names.map((n, i) => ({ n, v: values[i], step: stepOf(n) })).sort((a, b) => b.v - a.v).slice(0, 16);
  const max = Math.max(1e-9, ...rows.map((r) => r.v));
  const top = rows[0];
  return (
    <div className="stack">
      <p className="small">
        {topStep && <>Heater <b>{describe(topStep[0])}</b> carries the most information ({pct(topStep[1])} of the forest's decisions). </>}
        {top && !top.step && <><b>{top.n}</b> is the single most used input ({pct(top.v)}). </>}
        Steps near the bottom add little; a heater profile could spend less time on them.
      </p>
      <div className="train-bars" role="list" aria-label="Importance of each input">
        {rows.map((r) => (
          <div key={r.n} className="train-bar" role="listitem">
            <span className="small train-bar-name" title={r.n}>{r.n}{r.step && heater?.steps[r.step - 1] ? <span className="muted"> · {heater.steps[r.step - 1][0]} °C</span> : null}</span>
            <span className="train-bar-track"><span style={{ width: `${(r.v / max) * 100}%` }} /></span>
            <span className="small num">{pct(r.v, 1)}</span>
          </div>
        ))}
      </div>
      {names.length > rows.length && <p className="muted small">Showing the {rows.length} most important of {names.length} inputs.</p>}
    </div>
  );
}

export function Results({ outcome, colors, heater }: { outcome: TrainOutcome; colors: string[]; heater?: HeaterProfile }) {
  const { main, other, labels } = outcome;
  const brief = (e: Evaluation) => ({ split: e.split, accuracy: e.scores.accuracy, nTest: e.nTest, testSpecimens: e.testSpecimens, warning: e.warning });
  return (
    <div className="card">
      <h2>Results</h2>
      <p><b>{summarize(main.scores, labels, main.split)}</b></p>
      <ScorePair main={brief(main)} other={other ? brief(other) : null} />
      <div className="grid" style={{ marginTop: 14 }}>
        <div>
          <h3>Mistakes: {main.split === 'specimen' ? 'specimens it never saw' : 'random cycles'}</h3>
          <p className="muted small">Each row is what a test cycle really was; each column what the model said. The diagonal is right.</p>
          <Confusion confusion={main.scores.confusion} labels={labels} colors={colors} />
        </div>
        <div>
          <h3>Per label</h3>
          <PerLabel s={main.scores} labels={labels} colors={colors} />
        </div>
      </div>
      {other && (
        <details style={{ marginTop: 12 }}>
          <summary className="small">Mistakes in the other test: {other.split === 'specimen' ? 'specimens it never saw' : 'random cycles, the AI-Studio way'}</summary>
          <div style={{ marginTop: 8 }}><Confusion confusion={other.scores.confusion} labels={labels} colors={colors} /></div>
        </details>
      )}
      <h3 style={{ marginTop: 16 }}>Confidence</h3>
      <Threshold ev={main} />
      {outcome.importance && (
        <>
          <h3 style={{ marginTop: 16 }}>Which inputs matter</h3>
          <Importance names={outcome.featureNames} values={outcome.importance} heater={heater} />
        </>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Trained on {main.nTrain.toLocaleString()} cycles from {main.trainSpecimens} specimen{main.trainSpecimens === 1 ? '' : 's'} in {(outcome.ms / 1000).toFixed(1)} s (both tests).
      </p>
    </div>
  );
}
