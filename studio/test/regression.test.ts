/**
 * Regression ("estimate a number"): data sets and the honest split, each
 * model kind on a synthetic linear target, saving, metrics, the C header
 * (compiled with gcc when present), live estimates, and AI-Studio's demo
 * "Caffeine [mg]" values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { emptyPoints } from '../src/core/assemble.ts';
import { openAiStudioProject } from '../src/core/aistudio-project.ts';
import type { Cycle, ModelRecord, Recording, Specimen } from '../src/core/types.ts';
import { baseName, cleanValues, propertyName, unitOf } from '../src/core/values.ts';
import { buildDataset, heaterProfilesIn, regressionSummary, splitBySpecimen, splitRandom } from '../src/ml/dataset.ts';
import { mlpToCHeader } from '../src/ml/export.ts';
import { estimatesBySpecimen, scoreRegression, summarizeRegression } from '../src/ml/metrics.ts';
import { getModelKind } from '../src/ml/models.ts';
import '../src/ml/models/index.ts';
import { loadRunner } from '../src/ml/run.ts';
import { combineEstimates } from '../src/plugins/live/assembler.ts';
import { meanBySpecimen, runRegressionOnRecording, toRecord, trainAndEvaluate, trainRegression, type RegSavedMetrics } from '../src/plugins/train/pipeline.ts';

const noop = () => {};
const sig = () => new AbortController().signal;
const TARGET = 'Caffeine [mg]';

/** Seeded uniform 0..1 */
function lcg(seed: number) {
  let a = seed;
  return () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/**
 * A recording whose specimens have caffeine 10, 20 ... and whose gas
 * resistances depend on it smoothly (plus noise), two sensors.
 */
function synthRecording(amounts: (number | null)[], cyclesPer = 30, seed = 5): Recording {
  const r = lcg(seed);
  const specimens: Specimen[] = amounts.map((v, i) => ({
    id: `sp${i}`, tag: i + 1, name: `cup ${i + 1}`, comment: '', start: i * 1e6, end: i * 1e6 + 9e5, classId: i % 2 ? 'b' : 'a',
    ...(v === null ? {} : { values: { [TARGET]: v } }),
  }));
  const cycles: Cycle[] = [];
  amounts.forEach((v, i) => {
    for (let k = 0; k < cyclesPer; k++) {
      for (const sensor of [0, 1]) {
        const amt = v ?? 50;
        const gas = Array.from({ length: 10 }, (_, s) => 1e5 * Math.exp(-amt / 80 * (0.5 + s / 10)) * (1 + 0.01 * (r() - 0.5)) * (sensor ? 1.1 : 1));
        cycles.push({ sensor, start: i * 1e6 + k * 2e4, end: i * 1e6 + k * 2e4 + 1e4, heaterProfile: 'hp', gas, temp: 25, hum: 40, press: 1000, specimen: i });
      }
    }
  });
  return {
    id: 'rec1', projectId: 'p', name: 'synthetic', sources: [], importedAt: 0, boardId: '', firmware: '',
    config: { boardType: 'board_690', boardMode: '', heaterProfiles: [{ id: 'hp', name: 'HP', timeBase: 140, steps: Array.from({ length: 10 }, () => [300, 1] as [number, number]) }], dutyCycleProfiles: [], sensors: [] },
    points: emptyPoints(0), cycles, droppedCycles: 0, specimens,
  };
}

const spec = (extra = {}) => ({ featureSet: 'log', environment: false, heaterProfile: 'hp', sensors: [], mode: 'per-sensor' as const, labelOf: {}, task: 'regress' as const, target: TARGET, ...extra });

test('property names carry their unit', () => {
  assert.equal(propertyName('Caffeine', 'mg'), 'Caffeine [mg]');
  assert.equal(propertyName(' Ripeness ', ''), 'Ripeness');
  assert.equal(unitOf('Caffeine [mg]'), 'mg');
  assert.equal(unitOf('Ripeness'), '');
  assert.equal(baseName('Caffeine [mg]'), 'Caffeine');
  assert.deepEqual(cleanValues({ a: '12.5', b: '', c: 'x', d: 3 }), { a: 12.5, d: 3 });
  assert.equal(cleanValues({ a: '' }), undefined);
});

test('regression data set: samples only from specimens with a value, y is the value', () => {
  const rec = synthRecording([10, null, 30, 40]);
  const ds = buildDataset([rec], spec());
  assert.equal(ds.task, 'regress');
  assert.deepEqual(ds.labels, [TARGET]);
  assert.equal(ds.samples.length, 3 * 30 * 2);
  assert.deepEqual([...new Set(ds.samples.map((s) => s.y))].sort((a, b) => a - b), [10, 30, 40]);
  // Fused: one sample per pair of sensors.
  assert.equal(buildDataset([rec], spec({ mode: 'fused' })).samples.length, 3 * 30);
  // Classification of the same recordings is unchanged by values.
  const cls = buildDataset([rec], { ...spec(), task: undefined, target: undefined, labelOf: { a: 'A', b: 'B' } });
  assert.equal(cls.task, undefined);
  assert.equal(cls.samples.length, 4 * 30 * 2);
});

test('honest regression split keeps specimens whole and at least one in training', () => {
  const ds = buildDataset([synthRecording([10, 20, 30, 40, 50, 60])], spec());
  const sp = splitBySpecimen(ds, 0.3, 1);
  const trainG = new Set(sp.train.map((s) => s.group));
  const testG = new Set(sp.test.map((s) => s.group));
  assert.ok([...testG].every((g) => !trainG.has(g)));
  assert.equal(testG.size, 2);
  assert.equal(sp.warning, null);
  assert.equal(regressionSummary(ds).distinct.length, 6);

  // Two specimens: one each side, and a warning about the two amounts.
  const two = buildDataset([synthRecording([126, null, 81.3434])], spec());
  const s2 = splitBySpecimen(two, 0.3, 1);
  assert.equal(new Set(s2.train.map((s) => s.group)).size, 1);
  assert.equal(new Set(s2.test.map((s) => s.group)).size, 1);
  assert.match(s2.warning ?? '', /can only learn 2 distinct amounts/);
  // Random split unchanged.
  const rnd = splitRandom(two.samples, 0.3, 1);
  assert.equal(rnd.test.length, Math.round(two.samples.length * 0.3));
});

// A linear target in 5 features, one of them pure noise.
function linear(n: number, seed: number) {
  const r = lcg(seed);
  const x: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = [r() * 10, r() * 5, r() * 100, r(), 1000 + r() * 50];
    x.push(row);
    y.push(3 * row[0] - 4 * row[1] + 0.2 * row[2] + 50 + (r() - 0.5));
  }
  return { x, y };
}

