/**
 * "Random forest": many decision trees, each grown on a random resample of
 * the training cycles and choosing among a random few features at every
 * split; the forest's answer is the average of the trees' answers.
 *
 * For regression the trees split to reduce the variance of the values
 * (each leaf answers with its mean) and the forest averages the leaves.
 *
 * Plain TypeScript CART (Gini impurity, or variance for regression), no dependency. Trees are stored as
 * flat arrays so a saved forest is small, JSON-safe and quick to evaluate
 * one cycle at a time.
 */
import { registerModelKind, type ParamValue, type Predictor } from '../models.ts';
import { abortError, seeded, yieldToUi } from './scale.ts';

export interface TreeState {
  /** feature index per node, -1 for a leaf */
  feature: number[];
  /** go left when x[feature] <= threshold */
  threshold: number[];
  left: number[];
  right: number[];
  /** class probabilities of leaf nodes, [node * classes + class] (zeros for
   *  inner nodes); for regression one number per node, the leaf's mean value */
  value: number[];
}

export interface ForestState {
  version: 1;
  /** 'regress': trees hold mean values and predict() returns [value]; absent = classify */
  task?: 'regress';
  inputs: number;
  /** 0 for regression */
  classes: number;
  trees: TreeState[];
  /** mean decrease in impurity, one per feature, summing to 1 */
  importance: number[];
}

interface GrowOptions {
  maxDepth: number;
  minLeaf: number;
  mtry: number;
}

/** Grow one tree on rows `rows` (may repeat, from bootstrap). */
function growTree(X: Float64Array, d: number, y: Int32Array, C: number, rows: number[], o: GrowOptions, rand: () => number, imp: Float64Array): TreeState {
  const t: TreeState = { feature: [], threshold: [], left: [], right: [], value: [] };
  const total = rows.length;
  const gini = (counts: number[], n: number) => {
    let s = 1;
    for (const c of counts) s -= (c / n) ** 2;
    return s;
  };
  const addNode = () => {
    t.feature.push(-1); t.threshold.push(0); t.left.push(-1); t.right.push(-1);
    for (let c = 0; c < C; c++) t.value.push(0);
    return t.feature.length - 1;
  };
  const feats = Array.from({ length: d }, (_, i) => i);

  // Iterative, so deep trees don't hit the call-stack limit.
  const stack: { node: number; rows: number[]; depth: number }[] = [{ node: addNode(), rows, depth: 0 }];
  while (stack.length) {
    const { node, rows: r, depth } = stack.pop()!;
    const n = r.length;
    const counts = new Array<number>(C).fill(0);
    for (const i of r) counts[y[i]]++;
    const parentGini = gini(counts, n);
    const leaf = () => { for (let c = 0; c < C; c++) t.value[node * C + c] = Math.round((counts[c] / n) * 1e4) / 1e4; };
    if (parentGini <= 1e-12 || n < 2 * o.minLeaf || (o.maxDepth > 0 && depth >= o.maxDepth)) {
      leaf();
      continue;
    }

    // Partial Fisher-Yates: the first mtry entries become a random subset.
    for (let k = 0; k < o.mtry; k++) {
      const j = k + Math.floor(rand() * (d - k));
      [feats[k], feats[j]] = [feats[j], feats[k]];
    }
    let bestGain = 0;
    let bestF = -1;
    let bestThr = 0;
    const sorted = r.slice();
    const leftCounts = new Array<number>(C);
    for (let k = 0; k < o.mtry; k++) {
      const f = feats[k];
      sorted.sort((a, b) => X[a * d + f] - X[b * d + f]);
      leftCounts.fill(0);
      for (let s = 0; s < n - 1; s++) {
        leftCounts[y[sorted[s]]]++;
        const nl = s + 1;
        const nr = n - nl;
        if (nl < o.minLeaf) continue;
        if (nr < o.minLeaf) break;
        const v = X[sorted[s] * d + f];
        const vNext = X[sorted[s + 1] * d + f];
        if (v === vNext) continue;
        let gl = 1;
        let gr = 1;
        for (let c = 0; c < C; c++) {
          gl -= (leftCounts[c] / nl) ** 2;
          gr -= ((counts[c] - leftCounts[c]) / nr) ** 2;
        }
        const gain = parentGini - (nl * gl + nr * gr) / n;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestF = f;
          bestThr = (v + vNext) / 2;
        }
      }
    }
    if (bestF < 0) {
      leaf();
      continue;
    }
    imp[bestF] += (n / total) * bestGain;
    const lr: number[] = [];
    const rr: number[] = [];
    for (const i of r) (X[i * d + bestF] <= bestThr ? lr : rr).push(i);
    t.feature[node] = bestF;
    t.threshold[node] = bestThr;
    const l = addNode();
    const rn = addNode();
    t.left[node] = l;
    t.right[node] = rn;
    stack.push({ node: l, rows: lr, depth: depth + 1 }, { node: rn, rows: rr, depth: depth + 1 });
  }
  return t;
}

