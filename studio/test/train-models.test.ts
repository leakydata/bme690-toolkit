import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/ml/models/index.ts';
import { getModelKind } from '../src/ml/models.ts';
import { atThreshold, score, summarize, thresholdCurve } from '../src/ml/metrics.ts';
import { mlpToCHeader } from '../src/ml/export.ts';
import type { ModelRecord } from '../src/core/types.ts';

// Three well-separated blobs in 4 dimensions.
function blobs(n: number, seed = 3) {
  let a = seed;
  const r = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
  const x: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % 3;
    x.push([c * 3 + r(), -c * 2 + r(), r() * 5, 100 + c * 50 + r() * 10]);
    y.push(c);
  }
  return { x, y };
}

const noop = () => {};

for (const [id, params] of [['forest', { trees: 20 }], ['knn', { k: 3 }], ['mlp', { epochs: 40, learningRate: 0.01 }]] as const) {
  test(`${id} learns separable data and survives a save/load round trip`, async () => {
    const { x, y } = blobs(150);
    const kind = getModelKind(id);
    const pr = await kind.train(x, y, 3, { ...params }, noop, new AbortController().signal);
    const probs = pr.predict(x);
    assert.ok(score(y, probs, 3).accuracy > 0.95);
    for (const p of probs) assert.ok(Math.abs(p.reduce((s, v) => s + v, 0) - 1) < 1e-6);
    const again = await kind.load(JSON.parse(JSON.stringify(pr.save())));
    assert.deepEqual(again.predict(x.slice(0, 10)), probs.slice(0, 10));
  });
}

test('forest reports importances that sum to one and favour informative features', async () => {
  const { x, y } = blobs(150);
  const pr = await getModelKind('forest').train(x, y, 3, { trees: 30 }, noop, new AbortController().signal);
  const imp = pr.importance!()!;
  assert.ok(Math.abs(imp.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(imp[2] < imp[0] && imp[2] < imp[3], `noise feature should matter least: ${imp}`);
});

test('training can be cancelled', async () => {
  const { x, y } = blobs(90);
  const ac = new AbortController();
  ac.abort();
  for (const id of ['forest', 'mlp', 'knn']) {
    await assert.rejects(getModelKind(id).train(x, y, 3, {}, noop, ac.signal), /cancelled/);
  }
});

test('metrics', () => {
  const y = [0, 0, 1, 1];
  const p = [[0.9, 0.1], [0.4, 0.6], [0.2, 0.8], [0.45, 0.55]];
  const s = score(y, p, 2);
  assert.deepEqual(s.confusion, [[1, 1], [0, 2]]);
  assert.equal(s.accuracy, 0.75);
  assert.deepEqual(s.recall, [0.5, 1]);
  assert.equal(s.precision[1], 2 / 3);
  const t = atThreshold(y, p, 0.7);
  assert.equal(t.coverage, 0.5);
  assert.equal(t.accuracy, 1);
  assert.equal(thresholdCurve(y, p).length, 21);
  assert.match(summarize(s, ['Air', 'Coffee'], 'specimen'), /never saw, it was right 75%.*mistook Air for Coffee/);
});

test('C header has the input order and the network', async () => {
  const { x, y } = blobs(60);
  const pr = await getModelKind('mlp').train(x, y, 3, { epochs: 2 }, noop, new AbortController().signal);
  const m: ModelRecord = {
    id: 'm', name: 'Test */ model', created: 0, kind: 'mlp',
    dataset: { featureSet: 'shape', environment: false, heaterProfile: 'hp', sensors: [], mode: 'per-sensor', labelOf: {} },
    labels: ['A', 'B "quoted"', 'C'], featureNames: ['f1', 'f2', 'f3', 'f4'], params: {}, metrics: {}, state: pr.save(),
  };
  const h = mlpToCHeader(m);
  assert.match(h, /x\[0\] f1/);
  assert.match(h, /#define BME_MODEL_N_INPUTS 4/);
  assert.match(h, /static inline int bme_model_predict/);
  assert.match(h, /"B \\"quoted\\""/);
  assert.ok(!h.includes('Test */'));
});