function r2(y: number[], p: number[]) {
  return scoreRegression(y, p).r2;
}

for (const [id, params] of [
  ['forest', { trees: 60, maxFeatures: 'all' }],
  ['knn', { k: 5, weighting: 'distance' }],
  ['mlp', { epochs: 120, learningRate: 0.01 }],
  ['mlp', { epochs: 120, learningRate: 0.01, loss: 'mae' }],
] as const) {
  test(`${id}${'loss' in params ? ' (' + params.loss + ')' : ''} learns a linear target (R² > 0.9 held out) and survives a save/load round trip`, async () => {
    const tr = linear(400, 11);
    const te = linear(120, 99);
    const kind = getModelKind(id);
    const pr = await kind.train(tr.x, tr.y, 0, { ...params }, noop, sig());
    const out = pr.predict(te.x);
    assert.ok(out.every((row) => row.length === 1 && Number.isFinite(row[0])));
    const score = r2(te.y, out.map((r) => r[0]));
    assert.ok(score > 0.9, `R² ${score}`);
    const again = await kind.load(JSON.parse(JSON.stringify(pr.save())));
    assert.deepEqual(again.predict(te.x.slice(0, 10)), out.slice(0, 10));
    if (id === 'forest') {
      const imp = pr.importance!()!;
      assert.ok(Math.abs(imp.reduce((a, b) => a + b, 0) - 1) < 1e-9);
      assert.ok(imp[3] < imp[0] && imp[4] < imp[0], `noise features should matter less: ${imp}`);
    }
  });
}

