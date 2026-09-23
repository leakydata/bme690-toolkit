/**
 * What the Train page does, without the page: build the data set, split it
 * both ways, train, score, and package the result as a ModelRecord. Kept
 * free of React so the benchmark test can run exactly the same steps.
 *
 * trainAndEvaluate() classifies (the Quick experiment uses it as it is);
 * trainRegression() estimates a number; trainAny() picks by spec.task.
 */
import { newId } from '../../core/ids.ts';
import type { Cycle, DatasetSpec, ModelRecord, Recording, Task } from '../../core/types.ts';
import { unitOf } from '../../core/values.ts';
import { buildDataset, regressionCaveat, regressionSummary, splitBySpecimen, splitRandom, type Dataset, type Sample, type Split } from '../../ml/dataset.ts';
import {
  estimatesBySpecimen, score, scoreRegression, thresholdCurve,
  type RegScores, type Scores, type SpecimenEstimate, type ThresholdPoint,
} from '../../ml/metrics.ts';
import { getModelKind, type ParamValue, type Predictor, type TrainProgress } from '../../ml/models.ts';
import type { Runner } from '../../ml/run.ts';

export type SplitMode = 'specimen' | 'random';

export interface TrainRequest {
  spec: DatasetSpec;
  kind: string;
  params: Record<string, ParamValue>;
  split: SplitMode;
  /** 0..1 */
  testFraction: number;
  /** also score with the other split (the page always does) */
  compare?: boolean;
  seed?: number;
}

export interface Evaluation {
  split: SplitMode;
  scores: Scores;
  nTrain: number;
  nTest: number;
  /** specimens (recording:specimen groups) in each side */
  trainSpecimens: number;
  testSpecimens: number;
  warning: string | null;
  /** kept in memory for the confidence slider; not saved */
  yTest: number[];
  probs: number[][];
  curve: ThresholdPoint[];
}

export interface TrainOutcome {
  task: 'classify';
  request: TrainRequest;
  labels: string[];
  featureNames: string[];
  samples: number;
  /** the model trained on the chosen split's training part: the one that gets saved */
  predictor: Predictor;
  main: Evaluation;
  other: Evaluation | null;
  importance: number[] | null;
  ms: number;
}

export type Phase = 'main' | 'other';

export function splitOf(ds: Dataset, mode: SplitMode, testFraction: number, seed = 1): Split {
  if (mode === 'specimen') return splitBySpecimen(ds, testFraction, seed);
  const split = splitRandom(ds.samples, testFraction, seed);
  // A random split of a regression data set has the same lack of variety.
  return ds.task === 'regress' ? { ...split, warning: regressionCaveat(ds) } : split;
}

const groups = (s: Sample[]) => new Set(s.map((x) => x.group)).size;

/** Check a data set can be trained on; returns a plain-English problem or null. */
export function problemWith(ds: Dataset): string | null {
  if (ds.labels.length < 2) return 'Choose at least two different labels to tell apart.';
  if (ds.samples.length === 0) return 'No cycles match these choices. Check the heater profile and sensors.';
  const per = ds.labels.map((_, y) => ds.samples.filter((s) => s.y === y).length);
  const empty = ds.labels.filter((_, y) => per[y] < 2);
  if (empty.length) {
    return `${empty.join(', ')} ${empty.length > 1 ? 'have' : 'has'} fewer than two cycles with this heater profile and these sensors. Include more data or leave ${empty.length > 1 ? 'them' : 'it'} out.`;
  }
  return null;
}

