/**
 * What the Train page does, without the page: build the data set, split it
 * both ways, train, score, and package the result as a ModelRecord. Kept
 * free of React so the benchmark test can run exactly the same steps.
 */
import { newId } from '../../core/ids.ts';
import type { Cycle, DatasetSpec, ModelRecord, Recording } from '../../core/types.ts';
import { buildDataset, splitBySpecimen, splitRandom, type Dataset, type Sample, type Split } from '../../ml/dataset.ts';
import { score, thresholdCurve, type Scores, type ThresholdPoint } from '../../ml/metrics.ts';
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
  return mode === 'specimen' ? splitBySpecimen(ds, testFraction, seed) : splitRandom(ds.samples, testFraction, seed);
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

export function toRecord(o: TrainOutcome, name: string): ModelRecord {
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
    const l = cls ? spec.labelOf[cls] : undefined;
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
