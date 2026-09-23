/**
 * Min/max downsampling for time series, so a twelve-hour, eight-sensor
 * recording (half a million points) plots as a couple of thousand points per
 * line without losing spikes: each pixel-wide bucket keeps its lowest and
 * highest value, in the order they happened.
 */

export interface Series {
  /** seconds, ascending */
  t: Float64Array;
  v: Float32Array;
}

/** First index with t[i] >= x. */
export function lowerBound(t: Float64Array, x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Buckets [x0, x1] into `buckets` equal slices and returns uPlot-style aligned
 * data: one shared x array (two slots per bucket) and one y array per series,
 * null where a series has no point in that slice.
 */
export function bucketMinMax(series: Series[], x0: number, x1: number, buckets: number): [number[], ...(number | null)[][]] {
  const nb = Math.max(1, Math.floor(buckets));
  const w = (x1 - x0) / nb || 1;
  const xs = new Array<number>(nb * 2);
  for (let b = 0; b < nb; b++) {
    xs[2 * b] = x0 + b * w;
    xs[2 * b + 1] = x0 + (b + 0.5) * w;
  }
  const ys = series.map((s) => {
    const out = new Array<number | null>(nb * 2).fill(null);
    let i = lowerBound(s.t, x0);
    let cur = -1;
    let mn = 0, mx = 0, mnAt = 0, mxAt = 0;
    const flush = () => {
      if (cur < 0) return;
      if (mnAt <= mxAt) {
        out[2 * cur] = mn;
        out[2 * cur + 1] = mx;
      } else {
        out[2 * cur] = mx;
        out[2 * cur + 1] = mn;
      }
    };
    for (; i < s.t.length && s.t[i] <= x1; i++) {
      const v = s.v[i];
      if (!isFinite(v)) continue;
      const b = Math.min(nb - 1, Math.floor((s.t[i] - x0) / w));
      if (b !== cur) {
        flush();
        cur = b;
        mn = mx = v;
        mnAt = mxAt = i;
      } else if (v < mn) {
        mn = v;
        mnAt = i;
      } else if (v > mx) {
        mx = v;
        mxAt = i;
      }
    }
    flush();
    return out;
  });
  return [xs, ...ys];
}