test('regression training can be cancelled', async () => {
  const { x, y } = linear(60, 3);
  const ac = new AbortController();
  ac.abort();
  for (const id of ['forest', 'mlp', 'knn']) {
    await assert.rejects(getModelKind(id).train(x, y, 0, {}, noop, ac.signal), /cancelled/);
  }
});

test('regression metrics and summary', () => {
  const s = scoreRegression([10, 20, 30, 40], [12, 18, 33, 40], 100);
  assert.equal(s.mae, 7 / 4);
  assert.ok(Math.abs(s.rmse - Math.sqrt(17 / 4)) < 1e-12);
  assert.ok(Math.abs(s.r2 - (1 - 17 / 500)) < 1e-12);
  assert.equal(s.maeOfRange, 7 / 400);
  assert.equal(s.bias, 3 / 4);
  // One distinct true value: R² is undefined, not a made-up number.
  assert.ok(Number.isNaN(scoreRegression([5, 5], [4, 6]).r2));
  const e = estimatesBySpecimen(['a', 'a', 'b'], [10, 10, 20], [11, 13, 19]);
  assert.deepEqual(e, [{ group: 'a', truth: 10, predicted: 12, cycles: 2 }, { group: 'b', truth: 20, predicted: 19, cycles: 1 }]);
  assert.equal(summarizeRegression(scoreRegression([0, 100], [14, 86], 100), 'mg', 'specimen'),
    'On specimens it never saw, its estimates were off by 14.0 mg on average (about 14 % of the range).');
  assert.match(summarizeRegression(scoreRegression([0, 100], [50, 50], 100), 'mg', 'random', 50), /no better than always guessing the average/);
});

test('pipeline: train, score both ways, save, load and run a regression model', async () => {
  const rec = synthRecording([10, 20, 30, 40, 50, 60, 70, null], 20);
  const o = await trainRegression([rec], { spec: spec(), kind: 'forest', params: { trees: 30 }, split: 'specimen', testFraction: 0.3 }, noop, sig());
  assert.equal(o.task, 'regress');
  assert.equal(o.unit, 'mg');
  assert.equal(o.main.split, 'specimen');
  assert.equal(o.other?.split, 'random');
  assert.ok(o.main.bySpecimen.length >= 2 && o.main.bySpecimen.every((b) => b.name.startsWith('cup')));
  assert.ok(o.other!.scores.mae < o.main.scores.mae + 1e-9 || o.other!.scores.mae < 5);
  const rec2 = toRecord(o, 'caffeine');
  assert.equal(rec2.dataset.task, 'regress');
  assert.deepEqual(rec2.labels, [TARGET]);
  const m = rec2.metrics as unknown as RegSavedMetrics;
  assert.equal(m.task, 'regress');
  assert.equal(typeof m.honestMae, 'number');
  assert.equal(typeof m.randomMae, 'number');
  const runner = await loadRunner(JSON.parse(JSON.stringify(rec2)));
  assert.equal(runner.task, 'regress');
  const pts = runRegressionOnRecording(runner, rec);
  assert.equal(pts.length, rec.cycles.length);
  const means = meanBySpecimen(pts, rec);
  assert.equal(means.length, 8);
  assert.equal(means[7].truth, null);
  for (const s of means.slice(0, 7)) assert.ok(Math.abs(s.mean - s.truth!) < 15, JSON.stringify(s));
});

