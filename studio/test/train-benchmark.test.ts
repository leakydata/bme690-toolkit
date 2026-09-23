/**
 * The Train page's pipeline on BME AI-Studio's demo project "Coffee or Not":
 * Espresso + Filter Coffee -> "Coffee", Neutral Air -> "Air", heater profile
 * HP-354, one sensor per sample. AI-Studio reports 99.77% for its 10-10 net
 * on a random 70/30 split.
 *
 * TensorFlow.js runs on its pure-JavaScript backend here (no tfjs-node), which
 * is slow, so the network trains for 64 passes instead of AI-Studio's 256.
 * Skips when the demo project is not installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { openAiStudioProject } from '../src/core/aistudio-project.ts';
import { heaterProfilesIn } from '../src/ml/dataset.ts';
import '../src/ml/models/index.ts';
import { loadRunner } from '../src/ml/run.ts';
import { majorityBySpecimen, runOnRecording, toRecord, trainAndEvaluate, type SplitMode } from '../src/plugins/train/pipeline.ts';

const DEMO = process.env.AISTUDIO_DEMO ?? '/opt/bme-ai-studio/app/src/config/demo.bmeproject/project.db';
const EPOCHS = Number(process.env.BENCH_EPOCHS ?? 64);

test('Coffee or Not benchmark', { skip: !existsSync(DEMO) && 'AI-Studio demo not installed', timeout: 600_000 }, async (t) => {
  const p = openAiStudioProject(await initSqlJs(), readFileSync(DEMO));
  const recs = p.recordings.map((r) => ({ ...r, projectId: 'demo' }));
  const cls = (n: string) => p.classes.find((c) => c.name === n)!.id;
  const labelOf = { [cls('Espresso')]: 'Coffee', [cls('Filter Coffee')]: 'Coffee', [cls('Air')]: 'Air' };
  const hp = heaterProfilesIn(recs).find((h) => h.name === 'HP-354')!.id;

  const run = async (featureSet: string, kind: string, split: SplitMode, params: Record<string, number> = {}) => {
    const o = await trainAndEvaluate(recs, {
      spec: { featureSet, environment: false, heaterProfile: hp, sensors: [], mode: 'per-sensor', labelOf },
      kind, params, split, testFraction: 0.3,
    }, () => {}, new AbortController().signal);
    const f = (e: typeof o.main) => `${e.split} ${(e.scores.accuracy * 100).toFixed(2)}% (${e.nTrain}/${e.nTest}) ${JSON.stringify(e.scores.confusion)}`;
    t.diagnostic(`${featureSet} ${kind}: ${f(o.main)} | ${f(o.other!)} | ${(o.ms / 1000).toFixed(1)} s`);
    return o;
  };

  // AI-Studio's setup: raw resistances, 10-10 net, random split.
  const ai = await run('aistudio', 'mlp', 'random', { epochs: EPOCHS });
  assert.deepEqual(ai.labels, ['Air', 'Coffee']);
  assert.ok(Math.abs(ai.main.nTest - 436) < 10, `test size ${ai.main.nTest}, AI-Studio had 436`);
  assert.ok(ai.main.scores.accuracy > 0.97, 'close to AI-Studio\'s 99.77%');
  assert.ok(ai.other!.scores.accuracy > 0.85, 'by-specimen score');

  const forest = await run('shape', 'forest', 'specimen');
  assert.ok(forest.main.scores.accuracy > 0.95);
  assert.ok(forest.importance && forest.importance.length === 11);

  // A saved model runs the same way the Live page will run it.
  const rec = toRecord(forest, 'bench');
  const runner = await loadRunner(JSON.parse(JSON.stringify(rec)));
  const points = runOnRecording(runner, recs[0]);
  assert.equal(points.length, recs[0].cycles.filter((c) => c.heaterProfile === hp).length);
  const votes = majorityBySpecimen(points, recs[0], rec.labels);
  assert.ok(votes.filter((v) => v.truth >= 0).every((v) => v.truth === v.majority), JSON.stringify(votes));
});
