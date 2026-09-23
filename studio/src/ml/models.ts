/**
 * Model kinds: anything that can learn from a Dataset and predict class
 * probabilities. Register new ones with registerModelKind(); the Train view
 * lists them and the Live view can run any saved model.
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
  /** probabilities per class, one row per sample, rows summing to 1 */
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

export function getModelKind(id: string): ModelKind {
  const k = kinds.find((x) => x.id === id);
  if (!k) {
    throw new Error(`Unknown model kind "${id}"`);
  }
  return k;
}
