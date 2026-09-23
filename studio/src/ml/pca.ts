/**
 * Principal component analysis, small and dependency-free: standardise each
 * feature, build the covariance matrix, and pull out the strongest directions
 * by power iteration with deflation. Enough for a 2-D map of a few thousand
 * cycles with up to a hundred or so features.
 */

export interface Standardised {
  /** rows, each feature scaled to mean 0 and standard deviation 1 */
  z: Float64Array[];
  mean: Float64Array;
  /** 1 for features that never change, so they become 0 rather than NaN */
  std: Float64Array;
}

export function standardise(x: ArrayLike<number>[]): Standardised {
  const n = x.length;
  const d = n ? x[0].length : 0;
  const mean = new Float64Array(d);
  const std = new Float64Array(d);
  for (const row of x) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= Math.max(n, 1);
  for (const row of x) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) {
    const s = Math.sqrt(std[j] / Math.max(n - 1, 1));
    std[j] = s > 1e-12 && isFinite(s) ? s : 1;
  }
  const z = x.map((row) => {
    const out = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      const v = (row[j] - mean[j]) / std[j];
      out[j] = isFinite(v) ? v : 0;
    }
    return out;
  });
  return { z, mean, std };
}

export interface PcaResult {
  /** one [pc1, pc2, ...] per input row */
  points: number[][];
  /** unit vectors, one per component, in feature space */
  components: number[][];
  eigenvalues: number[];
  /** share of the total variance each component explains, 0..1 */
  explained: number[];
}

/** Covariance of already-centred rows (d x d, row-major). */
function covariance(z: Float64Array[], d: number): Float64Array {
  const c = new Float64Array(d * d);
  for (const row of z) {
    for (let i = 0; i < d; i++) {
      const ri = row[i];
      if (ri === 0) continue;
      const off = i * d;
      for (let j = i; j < d; j++) c[off + j] += ri * row[j];
    }
  }
  const div = Math.max(z.length - 1, 1);
  for (let i = 0; i < d; i++) {
    for (let j = i; j < d; j++) {
      const v = c[i * d + j] / div;
      c[i * d + j] = v;
      c[j * d + i] = v;
    }
  }
  return c;
}

function matVec(c: Float64Array, v: Float64Array, d: number, out: Float64Array): void {
  for (let i = 0; i < d; i++) {
    let s = 0;
    const off = i * d;
    for (let j = 0; j < d; j++) s += c[off + j] * v[j];
    out[i] = s;
  }
}

/**
 * Top `k` principal components of `x` (rows = samples). Features are
 * standardised first, so a feature measured in ohms does not drown out one
 * measured in degrees.
 */
export function pca(x: ArrayLike<number>[], k = 2, opts: { standardise?: boolean } = {}): PcaResult {
  const n = x.length;
  const d = n ? x[0].length : 0;
  const z = opts.standardise === false
    ? (() => {
      const m = new Float64Array(d);
      for (const r of x) for (let j = 0; j < d; j++) m[j] += r[j] / n;
      return x.map((r) => Float64Array.from({ length: d }, (_, j) => r[j] - m[j]));
    })()
    : standardise(x).z;
  const c = covariance(z, d);
  let trace = 0;
  for (let i = 0; i < d; i++) trace += c[i * d + i];

  const comps: Float64Array[] = [];
  const eig: number[] = [];
  const tmp = new Float64Array(d);
  for (let m = 0; m < Math.min(k, d); m++) {
    // Deterministic start that is unlikely to be orthogonal to the answer.
    const v = new Float64Array(d);
    for (let j = 0; j < d; j++) v[j] = 1 + ((j * 7919 + m * 104729) % 97) / 97;
    let norm = Math.hypot(...v);
    for (let j = 0; j < d; j++) v[j] /= norm;
    let lambda = 0;
    for (let it = 0; it < 500; it++) {
      matVec(c, v, d, tmp);
      norm = Math.sqrt(tmp.reduce((a, b) => a + b * b, 0));
      if (norm < 1e-15) {
        lambda = 0;
        break;
      }
      let diff = 0;
      for (let j = 0; j < d; j++) {
        const nv = tmp[j] / norm;
        diff += Math.abs(Math.abs(nv) - Math.abs(v[j]));
        v[j] = nv;
      }
      lambda = norm;
      if (diff < 1e-10) break;
    }
    // Stable sign: the largest loading is positive.
    let big = 0;
    for (let j = 1; j < d; j++) if (Math.abs(v[j]) > Math.abs(v[big])) big = j;
    if (v[big] < 0) for (let j = 0; j < d; j++) v[j] = -v[j];
    comps.push(v);
    eig.push(lambda);
    // Deflate: remove this direction so the next iteration finds the next one.
    for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) c[i * d + j] -= lambda * v[i] * v[j];
  }

  const points = z.map((row) => comps.map((v) => {
    let s = 0;
    for (let j = 0; j < d; j++) s += row[j] * v[j];
    return s;
  }));
  return {
    points,
    components: comps.map((v) => [...v]),
    eigenvalues: eig,
    explained: eig.map((l) => (trace > 0 ? l / trace : 0)),
  };
}