async function evaluate(
  ds: Dataset, req: TrainRequest, mode: SplitMode,
  progress: (p: TrainProgress) => void, signal: AbortSignal,
): Promise<{ ev: Evaluation; predictor: Predictor }> {
  const split = splitOf(ds, mode, req.testFraction, req.seed ?? 1);
  if (split.train.length === 0 || split.test.length === 0) {
    throw new Error('There is not enough data to keep some back for testing. Record more, or change the test share.');
  }
  const kind = getModelKind(req.kind);
  const predictor = await kind.train(
    split.train.map((s) => s.x), split.train.map((s) => s.y), ds.labels.length, req.params, progress, signal,
  );
  const yTest = split.test.map((s) => s.y);
  const probs = predictor.predict(split.test.map((s) => s.x));
  return {
    predictor,
    ev: {
      split: mode,
      scores: score(yTest, probs, ds.labels.length),
      nTrain: split.train.length,
      nTest: split.test.length,
      trainSpecimens: groups(split.train),
      testSpecimens: groups(split.test),
      warning: split.warning,
      yTest,
      probs,
      curve: thresholdCurve(yTest, probs),
    },
  };
}

export async function trainAndEvaluate(
  recordings: Recording[], req: TrainRequest,
  progress: (phase: Phase, p: TrainProgress) => void, signal: AbortSignal,
): Promise<TrainOutcome> {
  const t0 = Date.now();
  const ds = buildDataset(recordings, req.spec);
  const problem = problemWith(ds);
  if (problem) throw new Error(problem);
  const main = await evaluate(ds, req, req.split, (p) => progress('main', p), signal);
  let other: Evaluation | null = null;
  if (req.compare !== false) {
    const mode: SplitMode = req.split === 'specimen' ? 'random' : 'specimen';
    other = (await evaluate(ds, req, mode, (p) => progress('other', p), signal)).ev;
  }
  return {
    task: 'classify',
    request: req,
    labels: ds.labels,
    featureNames: ds.featureNames,
    samples: ds.samples.length,
    predictor: main.predictor,
    main: main.ev,
    other,
    importance: main.predictor.importance?.() ?? null,
    ms: Date.now() - t0,
  };
}

function evalMetrics(e: Evaluation) {
  return {
    split: e.split,
    accuracy: e.scores.accuracy,
    confusion: e.scores.confusion,
    precision: e.scores.precision,
    recall: e.scores.recall,
    support: e.scores.support,
    nTrain: e.nTrain,
    nTest: e.nTest,
    trainSpecimens: e.trainSpecimens,
    testSpecimens: e.testSpecimens,
    warning: e.warning,
    thresholdCurve: e.curve,
  };
}

export type EvalMetrics = ReturnType<typeof evalMetrics>;

/** What a saved model's `metrics` holds. */
export interface SavedMetrics {
  split: SplitMode;
  testFraction: number;
  accuracy: number;
  /** by-specimen score (null if it could not be computed) */
  honestAccuracy: number | null;
  /** random-split score, what AI-Studio would report */
  randomAccuracy: number | null;
  confusion: number[][];
  main: EvalMetrics;
  other: EvalMetrics | null;
  importance: number[] | null;
  samples: number;
}

export function metricsOf(o: TrainOutcome): SavedMetrics {
  const both = [o.main, o.other].filter(Boolean) as Evaluation[];
  const acc = (m: SplitMode) => both.find((e) => e.split === m)?.scores.accuracy ?? null;
  return {
    split: o.main.split,
    testFraction: o.request.testFraction,
    accuracy: o.main.scores.accuracy,
    honestAccuracy: acc('specimen'),
    randomAccuracy: acc('random'),
    confusion: o.main.scores.confusion,
    main: evalMetrics(o.main),
    other: o.other ? evalMetrics(o.other) : null,
    importance: o.importance,
    samples: o.samples,
  };
}

export function toRecord(o: TrainOutcome | RegOutcome, name: string): ModelRecord {
  if (o.task === 'regress') return regressionRecord(o, name);
  return {
    id: newId('mdl'),
    name: name.trim() || 'Model',
    created: Date.now(),
    kind: o.request.kind,
    dataset: o.request.spec,
    labels: o.labels,
    featureNames: o.featureNames,
    params: { ...o.request.params, split: o.request.split, testFraction: o.request.testFraction },
    metrics: metricsOf(o) as unknown as Record<string, unknown>,
    // Through JSON, so what is stored is exactly what load() will see later.
    state: JSON.parse(JSON.stringify(o.predictor.save())),
  };
}

