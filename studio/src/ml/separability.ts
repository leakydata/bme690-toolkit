/**
 * How well can the classes be told apart, before training anything?
 *
 * A k-nearest-neighbour check on standardised features: each cycle is
 * classified by its nearest cycles *from other specimens*. Neighbours from the
 * same specimen are nearly copies of it and would make every class look
 * separable, so they are ignored ("leave one specimen out"). A class with a
 * single specimen has nothing to be compared against that way, so its
 * specimen is cut in two halves in time, and the result says so.
 *
 * Work is bounded: the input is subsampled (stratified by class) to at most
 * `maxPoints` cycles, so the cost is at most maxPoints^2 distances.
 */
import { rng } from './dataset.ts';
import { standardise } from './pca.ts';

export interface SeparabilityInput {
  x: number[][];
  /** label index per row */
  y: number[];
  /** specimen key per row (Sample.group) */
  group: string[];
  /** time per row, used to halve single-specimen classes */
  t: number[];
  labels: string[];
}

export interface ClassResult {
  label: string;
  /** index into labels */
  y: number;
  n: number;
  specimens: number;
  /** share of its cycles whose neighbours voted for it */
  recall: number;
  /** the class it was most often mistaken for, if any */
  confusedWith: string | null;
  /** only one specimen: tested on the other half of that specimen */
  halved: boolean;
}

export interface PairResult {
  a: string;
  b: string;
  /** balanced accuracy of telling just these two apart, 0.5 = coin toss */
  accuracy: number;
  recallA: number;
  recallB: number;
  /** at least one side had to be halved in time */
  halved: boolean;
}

export interface SeparabilityResult {
  k: number;
  /** cycles actually used after subsampling */
  n: number;
  /** cycles given */
  total: number;
  /** balanced accuracy over all classes present */
  overall: number;
  classes: ClassResult[];
  pairs: PairResult[];
}

/**
 * Indices of at most `cap` rows, sampled per class in proportion to its size,
 * but never fewer than min(size, floor) from any class so small classes stay
 * visible.
 */