test('models saved before regression existed still load as classifiers', async () => {
  const rec = synthRecording([10, 20, 30, 40]);
  const o = await trainAndEvaluate([rec], {
    spec: { featureSet: 'log', environment: false, heaterProfile: 'hp', sensors: [], mode: 'per-sensor', labelOf: { a: 'A', b: 'B' } },
    kind: 'knn', params: {}, split: 'specimen', testFraction: 0.3,
  }, noop, sig());
  const m = toRecord(o, 'old');
  // An old record has no task and a state without one.
  assert.equal(m.dataset.task, undefined);
  assert.equal((m.state as { task?: string }).task, undefined);
  const runner = await loadRunner(JSON.parse(JSON.stringify(m)));
  assert.equal(runner.task, 'classify');
  const p = runner.predict([rec.cycles[0]])!;
  assert.equal(p.length, 2);
  assert.ok(Math.abs(p[0] + p[1] - 1) < 1e-9);
});

test('C header for a regression network matches the JavaScript predictions', async () => {
  const tr = linear(200, 4);
  const pr = await getModelKind('mlp').train(tr.x, tr.y, 0, { epochs: 30, learningRate: 0.01 }, noop, sig());
  const m: ModelRecord = {
    id: 'm', name: 'Caffeine', created: 0, kind: 'mlp',
    dataset: { featureSet: 'custom', environment: false, heaterProfile: 'hp', sensors: [], mode: 'per-sensor', labelOf: {}, task: 'regress', target: TARGET },
    labels: [TARGET], featureNames: ['a', 'b', 'c', 'd', 'e'], params: {},
    metrics: { honestMae: 14.2, randomMae: 1.5 }, state: pr.save(),
  };
  const h = mlpToCHeader(m);
  assert.match(h, /Estimates: Caffeine \[mg\]/);
  assert.match(h, /Tested average error: 14\.2 mg on specimens it never saw, 1\.5 mg on random cycles/);
  assert.match(h, /#define BME_MODEL_N_OUTPUTS 1/);
  assert.match(h, /static inline float bme_model_predict\(const float x\[BME_MODEL_N_INPUTS\]\)/);
  assert.match(h, /bme_model_unit = "mg"/);
  assert.ok(!h.includes('N_CLASSES'));

  let gcc = true;
  try {
    execFileSync('gcc', ['--version'], { stdio: 'ignore' });
  } catch {
    gcc = false;
  }
  if (!gcc) return;
  const dir = mkdtempSync(join(tmpdir(), 'bme-reg-'));
  try {
    const rows = tr.x.slice(0, 20);
    writeFileSync(join(dir, 'model.h'), h);
    writeFileSync(join(dir, 'main.c'), `#include <stdio.h>
#include "model.h"
static const float X[${rows.length}][5] = { ${rows.map((r) => `{ ${r.map((v) => `${v}f`).join(', ')} }`).join(',\n')} };
int main(void) {
    for (int i = 0; i < ${rows.length}; i++) printf("%.6f\\n", (double)bme_model_predict(X[i]));
    (void)bme_model_target; (void)bme_model_unit;
    return 0;
}
`);
    execFileSync('gcc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-O2', '-o', join(dir, 'm'), join(dir, 'main.c'), '-lm'], { stdio: 'pipe' });
    const got = execFileSync(join(dir, 'm'), { encoding: 'utf8' }).trim().split('\n').map(Number);
    const want = pr.predict(rows).map((r) => r[0]);
    got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-3 * Math.max(1, Math.abs(want[i])), `row ${i}: C ${v} vs JS ${want[i]}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live: median estimate across sensors, spread as ±', () => {
  assert.deepEqual(combineEstimates([10, 14, 100], 5), { value: 14, spread: 45, voters: 3, at: 5 });
  assert.equal(combineEstimates([10, 20], 1)!.value, 15);
  assert.equal(combineEstimates([NaN], 1), null);
});

// ---------------------------------------------------------------- AI-Studio demo

const DEMO = process.env.AISTUDIO_DEMO ?? '/opt/bme-ai-studio/app/src/config/demo.bmeproject/project.db';
const EPOCHS = Number(process.env.BENCH_EPOCHS ?? 64);

test('AI-Studio demo: estimate "Caffeine [mg]" (two specimens, two amounts)', { skip: !existsSync(DEMO) && 'AI-Studio demo not installed', timeout: 600_000 }, async (t) => {
  const p = openAiStudioProject(await initSqlJs(), readFileSync(DEMO));
  const recs = p.recordings.map((r) => ({ ...r, projectId: 'demo' }));
  const hp = heaterProfilesIn(recs).find((h) => h.name === 'HP-354')!.id;
  const s = { featureSet: 'shape', environment: false, heaterProfile: hp, sensors: [], mode: 'per-sensor' as const, labelOf: {}, task: 'regress' as const, target: TARGET };
  const ds = buildDataset(recs, s);
  assert.deepEqual(regressionSummary(ds).distinct, [81.3434, 126]);
  for (const [kind, params] of [['forest', {}], ['knn', {}], ['mlp', { epochs: EPOCHS, loss: 'mae' }]] as const) {
    const o = await trainRegression(recs, { spec: s, kind, params: { ...params }, split: 'specimen', testFraction: 0.3 }, noop, sig());
    const f = (e: typeof o.main) => `${e.split}: MAE ${e.scores.mae.toFixed(2)} mg, RMSE ${e.scores.rmse.toFixed(2)} mg (${(e.scores.rmse / 126 * 100).toFixed(1)} % of max), ` +
      `${(e.scores.maeOfRange * 100).toFixed(0)} % of range, R² ${Number.isFinite(e.scores.r2) ? e.scores.r2.toFixed(3) : 'n/a'}, ${e.nTrain}/${e.nTest}`;
    t.diagnostic(`${kind}: ${f(o.main)} | ${f(o.other!)} | ${(o.ms / 1000).toFixed(1)} s`);
    assert.match(o.main.warning ?? '', /2 distinct amounts/);
    // Trained on one amount, tested on the other: the honest error is about the whole gap.
    assert.ok(o.main.scores.mae > 20, `honest MAE ${o.main.scores.mae}`);
    assert.ok(o.other!.scores.mae < o.main.scores.mae, 'random split flatters');
  }
});

test('saved-model scores are read defensively (imported models may carry partial metrics)', async () => {
  const { headlineOf, modelTask } = await import('../src/plugins/train/pipeline.ts');
  const base = { id: 'x', name: 'x', created: 0, kind: 'knn', labels: ['A', 'B'], featureNames: [], params: {}, state: null };
  const dataset = { featureSet: 'shape', environment: false, heaterProfile: 'hp', sensors: [], mode: 'per-sensor' as const, labelOf: {} };
  assert.deepEqual(headlineOf({ ...base, dataset, metrics: null as unknown as Record<string, unknown> }), { task: 'classify', honest: null, random: null, target: '', unit: '' });
  assert.equal(headlineOf({ ...base, dataset, metrics: { honestAccuracy: 0.9 } }).honest, 0.9);
  const reg = headlineOf({ ...base, labels: [TARGET], dataset: { ...dataset, task: 'regress', target: TARGET }, metrics: { honestMae: 14, randomMae: 'x' } });
  assert.deepEqual(reg, { task: 'regress', honest: 14, random: null, target: TARGET, unit: 'mg' });
  assert.equal(modelTask({ dataset: undefined as never }), 'classify');
  // A model exported by the Python lab: no task, class names as labelOf keys, no threshold curve.
  const LAB = new URL('../../python/notebooks/output/air_vs_coffee.bmemodel.json', import.meta.url).pathname;
  if (existsSync(LAB)) {
    const m = JSON.parse(readFileSync(LAB, 'utf8')) as ModelRecord;
    assert.equal(modelTask(m), 'classify');
    assert.ok(headlineOf(m).honest! > 0.5);
    const runner = await loadRunner(m);
    assert.equal(runner.task, 'classify');
  }
});
