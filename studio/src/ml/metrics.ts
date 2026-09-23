/**
 * Scoring a model on test data, and saying what the score means in plain
 * words. Rows of a confusion matrix are the true label, columns the answer.
 */

export interface Scores {
  /** share of test samples answered correctly, 0..1 */
  accuracy: number;
  /** [true][predicted] counts */
  confusion: number[][];
  /** per label: of the samples the model called this label, the share that were (NaN if never called) */
  precision: number[];
  /** per label: of the samples that were this label, the share it got right (NaN if none in test) */
  recall: number[];
  /** test samples per label */
  support: number[];
  n: number;
}

export function argmax(p: number[]): number {
  let b = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i;
  return b;
}

export function score(yTrue: number[], probs: number[][], nClasses: number): Scores {
  const confusion = Array.from({ length: nClasses }, () => new Array<number>(nClasses).fill(0));
  let right = 0;
  yTrue.forEach((y, i) => {
    const p = argmax(probs[i]);
    confusion[y][p]++;
    if (p === y) right++;
  });
  const support = confusion.map((r) => r.reduce((a, b) => a + b, 0));
  const called = confusion[0]?.map((_, j) => confusion.reduce((a, r) => a + r[j], 0)) ?? [];
  return {
    accuracy: yTrue.length ? right / yTrue.length : NaN,
    confusion,
    precision: called.map((c, j) => (c ? confusion[j][j] / c : NaN)),
    recall: support.map((s, j) => (s ? confusion[j][j] / s : NaN)),
    support,
    n: yTrue.length,
  };
}

export interface ThresholdPoint {
  /** minimum confidence to give an answer */
  threshold: number;
  /** share of samples the model still answers */
  coverage: number;
  /** accuracy on the answered samples (NaN if none) */
  accuracy: number;
}

/** Coverage and accuracy when answers below a confidence are replaced by "not sure". */
export function atThreshold(yTrue: number[], probs: number[][], threshold: number): ThresholdPoint {
  let answered = 0;
  let right = 0;
  yTrue.forEach((y, i) => {
    const p = probs[i];
    const b = argmax(p);
    if (p[b] >= threshold) {
      answered++;
      if (b === y) right++;
    }
  });
  return { threshold, coverage: yTrue.length ? answered / yTrue.length : NaN, accuracy: answered ? right / answered : NaN };
}

/** The curve at thresholds 0, 0.05 ... 1 -- small enough to store with a model. */
export function thresholdCurve(yTrue: number[], probs: number[][]): ThresholdPoint[] {
  const out: ThresholdPoint[] = [];
  for (let t = 0; t <= 100; t += 5) out.push(atThreshold(yTrue, probs, t / 100));
  return out.map((p) => ({ threshold: p.threshold, coverage: round4(p.coverage), accuracy: round4(p.accuracy) }));
}

function round4(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v;
}

export const pct = (v: number, digits = 0): string => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '–');

/** The most frequent mistake, or null if there were none. */
export function worstMistake(s: Scores, labels: string[]): { truth: string; answer: string; count: number } | null {
  let best: { truth: string; answer: string; count: number } | null = null;
  s.confusion.forEach((row, i) => row.forEach((c, j) => {
    if (i !== j && c > 0 && (!best || c > best.count)) best = { truth: labels[i], answer: labels[j], count: c };
  }));
  return best;
}

/**
 * One or two plain sentences, e.g. "On specimens it never saw, it was right
 * 91% of the time. It most often mistook Espresso for Filter Coffee."
 */
export function summarize(s: Scores, labels: string[], split: 'specimen' | 'random'): string {
  if (!s.n) return 'There was no test data, so the model could not be scored.';
  const where = split === 'specimen' ? 'On specimens it never saw' : 'On cycles held back at random';
  let text = `${where}, it was right ${pct(s.accuracy)} of the time (${countRight(s)} of ${s.n} cycles).`;
  const m = worstMistake(s, labels);
  if (m) {
    text += ` It most often mistook ${m.truth} for ${m.answer} (${m.count} ${m.count === 1 ? 'time' : 'times'}).`;
  } else {
    text += ' It made no mistakes.';
  }
  const chance = 1 / Math.max(labels.length, 1);
  if (s.accuracy < chance + 0.1) {
    text += ` That is little better than guessing (${pct(chance)} with ${labels.length} labels).`;
  }
  return text;
}

function countRight(s: Scores): number {
  return s.confusion.reduce((a, r, i) => a + r[i], 0);
}