export function stratifiedSubsample(y: ArrayLike<number>, cap: number, seed = 1, floor = 60): number[] {
  const n = y.length;
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const by = new Map<number, number[]>();
  for (let i = 0; i < n; i++) (by.get(y[i]) ?? by.set(y[i], []).get(y[i])!).push(i);
  const r = rng(seed);
  const out: number[] = [];
  for (const idx of by.values()) {
    const want = Math.min(idx.length, Math.max(Math.round((cap * idx.length) / n), Math.min(floor, idx.length)));
    // Partial Fisher-Yates: the first `want` entries become a random pick.
    for (let i = 0; i < want; i++) {
      const j = i + Math.floor(r() * (idx.length - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    out.push(...idx.slice(0, want).sort((a, b) => a - b));
  }
  return out.sort((a, b) => a - b);
}

export function separability(inp: SeparabilityInput, opts: { k?: number; maxPoints?: number; seed?: number } = {}): SeparabilityResult {
  const k = opts.k ?? 5;
  const keep = stratifiedSubsample(inp.y, opts.maxPoints ?? 1500, opts.seed ?? 1);
  const n = keep.length;
  const y = Int32Array.from(keep, (i) => inp.y[i]);
  const present = [...new Set(y)].sort((a, b) => a - b);

  // Specimen keys, halving classes that only have one specimen.
  const groupsOf = new Map<number, Set<string>>();
  for (const i of keep) (groupsOf.get(inp.y[i]) ?? groupsOf.set(inp.y[i], new Set()).get(inp.y[i])!).add(inp.group[i]);
  const halved = new Set<number>();
  const groupKey: string[] = keep.map((i) => inp.group[i]);
  for (const c of present) {
    if (groupsOf.get(c)!.size >= 2) continue;
    halved.add(c);
    const rows = [];
    for (let r = 0; r < n; r++) if (y[r] === c) rows.push(r);
    const times = rows.map((r) => inp.t[keep[r]]).sort((a, b) => a - b);
    const mid = times[times.length >> 1];
    for (const r of rows) groupKey[r] += inp.t[keep[r]] < mid ? ':first half' : ':second half';
  }
  const gid = new Int32Array(n);
  {
    const ids = new Map<string, number>();
    groupKey.forEach((g, r) => {
      if (!ids.has(g)) ids.set(g, ids.size);
      gid[r] = ids.get(g)!;
    });
  }

  const { z } = standardise(keep.map((i) => inp.x[i]));
  const d = z.length ? z[0].length : 0;

  // Neighbour order for every row, other specimens only, nearest first.
  const order: Int32Array[] = new Array(n);
  const dist = new Float64Array(n);
  const idx = new Int32Array(n);
  for (let a = 0; a < n; a++) {
    const za = z[a];
    let m = 0;
    for (let b = 0; b < n; b++) {
      if (gid[b] === gid[a]) continue;
      const zb = z[b];
      let s = 0;
      for (let j = 0; j < d; j++) {
        const q = za[j] - zb[j];
        s += q * q;
      }
      dist[b] = s;
      idx[m++] = b;
    }
    const o = idx.slice(0, m);
    o.sort((p, q) => dist[p] - dist[q]);
    order[a] = o;
  }

  /** Vote among the first k neighbours whose label is in `allowed`. */
  const vote = (a: number, allowed: (c: number) => boolean): number => {
    const counts = new Map<number, number>();
    let first = -1;
    let got = 0;
    for (const b of order[a]) {
      const c = y[b];
      if (!allowed(c)) continue;
      if (first < 0) first = c;
      counts.set(c, (counts.get(c) ?? 0) + 1);
      if (++got >= k) break;
    }
    let best = first;
    let bestN = -1;
    for (const [c, v] of counts) {
      if (v > bestN || (v === bestN && c === first)) {
        best = c;
        bestN = v;
      }
    }
    return best;
  };

  const all = new Set(present);
  const pred = new Int32Array(n);
  for (let a = 0; a < n; a++) pred[a] = vote(a, (c) => all.has(c));

  const classes: ClassResult[] = present.map((c) => {
    let tot = 0;
    let ok = 0;
    const wrong = new Map<number, number>();
    for (let a = 0; a < n; a++) {
      if (y[a] !== c) continue;
      tot++;
      if (pred[a] === c) ok++;
      else if (pred[a] >= 0) wrong.set(pred[a], (wrong.get(pred[a]) ?? 0) + 1);
    }
    const top = [...wrong.entries()].sort((p, q) => q[1] - p[1])[0];
    return {
      label: inp.labels[c],
      y: c,
      n: tot,
      specimens: groupsOf.get(c)!.size,
      recall: tot ? ok / tot : 0,
      confusedWith: top ? inp.labels[top[0]] : null,
      halved: halved.has(c),
    };
  });

  const pairs: PairResult[] = [];
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const A = present[i];
      const B = present[j];
      const allowed = (c: number) => c === A || c === B;
      let na = 0, oka = 0, nb = 0, okb = 0;
      for (let a = 0; a < n; a++) {
        if (y[a] === A) {
          na++;
          if (vote(a, allowed) === A) oka++;
        } else if (y[a] === B) {
          nb++;
          if (vote(a, allowed) === B) okb++;
        }
      }
      const ra = na ? oka / na : 0;
      const rb = nb ? okb / nb : 0;
      pairs.push({ a: inp.labels[A], b: inp.labels[B], accuracy: (ra + rb) / 2, recallA: ra, recallB: rb, halved: halved.has(A) || halved.has(B) });
    }
  }

  return {
    k,
    n,
    total: inp.y.length,
    overall: classes.length ? classes.reduce((s, c) => s + c.recall, 0) / classes.length : 0,
    classes,
    pairs,
  };
}

export type VerdictLevel = 'ok' | 'warn' | 'bad';

export interface Verdict {
  level: VerdictLevel;
  text: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Plain-English sentences for the result, best news last is not the goal:
 *  the worst pairs come first, since that is what the user needs to act on. */
export function describeSeparability(r: SeparabilityResult, profileName: string): Verdict[] {
  const out: Verdict[] = [];
  if (r.classes.length < 2) {
    out.push({ level: 'warn', text: 'Only one class has cycles with these settings, so there is nothing to tell apart. Assign classes to more specimens on the Data page.' });
    return out;
  }
  const pairs = [...r.pairs].sort((p, q) => p.accuracy - q.accuracy);
  for (const p of pairs) {
    const tested = p.halved ? 'tested within a single specimen, see the note below' : 'testing on specimens held out';
    if (p.accuracy >= 0.9) {
      out.push({ level: 'ok', text: `${p.a} and ${p.b} separate cleanly (${pct(p.accuracy)} of cycles land nearest their own class, ${tested}).` });
    } else if (p.accuracy >= 0.75) {
      out.push({ level: 'warn', text: `${p.a} and ${p.b} mostly separate, but not reliably (${pct(p.accuracy)} of cycles land nearest their own class, ${tested}). A model will make some mistakes between them.` });
    } else {
      const worse = p.accuracy < 0.4
        ? ' Fewer than by chance: their cycles sit closer to the other class than to the rest of their own, which usually means the readings drifted over time more than these classes differ.'
        : '';
      out.push({ level: 'bad', text: `${p.a} and ${p.b} overlap (${pct(p.accuracy)} of cycles land nearest their own class; 50% would be a coin toss).${worse} A model will struggle to tell them apart with ${profileName}. Try another heater profile or feature set, or record more specimens.` });
    }
  }
  const halved = r.classes.filter((c) => c.halved).map((c) => c.label);
  if (halved.length) {
    out.push({
      level: 'warn',
      text: `${halved.join(', ')} ${halved.length > 1 ? 'have' : 'has'} only one specimen, so ${halved.length > 1 ? 'they were' : 'it was'} tested against the other half of the same specimen. Record ${halved.length > 1 ? 'each' : 'it'} again on another occasion for an honest answer.`,
    });
  }
  return out;
}
