/**
 * "Nearest neighbours": remembers every training cycle and answers with the
 * labels of the k most similar ones. A simple baseline -- if a fancier model
 * can't beat it, the fancier model isn't learning much.
 */
import { registerModelKind, type Predictor } from '../models.ts';
import { abortError, fitScaler, scaleRow, type Scaler } from './scale.ts';

export interface KnnState {
  version: 1;
  k: number;
  weighting: 'uniform' | 'distance';
  classes: number;
  inputs: number;
  scaler: Scaler;
  /** standardised training samples, row-major [n][inputs] */
  x: number[];
  y: number[];
}

function predictOne(s: KnnState, row: number[]): number[] {
  const q = scaleRow(s.scaler, row);
  const d = s.inputs;
  const n = s.y.length;
  const k = Math.min(s.k, n);
  // Keep the k best in a small sorted list: fast for k << n.
  const bestD: number[] = [];
  const bestY: number[] = [];
  for (let i = 0; i < n; i++) {
    let dist = 0;
    const o = i * d;
    for (let j = 0; j < d; j++) {
      const t = s.x[o + j] - q[j];
      dist += t * t;
      if (bestD.length === k && dist >= bestD[k - 1]) break;
    }
    if (bestD.length === k && dist >= bestD[k - 1]) continue;
    let p = bestD.length;
    while (p > 0 && bestD[p - 1] > dist) p--;
    bestD.splice(p, 0, dist);
    bestY.splice(p, 0, s.y[i]);
    if (bestD.length > k) { bestD.pop(); bestY.pop(); }
  }
  const votes = new Array<number>(s.classes).fill(0);
  bestD.forEach((dd, i) => { votes[bestY[i]] += s.weighting === 'distance' ? 1 / (Math.sqrt(dd) + 1e-6) : 1; });
  const sum = votes.reduce((a, b) => a + b, 0);
  return votes.map((v) => (sum > 0 ? v / sum : 1 / s.classes));
}

function predictorOf(s: KnnState): Predictor {
  return { predict: (x) => x.map((r) => predictOne(s, r)), save: () => s, importance: () => null };
}

registerModelKind({
  id: 'knn',
  name: 'Nearest neighbours',
  description:
    'Answers with the label of the most similar training cycles. Nothing to tune and nothing hidden -- a useful baseline to compare the other models with.',
  params: [
    { key: 'k', label: 'Neighbours (k)', type: 'number', default: 5, min: 1, max: 101, step: 1,
      help: 'How many of the most similar training cycles vote. Odd numbers avoid ties.' },
    { key: 'weighting', label: 'Vote weighting', type: 'select', default: 'uniform',
      options: [{ value: 'uniform', label: 'Every neighbour counts the same' }, { value: 'distance', label: 'Closer neighbours count more' }],
      help: 'Whether a very similar cycle should outweigh a less similar one.' },
  ],
  async train(x, y, nClasses, params, progress, signal) {
    if (signal.aborted) throw abortError();
    if (x.length === 0) throw new Error('There is nothing to train on.');
    const scaler = fitScaler(x);
    const flat: number[] = [];
    for (const r of x) for (const v of scaleRow(scaler, r)) flat.push(Math.round(v * 1e5) / 1e5);
    progress({ fraction: 1, message: `Remembered ${x.length} training cycles` });
    return predictorOf({
      version: 1,
      k: Math.max(1, Math.round(Number(params.k ?? 5))),
      weighting: params.weighting === 'distance' ? 'distance' : 'uniform',
      classes: nClasses,
      inputs: x[0].length,
      scaler,
      x: flat,
      y: y.slice(),
    });
  },
  async load(state) {
    const s = state as KnnState;
    if (!s || s.version !== 1 || !Array.isArray(s.x)) {
      throw new Error('This saved nearest-neighbour model is damaged or from a newer version of BME Studio.');
    }
    return predictorOf(s);
  },
});
