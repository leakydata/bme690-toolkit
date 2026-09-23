/**
 * Z-score standardisation shared by the model kinds: each feature is
 * shifted and scaled with the mean and spread of the TRAINING data, and the
 * same constants are saved with the model so new data is scaled identically.
 */

export interface Scaler {
  mean: number[];
  std: number[];
}

export function fitScaler(x: number[][]): Scaler {
  const d = x[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (const row of x) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= Math.max(x.length, 1);
  for (const row of x) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) {
    const s = Math.sqrt(std[j] / Math.max(x.length, 1));
    // A constant feature carries no information; scale 1 keeps it harmless.
    std[j] = s > 1e-12 ? s : 1;
  }
  return { mean, std };
}

export function scaleRow(s: Scaler, row: number[]): number[] {
  const out = new Array<number>(row.length);
  for (let j = 0; j < row.length; j++) out[j] = (row[j] - s.mean[j]) / s.std[j];
  return out;
}

/** Deterministic pseudo-random numbers (xorshift), so training can be repeated. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a ^= a << 13; a >>>= 0;
    a ^= a >>> 17;
    a ^= a << 5; a >>>= 0;
    return a / 4294967296;
  };
}

/**
 * Give the browser a moment to paint and handle clicks. A MessageChannel
 * message rather than setTimeout or requestAnimationFrame, because those are
 * throttled or paused in a background tab and training would stall there.
 */
export function yieldToUi(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      ch.port2.close();
      r();
    };
    ch.port2.postMessage(null);
  });
}

export function abortError(): Error {
  const e = new Error('Training was cancelled.');
  e.name = 'AbortError';
  return e;
}
