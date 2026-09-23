/**
 * Builds training data from a project's recordings, and splits it for
 * testing.
 *
 * Splitting matters more than any model choice. Neighbouring cycles of one
 * specimen are nearly identical, so a random split puts near-copies of the
 * test data into training and reports accuracy the model will never reach on
 * a new sample -- which is how BME AI-Studio splits. splitBySpecimen() keeps
 * every specimen wholly in training or wholly in testing, so the score is
 * what to expect on something the model has not seen.
 *
 * The same holds for regression (task 'regress': estimate a number such as
 * caffeine in mg): a sample's y is then the specimen's measured value, and
 * the honest split holds out whole specimens -- whole amounts.
 */
import type { Cycle, DatasetSpec, Recording, Task } from '../core/types.ts';
import { getFeatureSet } from './features.ts';

/** See DatasetSpec in core/types.ts for what each option means. */
export type DatasetOptions = DatasetSpec;

export interface Sample {
  x: number[];
  /** classification: index into Dataset.labels; regression: the measured value */
  y: number;
  recordingId: string;
  specimen: number;
  /** "recordingId:specimen" -- the unit an honest split keeps together */
  group: string;
  /** null for fused samples */
  sensor: number | null;
  t: number;
}

export interface Dataset {
  samples: Sample[];
  /** classification: the output labels; regression: [target] (or [] when none is chosen) */
  labels: string[];
  featureNames: string[];
  /** absent = classify */
  task?: Task;
}

export const isRegression = (x: { task?: Task } | null | undefined): boolean => x?.task === 'regress';

export function heaterProfilesIn(recs: Recording[]): { id: string; name: string; cycles: number }[] {
  const m = new Map<string, { id: string; name: string; cycles: number }>();
  for (const r of recs) {
    for (const c of r.cycles) {
      const hp = r.config.heaterProfiles.find((h) => h.id === c.heaterProfile);
      const e = m.get(c.heaterProfile) ?? { id: c.heaterProfile, name: hp?.name ?? c.heaterProfile, cycles: 0 };
      e.cycles++;
      m.set(c.heaterProfile, e);
    }
  }
  return [...m.values()].sort((a, b) => b.cycles - a.cycles);
}