// ---------- running a saved model over a whole recording ----------

export interface RunPoint {
  t: number;
  sensor: number | null;
  specimen: number;
  /** index into labels */
  predicted: number;
  confidence: number;
  /** index into labels, or -1 when the cycle's class is not one the model knows */
  truth: number;
}

/**
 * Group cycles the way buildDataset does for fused models: anchor on the
 * lowest sensor and take each other sensor's nearest cycle in time.
 */
function fusedSets(cycles: Cycle[]): Cycle[][] {
  const bySensor = new Map<number, Cycle[]>();
  for (const c of cycles) (bySensor.get(c.sensor) ?? bySensor.set(c.sensor, []).get(c.sensor)!).push(c);
  const sensors = [...bySensor.keys()].sort((a, b) => a - b);
  if (!sensors.length) return [];
  const cursor = new Map(sensors.map((s) => [s, 0]));
  const out: Cycle[][] = [];
  for (const anchor of bySensor.get(sensors[0])!) {
    const window = (anchor.end - anchor.start) / 2 + 1;
    const set = [anchor];
    for (const s of sensors.slice(1)) {
      const list = bySensor.get(s)!;
      let i = cursor.get(s)!;
      while (i + 1 < list.length && Math.abs(list[i + 1].start - anchor.start) <= Math.abs(list[i].start - anchor.start)) i++;
      cursor.set(s, i);
      if (list[i] && Math.abs(list[i].start - anchor.start) <= window) set.push(list[i]);
    }
    if (set.length === sensors.length) out.push(set);
  }
  return out;
}

