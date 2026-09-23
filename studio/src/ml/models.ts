/**
 * Model kinds: anything that can learn from a Dataset and predict class
 * probabilities -- or, for regression, a number. Register new ones with
 * registerModelKind(); the Train view lists them and the Live view can run
 * any saved model.
 *
 * The two tasks share one contract:
 *
 *   classification  nClasses >= 2, y[i] is a class index 0..nClasses-1,
 *                   predict() returns one row of nClasses probabilities
 *                   (summing to 1) per input row.
 *   regression      nClasses === 0, y[i] is the measured value itself (any
 *                   real number, e.g. mg of caffeine), predict() returns
 *                   [value] per input row: a one-element row.
 *
 * A kind records the task in its saved state, so load() gives back a
 * predictor of the same task. States saved before regression existed have
 * no task field and are classifiers.
 */

export type ParamValue = number | string | boolean;

export interface ParamSpec {
  key: string;
  label: string;
  /** shown under the control */
  help?: string;
  type: 'number' | 'select' | 'boolean';
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** only offered for this task (e.g. the loss of a regression network); absent = both */
  task?: 'classify' | 'regress';
}

export interface TrainProgress {
  /** 0..1 */
  fraction: number;
  message: string;
  /** optional series for a live training chart */
  loss?: number;
  valLoss?: number;
}

/** A trained model ready to use. */
export interface Predictor {
  /** classification: probabilities per class, one row per sample, rows
   *  summing to 1. Regression: [estimated value] per sample. */
  predict(x: number[][]): number[][];
  /** plain data (JSON-safe, typed arrays allowed) that load() turns back into a Predictor */
  save(): unknown;
  /** optional: feature importances, same order as the features */
  importance?(): number[] | null;
}

export interface ModelKind {
  id: string;
  name: string;
  /** one or two sentences for the UI: what it is, when to use it */
  description: string;
  params: ParamSpec[];
  /**
   * Learn from rows x with targets y. nClasses >= 2: classification, y are
   * class indices. nClasses === 0: regression, y are the values to estimate.
   */
  train(
    x: number[][],
    y: number[],
    nClasses: number,
    params: Record<string, ParamValue>,
    progress: (p: TrainProgress) => void,
    signal: AbortSignal,
  ): Promise<Predictor>;
  load(state: unknown): Promise<Predictor>;
}

const kinds: ModelKind[] = [];

export function registerModelKind(k: ModelKind): void {
  if (!kinds.some((x) => x.id === k.id)) {
    kinds.push(k);
  }
}

export function getModelKinds(): readonly ModelKind[] {
  return kinds;
}

/** The params a kind offers for a task. */
export function paramsFor(k: ModelKind, task: 'classify' | 'regress'): ParamSpec[] {
  return k.params.filter((p) => !p.task || p.task === task);
}

export function getModelKind(id: string): ModelKind {
  const k = kinds.find((x) => x.id === id);
  if (!k) {
    throw new Error(`Unknown model kind "${id}"`);
  }
  return k;
}