export function buildDataset(recs: Recording[], o: DatasetOptions): Dataset {
  const fs = getFeatureSet(o.featureSet);
  const regress = o.task === 'regress';
  const target = o.target ?? '';
  const labels = regress ? (target ? [target] : []) : [...new Set(Object.values(o.labelOf))].sort();
  const labelIndex = new Map(labels.map((l, i) => [l, i]));
  const want = (s: number) => o.sensors.length === 0 || o.sensors.includes(s);
  const samples: Sample[] = [];
  const fusedSensors = new Set<number>();

  for (const r of recs) {
    // NaN (regression) or -1 (classification) marks a cycle to leave out.
    const yOf = regress
      ? (c: Cycle) => {
        const v = target ? r.specimens[c.specimen]?.values?.[target] : undefined;
        return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
      }
      : (c: Cycle) => {
        const cls = r.specimens[c.specimen]?.classId;
        const label = cls ? o.labelOf[cls] : undefined;
        return label === undefined ? -1 : labelIndex.get(label)!;
      };
    const keep = (y: number) => (regress ? Number.isFinite(y) : y >= 0);
    const cycles = r.cycles.filter((c) => c.heaterProfile === o.heaterProfile && want(c.sensor));

    if (o.mode === 'per-sensor') {
      for (const c of cycles) {
        const y = yOf(c);
        if (keep(y)) {
          samples.push({ x: fs.extract(c, o), y, recordingId: r.id, specimen: c.specimen, group: `${r.id}:${c.specimen}`, sensor: c.sensor, t: c.start });
        }
      }
      continue;
    }

    // fused: anchor on the lowest sensor, pick each other sensor's cycle
    // that started closest in time, and keep the set only when all are
    // present, close together and in the same specimen.
    const bySensor = new Map<number, Cycle[]>();
    for (const c of cycles) {
      (bySensor.get(c.sensor) ?? bySensor.set(c.sensor, []).get(c.sensor)!).push(c);
    }
    const sensors = [...bySensor.keys()].sort((a, b) => a - b);
    if (sensors.length === 0) continue;
    const cursor = new Map(sensors.map((s) => [s, 0]));
    for (const anchor of bySensor.get(sensors[0])!) {
      const window = (anchor.end - anchor.start) / 2 + 1;
      const set: Cycle[] = [anchor];
      for (const s of sensors.slice(1)) {
        const list = bySensor.get(s)!;
        let i = cursor.get(s)!;
        while (i + 1 < list.length && Math.abs(list[i + 1].start - anchor.start) <= Math.abs(list[i].start - anchor.start)) i++;
        cursor.set(s, i);
        if (list[i] && Math.abs(list[i].start - anchor.start) <= window && list[i].specimen === anchor.specimen) {
          set.push(list[i]);
        }
      }
      const y = yOf(anchor);
      if (set.length === sensors.length && keep(y)) {
        samples.push({ x: set.flatMap((c) => fs.extract(c, o)), y, recordingId: r.id, specimen: anchor.specimen, group: `${r.id}:${anchor.specimen}`, sensor: null, t: anchor.start });
      }
    }
    sensors.forEach((s) => fusedSensors.add(s));
  }
  const featureNames = o.mode === 'fused'
    ? [...fusedSensors].sort((a, b) => a - b).flatMap((s) => fs.names(o).map((n) => `sensor ${s} ${n}`))
    : fs.names(o);
  return { samples, labels, featureNames, ...(regress ? { task: 'regress' as const } : {}) };
}

/** Seeded random numbers, so a split can be reproduced. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13; a >>>= 0;
    a ^= a >>> 17;
    a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}

/** Fisher-Yates with a seeded generator: the same order in every browser
 *  (sort() with a random comparator is not, and is biased). */