/**
 * Grow one regression tree: each split is the one that most reduces the sum
 * of squared differences from the mean (variance reduction); leaves hold
 * the mean of their values.
 */
function growRegressionTree(X: Float64Array, d: number, y: Float64Array, rows: number[], o: GrowOptions, rand: () => number, imp: Float64Array): TreeState {
  const t: TreeState = { feature: [], threshold: [], left: [], right: [], value: [] };
  const total = rows.length;
  const addNode = () => {
    t.feature.push(-1); t.threshold.push(0); t.left.push(-1); t.right.push(-1); t.value.push(0);
    return t.feature.length - 1;
  };
  const feats = Array.from({ length: d }, (_, i) => i);
  const stack: { node: number; rows: number[]; depth: number }[] = [{ node: addNode(), rows, depth: 0 }];
  while (stack.length) {
    const { node, rows: r, depth } = stack.pop()!;
    const n = r.length;
    let sum = 0;
    let sq = 0;
    for (const i of r) { sum += y[i]; sq += y[i] * y[i]; }
    const mean = n ? sum / n : 0;
    // Sum of squared errors around the mean, per sample.
    const parentVar = n ? Math.max(0, sq / n - mean * mean) : 0;
    t.value[node] = mean;
    const scale = Math.max(1e-12, Math.abs(mean) ** 2);
    if (parentVar <= 1e-12 * scale || n < 2 * o.minLeaf || (o.maxDepth > 0 && depth >= o.maxDepth)) continue;

    for (let k = 0; k < o.mtry; k++) {
      const j = k + Math.floor(rand() * (d - k));
      [feats[k], feats[j]] = [feats[j], feats[k]];
    }
    let bestGain = 0;
    let bestF = -1;
    let bestThr = 0;
    const sorted = r.slice();
    for (let k = 0; k < o.mtry; k++) {
      const f = feats[k];
      sorted.sort((a, b) => X[a * d + f] - X[b * d + f]);
      let ls = 0;
      let lq = 0;
      for (let s = 0; s < n - 1; s++) {
        const yi = y[sorted[s]];
        ls += yi; lq += yi * yi;
        const nl = s + 1;
        const nr = n - nl;
        if (nl < o.minLeaf) continue;
        if (nr < o.minLeaf) break;
        const v = X[sorted[s] * d + f];
        const vNext = X[sorted[s + 1] * d + f];
        if (v === vNext) continue;
        const rs = sum - ls;
        const rq = sq - lq;
        const sse = (lq - (ls * ls) / nl) + (rq - (rs * rs) / nr);
        const gain = parentVar - sse / n;
        if (gain > bestGain + 1e-12 * scale) {
          bestGain = gain;
          bestF = f;
          bestThr = (v + vNext) / 2;
        }
      }
    }
    if (bestF < 0) continue;
    imp[bestF] += (n / total) * bestGain;
    const lr: number[] = [];
    const rr: number[] = [];
    for (const i of r) (X[i * d + bestF] <= bestThr ? lr : rr).push(i);
    t.feature[node] = bestF;
    t.threshold[node] = bestThr;
    t.value[node] = 0;
    const l = addNode();
    const rn = addNode();
    t.left[node] = l;
    t.right[node] = rn;
    stack.push({ node: l, rows: lr, depth: depth + 1 }, { node: rn, rows: rr, depth: depth + 1 });
  }
  return t;
}

function predictOne(s: ForestState, x: number[]): number[] {
  if (s.task === 'regress') {
    let sum = 0;
    for (const t of s.trees) {
      let k = 0;
      while (t.feature[k] >= 0) k = x[t.feature[k]] <= t.threshold[k] ? t.left[k] : t.right[k];
      sum += t.value[k];
    }
    return [s.trees.length ? sum / s.trees.length : NaN];
  }
  const C = s.classes;
  const out = new Array<number>(C).fill(0);
  for (const t of s.trees) {
    let k = 0;
    while (t.feature[k] >= 0) k = x[t.feature[k]] <= t.threshold[k] ? t.left[k] : t.right[k];
    for (let c = 0; c < C; c++) out[c] += t.value[k * C + c];
  }
  let sum = 0;
  for (const v of out) sum += v;
  return sum > 0 ? out.map((v) => v / sum) : out.map(() => 1 / C);
}