export function runOnRecording(runner: Runner, rec: Recording): RunPoint[] {
  const spec = runner.model.dataset;
  const idx = new Map(runner.labels.map((l, i) => [l, i]));
  const truthOf = (c: Cycle) => {
    const cls = rec.specimens[c.specimen]?.classId;
    const l = cls ? spec.labelOf?.[cls] : undefined;
    return l === undefined ? -1 : idx.get(l) ?? -1;
  };
  const usable = rec.cycles.filter((c) => c.heaterProfile === spec.heaterProfile && (!runner.sensors || runner.sensors.includes(c.sensor)));
  const sets = runner.mode === 'per-sensor' ? usable.map((c) => [c]) : fusedSets(usable);
  const out: RunPoint[] = [];
  for (const set of sets) {
    const p = runner.predict(set);
    if (!p) continue;
    let b = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
    const c = set[0];
    out.push({ t: c.start, sensor: runner.mode === 'per-sensor' ? c.sensor : null, specimen: c.specimen, predicted: b, confidence: p[b], truth: truthOf(c) });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface SpecimenVote {
  specimen: number;
  name: string;
  truth: number;
  cycles: number;
  /** label index with most votes */
  majority: number;
  /** share of cycles voting for the majority */
  share: number;
}

export function majorityBySpecimen(points: RunPoint[], rec: Recording, labels: string[]): SpecimenVote[] {
  const by = new Map<number, RunPoint[]>();
  for (const p of points) (by.get(p.specimen) ?? by.set(p.specimen, []).get(p.specimen)!).push(p);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([sp, pts]) => {
    const votes = new Array<number>(labels.length).fill(0);
    for (const p of pts) votes[p.predicted]++;
    let m = 0;
    for (let i = 1; i < votes.length; i++) if (votes[i] > votes[m]) m = i;
    return { specimen: sp, name: rec.specimens[sp]?.name ?? `specimen ${sp + 1}`, truth: pts[0].truth, cycles: pts.length, majority: m, share: votes[m] / pts.length };
  });
}

// ---------------------------------------------------------------- regression

export interface RegSpecimenRow extends SpecimenEstimate {
  name: string;
  recording: string;
}

export interface RegEvaluation {
  split: SplitMode;
  scores: RegScores;
  nTrain: number;
  nTest: number;
  trainSpecimens: number;
  testSpecimens: number;
  warning: string | null;
  /** error of always answering the training average: what "no skill" scores */
  baselineMae: number;
  /** kept in memory for the scatter plot; not saved */
  yTest: number[];
  yPred: number[];
  bySpecimen: RegSpecimenRow[];
}

export interface RegOutcome {
  task: 'regress';
  request: TrainRequest;
  /** the property estimated, e.g. "Caffeine [mg]" */
  target: string;
  unit: string;
  featureNames: string[];
  samples: number;
  /** specimens with a value, and the distinct values among them */
  specimens: number;
  distinct: number[];
  predictor: Predictor;
  main: RegEvaluation;
  other: RegEvaluation | null;
  importance: number[] | null;
  ms: number;
}

export type AnyOutcome = TrainOutcome | RegOutcome;

const fmt = (v: number) => String(+v.toPrecision(4));

/** Check a regression data set can be trained on; returns a plain-English problem or null. */
export function problemWithRegression(ds: Dataset): string | null {
  const target = ds.labels[0];
  if (!target) return 'Choose the measured value the model should estimate. Enter values on the Data page first.';
  if (ds.samples.length === 0) {
    return `No cycles with this heater profile and these sensors come from a specimen with a value for ${target}. Enter values on the Data page, or choose other data.`;
  }
  const { distinct } = regressionSummary(ds);
  if (distinct.length < 2) {
    return `Every specimen with a value has the same ${target} (${fmt(distinct[0])}${unitOf(target) ? ` ${unitOf(target)}` : ''}), so there is nothing to learn. Give specimens with at least two different amounts a value.`;
  }
  if (ds.samples.length < 4) return `Only ${ds.samples.length} cycles have a value for ${target}. Record more.`;
  return null;
}

function specimenNames(recordings: Recording[]): (group: string) => { name: string; recording: string } {
  const byId = new Map(recordings.map((r) => [r.id, r]));
  return (group) => {
    const i = group.lastIndexOf(':');
    const r = byId.get(group.slice(0, i));
    const sp = r?.specimens[Number(group.slice(i + 1))];
    return { name: sp?.name ?? group, recording: r?.name ?? '' };
  };
}

async function evaluateRegression(
  ds: Dataset, req: TrainRequest, mode: SplitMode, range: number, nameOf: ReturnType<typeof specimenNames>,
  progress: (p: TrainProgress) => void, signal: AbortSignal,
): Promise<{ ev: RegEvaluation; predictor: Predictor }> {
  const split = splitOf(ds, mode, req.testFraction, req.seed ?? 1);
  if (split.train.length === 0 || split.test.length === 0) {
    throw new Error('There is not enough data to keep some back for testing. Record more, or change the test share.');
  }
  const kind = getModelKind(req.kind);
  const predictor = await kind.train(split.train.map((s) => s.x), split.train.map((s) => s.y), 0, req.params, progress, signal);
  const yTest = split.test.map((s) => s.y);
  const yPred = predictor.predict(split.test.map((s) => s.x)).map((r) => r[0]);
  const trainMean = split.train.reduce((a, s) => a + s.y, 0) / split.train.length;
  const baselineMae = yTest.reduce((a, y) => a + Math.abs(y - trainMean), 0) / yTest.length;
  return {
    predictor,
    ev: {
      split: mode,
      scores: scoreRegression(yTest, yPred, range),
      nTrain: split.train.length,
      nTest: split.test.length,
      trainSpecimens: groups(split.train),
      testSpecimens: groups(split.test),
      warning: split.warning,
      baselineMae,
      yTest,
      yPred,
      bySpecimen: estimatesBySpecimen(split.test.map((s) => s.group), yTest, yPred).map((e) => ({ ...e, ...nameOf(e.group) })),
    },
  };
}

/** Train a model to estimate spec.target, scored both ways like trainAndEvaluate. */
export async function trainRegression(
  recordings: Recording[], req: TrainRequest,
  progress: (phase: Phase, p: TrainProgress) => void, signal: AbortSignal,
): Promise<RegOutcome> {
  const t0 = Date.now();
  const ds = buildDataset(recordings, { ...req.spec, task: 'regress' });
  const problem = problemWithRegression(ds);
  if (problem) throw new Error(problem);
  const sum = regressionSummary(ds);
  const range = sum.max - sum.min;
  const nameOf = specimenNames(recordings);
  const main = await evaluateRegression(ds, req, req.split, range, nameOf, (p) => progress('main', p), signal);
  let other: RegEvaluation | null = null;
  if (req.compare !== false) {
    const mode: SplitMode = req.split === 'specimen' ? 'random' : 'specimen';
    other = (await evaluateRegression(ds, req, mode, range, nameOf, (p) => progress('other', p), signal)).ev;
  }
  return {
    task: 'regress',
    request: req,
    target: ds.labels[0],
    unit: unitOf(ds.labels[0]),
    featureNames: ds.featureNames,
    samples: ds.samples.length,
    specimens: sum.specimens,
    distinct: sum.distinct,
    predictor: main.predictor,
    main: main.ev,
    other,
    importance: main.predictor.importance?.() ?? null,
    ms: Date.now() - t0,
  };
}

/** Classify or estimate, as the request's spec says. */
export function trainAny(
  recordings: Recording[], req: TrainRequest,
  progress: (phase: Phase, p: TrainProgress) => void, signal: AbortSignal,
): Promise<AnyOutcome> {
  return req.spec.task === 'regress' ? trainRegression(recordings, req, progress, signal) : trainAndEvaluate(recordings, req, progress, signal);
}

const r4 = (v: number) => (Number.isFinite(v) ? +v.toPrecision(6) : null);

function regEvalMetrics(e: RegEvaluation) {
  return {
    split: e.split,
    mae: r4(e.scores.mae),
    rmse: r4(e.scores.rmse),
    r2: r4(e.scores.r2),
    maeOfRange: r4(e.scores.maeOfRange),
    bias: r4(e.scores.bias),
    baselineMae: r4(e.baselineMae),
    nTrain: e.nTrain,
    nTest: e.nTest,
    trainSpecimens: e.trainSpecimens,
    testSpecimens: e.testSpecimens,
    warning: e.warning,
    bySpecimen: e.bySpecimen.map((b) => ({ name: b.name, recording: b.recording, truth: b.truth, predicted: r4(b.predicted), cycles: b.cycles })),
  };
}

export type RegEvalMetrics = ReturnType<typeof regEvalMetrics>;

/** What a saved regression model's `metrics` holds. */
export interface RegSavedMetrics {
  task: 'regress';
  split: SplitMode;
  testFraction: number;
  target: string;
  unit: string;
  /** chosen split's mean absolute error */
  mae: number | null;
  /** by-specimen scores (null if not computed) */
  honestMae: number | null;
  honestRmse: number | null;
  honestR2: number | null;
  /** random-split scores, what AI-Studio would report */
  randomMae: number | null;
  randomRmse: number | null;
  randomR2: number | null;
  /** max - min of the target in the data */
  range: number;
  distinct: number[];
  specimens: number;
  main: RegEvalMetrics;
  other: RegEvalMetrics | null;
  importance: number[] | null;
  samples: number;
}

export function regressionMetricsOf(o: RegOutcome): RegSavedMetrics {
  const both = [o.main, o.other].filter(Boolean) as RegEvaluation[];
  const at = (m: SplitMode, k: 'mae' | 'rmse' | 'r2') => {
    const e = both.find((x) => x.split === m);
    return e ? r4(e.scores[k]) : null;
  };
  return {
    task: 'regress',
    split: o.main.split,
    testFraction: o.request.testFraction,
    target: o.target,
    unit: o.unit,
    mae: r4(o.main.scores.mae),
    honestMae: at('specimen', 'mae'),
    honestRmse: at('specimen', 'rmse'),
    honestR2: at('specimen', 'r2'),
    randomMae: at('random', 'mae'),
    randomRmse: at('random', 'rmse'),
    randomR2: at('random', 'r2'),
    range: o.main.scores.range,
    distinct: o.distinct,
    specimens: o.specimens,
    main: regEvalMetrics(o.main),
    other: o.other ? regEvalMetrics(o.other) : null,
    importance: o.importance,
    samples: o.samples,
  };
}

function regressionRecord(o: RegOutcome, name: string): ModelRecord {
  return {
    id: newId('mdl'),
    name: name.trim() || 'Model',
    created: Date.now(),
    kind: o.request.kind,
    dataset: { ...o.request.spec, task: 'regress', target: o.target, labelOf: {} },
    labels: [o.target],
    featureNames: o.featureNames,
    params: { ...o.request.params, split: o.request.split, testFraction: o.request.testFraction },
    metrics: regressionMetricsOf(o) as unknown as Record<string, unknown>,
    state: JSON.parse(JSON.stringify(o.predictor.save())),
  };
}

export interface RegRunPoint {
  t: number;
  sensor: number | null;
  specimen: number;
  value: number;
  /** the specimen's measured value, or null when it has none */
  truth: number | null;
}

/** Estimate every usable cycle (or fused set) of a recording. */
export function runRegressionOnRecording(runner: Runner, rec: Recording): RegRunPoint[] {
  const spec = runner.model.dataset;
  const target = runner.labels[0];
  const usable = rec.cycles.filter((c) => c.heaterProfile === spec.heaterProfile && (!runner.sensors || runner.sensors.includes(c.sensor)));
  const sets = runner.mode === 'per-sensor' ? usable.map((c) => [c]) : fusedSets(usable);
  const out: RegRunPoint[] = [];
  for (const set of sets) {
    const p = runner.predict(set);
    if (!p || !Number.isFinite(p[0])) continue;
    const c = set[0];
    const v = rec.specimens[c.specimen]?.values?.[target];
    out.push({ t: c.start, sensor: runner.mode === 'per-sensor' ? c.sensor : null, specimen: c.specimen, value: p[0], truth: typeof v === 'number' ? v : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface SpecimenMean {
  specimen: number;
  name: string;
  truth: number | null;
  cycles: number;
  /** mean estimate over the specimen's cycles */
  mean: number;
}

export function meanBySpecimen(points: RegRunPoint[], rec: Recording): SpecimenMean[] {
  const by = new Map<number, RegRunPoint[]>();
  for (const p of points) (by.get(p.specimen) ?? by.set(p.specimen, []).get(p.specimen)!).push(p);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([sp, pts]) => ({
    specimen: sp,
    name: rec.specimens[sp]?.name ?? `specimen ${sp + 1}`,
    truth: pts[0].truth,
    cycles: pts.length,
    mean: pts.reduce((a, p) => a + p.value, 0) / pts.length,
  }));
}

// ---------------------------------------------------------------- reading saved models

/** A saved model's task. Records without one (older, or from the Python lab) classify. */
export function modelTask(m: Pick<ModelRecord, 'dataset'> | null | undefined): Task {
  return m?.dataset?.task === 'regress' ? 'regress' : 'classify';
}

export interface Headline {
  task: Task;
  /** classification: accuracy 0..1; regression: mean absolute error. null when unknown */
  honest: number | null;
  random: number | null;
  /** regression: the property and its unit */
  target: string;
  unit: string;
}

/**
 * The scores a saved model carries, read defensively: imported models (the
 * Python lab, other versions) may have partial or no metrics.
 */
export function headlineOf(m: ModelRecord): Headline {
  const met = (m.metrics && typeof m.metrics === 'object' ? m.metrics : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const task = modelTask(m);
  const target = task === 'regress' ? String(m.dataset?.target ?? m.labels?.[0] ?? '') : '';
  return task === 'regress'
    ? { task, honest: n(met.honestMae), random: n(met.randomMae), target, unit: unitOf(target) }
    : { task, honest: n(met.honestAccuracy), random: n(met.randomAccuracy), target, unit: '' };
}