export function shuffled<T>(items: readonly T[], r: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface Split {
  train: Sample[];
  test: Sample[];
  /** why the split is weaker than asked, if it is */
  warning: string | null;
}

/** Random split of individual cycles: optimistic, kept for comparison with AI-Studio. */
export function splitRandom(samples: Sample[], testFraction: number, seed = 1): Split {
  const r = rng(seed);
  const idx = shuffled(samples.map((_, i) => i), r);
  const nTest = Math.round(samples.length * testFraction);
  const test = new Set(idx.slice(0, nTest));
  return {
    train: samples.filter((_, i) => !test.has(i)),
    test: samples.filter((_, i) => test.has(i)),
    warning: null,
  };
}

/**
 * Whole specimens go to test, per label, until about testFraction of that
 * label's samples are held out. A label with a single specimen cannot be
 * tested honestly; its cycles are split in time instead (first part train,
 * last part test) and a warning explains it.
 */
export function splitBySpecimen(ds: Dataset, testFraction: number, seed = 1): Split {
  if (isRegression(ds)) return splitRegressionBySpecimen(ds, testFraction, seed);
  const r = rng(seed);
  const testGroups = new Set<string>();
  const timeSplit: number[] = [];
  const thin: string[] = [];

  ds.labels.forEach((label, y) => {
    const groups = new Map<string, number>();
    for (const s of ds.samples) if (s.y === y) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
    const order = shuffled([...groups.keys()].sort(), r);
    if (order.length < 2) {
      timeSplit.push(y);
      thin.push(label);
      return;
    }
    const total = [...groups.values()].reduce((a, b) => a + b, 0);
    let held = 0;
    let heldGroups = 0;
    for (const g of order) {
      // Stop at the target, and always leave at least one specimen to train on.
      if (held >= total * testFraction || order.length - heldGroups <= 1) break;
      testGroups.add(g);
      held += groups.get(g)!;
      heldGroups++;
    }
  });

  const train: Sample[] = [];
  const test: Sample[] = [];
  for (const y of timeSplit) {
    const own = ds.samples.filter((s) => s.y === y).sort((a, b) => a.t - b.t);
    const cut = Math.round(own.length * (1 - testFraction));
    train.push(...own.slice(0, cut));
    test.push(...own.slice(cut));
  }
  for (const s of ds.samples) {
    if (timeSplit.includes(s.y)) continue;
    (testGroups.has(s.group) ? test : train).push(s);
  }
  return {
    train,
    test,
    warning: thin.length
      ? `${thin.join(', ')} ${thin.length > 1 ? 'have' : 'has'} only one specimen, so its test data comes from the end of that same specimen. Record more specimens of it on other occasions for an honest score.`
      : null,
  };
}

// ---------------------------------------------------------------- regression

/** What the regression data holds: specimens with a value, and the distinct values. */
export function regressionSummary(ds: Dataset): { specimens: number; distinct: number[]; min: number; max: number } {
  const byGroup = new Map<string, number>();
  for (const s of ds.samples) byGroup.set(s.group, s.y);
  const distinct = [...new Set(byGroup.values())].sort((a, b) => a - b);
  return { specimens: byGroup.size, distinct, min: distinct[0] ?? NaN, max: distinct[distinct.length - 1] ?? NaN };
}

/** Plain-English caveat when there is too little variety to learn a number from, else null. */
export function regressionCaveat(ds: Dataset): string | null {
  const { specimens, distinct } = regressionSummary(ds);
  const notes: string[] = [];
  if (specimens < 3) {
    notes.push(`Only ${specimens} specimen${specimens === 1 ? ' has' : 's have'} a value, so the honest test holds out ${specimens < 2 ? 'nothing' : 'one of them'} and trains on ${specimens < 2 ? 'the same specimen' : 'the other'}.`);
  }
  if (distinct.length < 3) {
    notes.push(`The model can only learn ${distinct.length} distinct amount${distinct.length === 1 ? '' : 's'}${distinct.length ? ` (${distinct.map((v) => +v.toPrecision(6)).join(' and ')})` : ''}, so it cannot learn what lies between or beyond ${distinct.length === 1 ? 'it' : 'them'}; any score is a rough guide at best.`);
  }
  if (notes.length === 0) return null;
  return `${notes.join(' ')} Measure more specimens with different amounts for a trustworthy estimate.`;
}

/**
 * Honest split for regression: whole specimens go to test, in a seeded
 * random order, until about testFraction of the samples are held out,
 * always keeping at least one specimen to train on. With a single specimen
 * its cycles are split in time instead. The warning says when there is too
 * little variety for the score to mean much.
 */
function splitRegressionBySpecimen(ds: Dataset, testFraction: number, seed: number): Split {
  const r = rng(seed);
  const groups = new Map<string, number>();
  for (const s of ds.samples) groups.set(s.group, (groups.get(s.group) ?? 0) + 1);
  const order = shuffled([...groups.keys()].sort(), r);
  const caveat = regressionCaveat(ds);
  if (order.length < 2) {
    const own = [...ds.samples].sort((a, b) => a.t - b.t);
    const cut = Math.round(own.length * (1 - testFraction));
    return {
      train: own.slice(0, cut),
      test: own.slice(cut),
      warning: `Only one specimen has a value, so its test data comes from the end of that same specimen. ${caveat ?? ''}`.trim(),
    };
  }
  const testGroups = new Set<string>();
  let held = 0;
  for (const g of order) {
    if (held >= ds.samples.length * testFraction || order.length - testGroups.size <= 1) break;
    testGroups.add(g);
    held += groups.get(g)!;
  }
  const train: Sample[] = [];
  const test: Sample[] = [];
  for (const s of ds.samples) (testGroups.has(s.group) ? test : train).push(s);
  return { train, test, warning: caveat };
}