function predictorOf(s: ForestState): Predictor {
  return {
    predict: (x) => x.map((row) => predictOne(s, row)),
    save: () => s,
    importance: () => s.importance.slice(),
  };
}

registerModelKind({
  id: 'forest',
  name: 'Random forest',
  description:
    'Many simple yes/no decision trees that vote. Needs no tuning, trains in seconds, and on small data sets like a few ' +
    'specimens it often beats the neural network. It also shows which heater steps matter most. Can also estimate amounts.',
  params: [
    { key: 'trees', label: 'Trees', type: 'number', default: 100, min: 1, max: 1000, step: 1,
      help: 'How many trees vote. More is steadier but slower; beyond 100 it rarely helps.' },
    { key: 'maxDepth', label: 'Maximum depth', type: 'number', default: 16, min: 1, max: 64, step: 1,
      help: 'How many questions one tree may ask in a row. Lower keeps trees simpler.' },
    { key: 'minLeaf', label: 'Minimum cycles per leaf', type: 'number', default: 1, min: 1, max: 200, step: 1,
      help: 'A tree stops splitting when a group would get fewer cycles than this. Raise it if the model overfits.' },
    { key: 'maxFeatures', label: 'Features tried per split', type: 'select', default: 'sqrt',
      options: [{ value: 'sqrt', label: 'Square root of the number of features (usual)' }, { value: 'third', label: 'A third of the features' }, { value: 'all', label: 'All features' }],
      help: 'Trying only a few features at each split makes the trees differ, which makes the vote stronger.' },
  ],

  async train(x, y, nClasses, params, progress, signal) {
    const p = (k: string, dflt: ParamValue) => (params[k] ?? dflt);
    const nTrees = Math.max(1, Math.round(Number(p('trees', 100))));
    const maxDepth = Math.max(0, Math.round(Number(p('maxDepth', 16))));
    const minLeaf = Math.max(1, Math.round(Number(p('minLeaf', 1))));
    const mf = String(p('maxFeatures', 'sqrt'));
    const n = x.length;
    if (n === 0) throw new Error('There is nothing to train on.');
    const d = x[0].length;
    const mtry = Math.max(1, Math.min(d, mf === 'all' ? d : mf === 'third' ? Math.round(d / 3) : Math.round(Math.sqrt(d))));

    const X = new Float64Array(n * d);
    x.forEach((row, i) => row.forEach((v, j) => { X[i * d + j] = v; }));
    const regress = nClasses === 0;
    const Y = Int32Array.from(regress ? [] : y);
    const YR = Float64Array.from(regress ? y : []);
    const rand = seeded(12345);
    const trees: TreeState[] = [];
    const importance = new Array<number>(d).fill(0);
    let last = performance.now();

    for (let k = 0; k < nTrees; k++) {
      if (signal.aborted) throw abortError();
      const rows = Array.from({ length: n }, () => Math.floor(rand() * n));
      const imp = new Float64Array(d);
      const o = { maxDepth, minLeaf, mtry };
      trees.push(regress ? growRegressionTree(X, d, YR, rows, o, rand, imp) : growTree(X, d, Y, nClasses, rows, o, rand, imp));
      const s = imp.reduce((a, b) => a + b, 0);
      if (s > 0) for (let j = 0; j < d; j++) importance[j] += imp[j] / s;
      progress({ fraction: (k + 1) / nTrees, message: `Tree ${k + 1} of ${nTrees}` });
      if (performance.now() - last > 25) {
        await yieldToUi();
        last = performance.now();
      }
    }
    const s = importance.reduce((a, b) => a + b, 0);
    return predictorOf({
      version: 1, ...(regress ? { task: 'regress' as const } : {}),
      inputs: d, classes: nClasses, trees, importance: importance.map((v) => (s > 0 ? v / s : 0)),
    });
  },

  async load(state) {
    const s = state as ForestState;
    if (!s || s.version !== 1 || !Array.isArray(s.trees)) {
      throw new Error('This saved random forest is damaged or from a newer version of BME Studio.');
    }
    return predictorOf(s);
  },
});
