/**
 * What a regression run found: how far off the estimates were on specimens
 * the model never saw, next to the flattering random-split number; the
 * estimates plotted against the truth; and per specimen, what it guessed.
 */
import { useMemo } from 'react';
import type uPlot from 'uplot';
import type { HeaterProfile } from '../../core/types.ts';
import { fmtValue } from '../../core/values.ts';
import { summarizeRegression } from '../../ml/metrics.ts';
import { axis, cssVar, Plot } from './chart.tsx';
import type { RegEvaluation, RegOutcome } from './pipeline.ts';
import { Importance, SPLIT_NAME } from './results.tsx';

const r2Text = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '–');

/** Headline: both errors side by side, and why they differ. */
export function RegScorePair({ main, other, unit }: { main: RegEvaluation; other: RegEvaluation | null; unit: string }) {
  const honest = main.split === 'specimen' ? main : other;
  const random = main.split === 'random' ? main : other;
  const ratio = honest && random && random.scores.mae > 0 ? honest.scores.mae / random.scores.mae : null;
  return (
    <div className="stack">
      <div className="train-scores">
        {honest && (
          <div className="train-score">
            <div className="small muted">Honest error: {SPLIT_NAME.specimen.toLowerCase()}</div>
            <div className="train-big num">±{fmtValue(honest.scores.mae, unit)}</div>
            <div className="small muted">
              average miss · RMSE {fmtValue(honest.scores.rmse, unit)} · R² {r2Text(honest.scores.r2)}<br />
              {honest.nTest.toLocaleString()} test cycles from {honest.testSpecimens} specimen{honest.testSpecimens === 1 ? '' : 's'} left out of training
            </div>
          </div>
        )}
        {random && (
          <div className="train-score">
            <div className="small muted">What AI-Studio would report: random cycles</div>
            <div className="train-big num muted">±{fmtValue(random.scores.mae, unit)}</div>
            <div className="small muted">
              average miss · RMSE {fmtValue(random.scores.rmse, unit)} · R² {r2Text(random.scores.r2)}<br />
              {random.nTest.toLocaleString()} test cycles picked at random; their neighbours were in training
            </div>
          </div>
        )}
      </div>
      {ratio !== null && (
        <p className="small">
          {ratio > 1.25
            ? <>The random test's error is <b>{ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} times smaller</b>. That is flattery, not skill: neighbouring cycles of one specimen are nearly identical, and in a random test the model has already seen the very specimen, and its amount, it is asked about. Expect the honest error on a new sample.</>
            : ratio < 0.8
              ? <>The honest error is smaller this time, which happens by chance with few specimens. Treat both numbers as rough.</>
              : <>Both tests agree closely: a good sign the model learned how the smell changes with the amount rather than recognising individual specimens.</>}
        </p>
      )}
      <p className="muted small">
        R² is the share of the differences between specimens the model explains: 1 is perfect, 0 is no better than always guessing the average.
        It shows “–” when every test cycle has the same true value.
      </p>
      {honest?.warning && <div className="notice warn small">{honest.warning}</div>}
    </div>
  );
}

const MAX_POINTS = 2500;

/** Predicted vs actual, with the line where they would be equal. */
export function Scatter({ main, other, unit, target }: { main: RegEvaluation; other: RegEvaluation | null; unit: string; target: string }) {
  const honest = main.split === 'specimen' ? main : other;
  const random = main.split === 'random' ? main : other;
  const { data, lo, hi } = useMemo(() => {
    const pts: { x: number; h: number | null; r: number | null }[] = [];
    const add = (e: RegEvaluation | null, key: 'h' | 'r') => {
      if (!e) return;
      const step = Math.max(1, Math.ceil(e.yTest.length / MAX_POINTS));
      for (let i = 0; i < e.yTest.length; i += step) pts.push({ x: e.yTest[i], h: key === 'h' ? e.yPred[i] : null, r: key === 'r' ? e.yPred[i] : null });
    };
    add(honest, 'h');
    add(random, 'r');
    pts.sort((a, b) => a.x - b.x);
    const all = pts.flatMap((p) => [p.x, p.h ?? p.x, p.r ?? p.x]).filter(Number.isFinite);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    lo -= pad;
    hi += pad;
    return {
      lo, hi,
      data: [pts.map((p) => p.x), pts.map((p) => p.x), pts.map((p) => p.r), pts.map((p) => p.h)] as uPlot.AlignedData,
    };
  }, [honest, random]);
  const u = unit ? ` ${unit}` : '';
  return (
    <Plot
      label={`Estimated against measured ${target}, one dot per test cycle; dots on the diagonal line are exactly right`}
      optionsKey={`scatter-${lo}-${hi}-${data[0].length}`}
      height={300}
      data={data}
      options={() => ({
        legend: { show: true },
        cursor: { drag: { x: false, y: false } },
        scales: { x: { time: false, range: [lo, hi] }, y: { range: [lo, hi] } },
        axes: [axis({ label: `measured${u}`, size: 40 }), axis({ label: `estimated${u}`, size: 56 })],
        series: [
          { label: 'measured', value: (_u, v) => (v == null ? '–' : fmtValue(v, unit)) },
          { label: 'exactly right', stroke: cssVar('--muted'), width: 1, dash: [5, 4], points: { show: false }, value: () => '' },
          {
            label: 'random-test estimate', stroke: cssVar('--muted'), fill: cssVar('--muted'), width: 0, paths: () => null,
            points: { show: true, size: 4, stroke: cssVar('--muted'), fill: cssVar('--muted') },
            value: (_u, v) => (v == null ? '' : fmtValue(v, unit)),
          },
          {
            label: 'honest-test estimate', stroke: cssVar('--accent'), fill: cssVar('--accent'), width: 0, paths: () => null,
            points: { show: true, size: 5, stroke: cssVar('--accent'), fill: cssVar('--accent') },
            value: (_u, v) => (v == null ? '' : fmtValue(v, unit)),
          },
        ],
      })}
    />
  );
}

export function SpecimenEstimates({ ev, unit }: { ev: RegEvaluation; unit: string }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>Specimen</th><th className="num">Measured</th><th className="num">Average estimate</th><th className="num">Off by</th><th className="num">Test cycles</th></tr>
        </thead>
        <tbody>
          {ev.bySpecimen.map((b) => (
            <tr key={b.group}>
              <td>{b.name}{b.recording && <div className="muted small">{b.recording}</div>}</td>
              <td className="num">{fmtValue(b.truth, unit)}</td>
              <td className="num">{fmtValue(b.predicted, unit)}</td>
              <td className="num">{b.predicted >= b.truth ? '+' : '−'}{fmtValue(Math.abs(b.predicted - b.truth), unit)}</td>
              <td className="num">{b.cycles}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RegResults({ outcome, heater }: { outcome: RegOutcome; heater?: HeaterProfile }) {
  const { main, other, unit, target } = outcome;
  const honest = main.split === 'specimen' ? main : other;
  const random = main.split === 'random' ? main : other;
  const values = outcome.distinct.length <= 6
    ? outcome.distinct.map((v) => fmtValue(v, unit)).join(', ')
    : `from ${fmtValue(outcome.distinct[0], unit)} to ${fmtValue(outcome.distinct[outcome.distinct.length - 1], unit)} (${outcome.distinct.length} different amounts)`;
  return (
    <div className="card">
      <h2>Results</h2>
      <p><b>{summarizeRegression(main.scores, unit, main.split, main.baselineMae)}</b></p>
      <RegScorePair main={main} other={other} unit={unit} />
      <h3 style={{ marginTop: 16 }}>Estimated against measured</h3>
      <p className="muted small">
        One dot per test cycle. On the dashed line the estimate is exactly right; above it the model guessed too high, below it too low.
        {outcome.distinct.length < 3 && <> With only {outcome.distinct.length} different amounts the dots stand in {outcome.distinct.length} columns: there is nothing in between to test on.</>}
      </p>
      <Scatter main={main} other={other} unit={unit} target={target} />
      <div className="grid" style={{ marginTop: 14 }}>
        {honest && (
          <div>
            <h3>Per specimen: {SPLIT_NAME.specimen.toLowerCase()}</h3>
            <SpecimenEstimates ev={honest} unit={unit} />
          </div>
        )}
        {random && (
          <div>
            <h3>Per specimen: random cycles</h3>
            <SpecimenEstimates ev={random} unit={unit} />
          </div>
        )}
      </div>
      {outcome.importance && (
        <>
          <h3 style={{ marginTop: 16 }}>Which inputs matter</h3>
          <Importance names={outcome.featureNames} values={outcome.importance} heater={heater} />
        </>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Trained on {main.nTrain.toLocaleString()} cycles from {main.trainSpecimens} specimen{main.trainSpecimens === 1 ? '' : 's'} with
        values {values} in {(outcome.ms / 1000).toFixed(1)} s (both tests).
      </p>
    </div>
  );
}
