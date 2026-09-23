import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pca } from '../src/ml/pca.ts';
import { separability, stratifiedSubsample, describeSeparability } from '../src/ml/separability.ts';
import { rng } from '../src/ml/dataset.ts';
import { bucketMinMax } from '../src/plugins/explore/downsample.ts';

/** Gaussian-ish noise from the shared deterministic generator. */
function noise(r: () => number): number {
  return (r() + r() + r() + r() - 2) * 1.2;
}

test('PCA finds the dominant direction and its share of the variance', () => {
  const r = rng(3);
  // Points along the line y = 2x with a little noise, plus an unrelated noisy third feature.
  const x = Array.from({ length: 400 }, () => {
    const t = noise(r) * 5;
    return [t, 2 * t + noise(r) * 0.05, noise(r)];
  });
  const res = pca(x, 2);
  // After standardising, features 0 and 1 are almost the same, so PC1 ~ (1, 1, 0)/sqrt 2.
  const [a, b, c] = res.components[0];
  assert.ok(Math.abs(Math.abs(a) - Math.SQRT1_2) < 0.02, `pc1 = ${res.components[0]}`);
  assert.ok(Math.abs(Math.abs(b) - Math.SQRT1_2) < 0.02);
  assert.ok(Math.abs(c) < 0.1);
  // Two of three standardised features are one: PC1 carries about 2/3, PC2 about 1/3.
  assert.ok(Math.abs(res.explained[0] - 2 / 3) < 0.03, `explained ${res.explained}`);
  assert.ok(Math.abs(res.explained[1] - 1 / 3) < 0.03);
  // Components are orthonormal.
  const dot = res.components[0].reduce((s, v, i) => s + v * res.components[1][i], 0);
  assert.ok(Math.abs(dot) < 1e-6);
  assert.equal(res.points.length, 400);
});

function blobs(offset: number, specimensPerClass: number) {
  const r = rng(9);
  const x: number[][] = [];
  const y: number[] = [];
  const group: string[] = [];
  const t: number[] = [];
  for (let c = 0; c < 3; c++) {
    for (let s = 0; s < specimensPerClass; s++) {
      for (let i = 0; i < 60; i++) {
        // Class 2 sits on top of class 1: they should overlap.
        const centre = c === 0 ? 0 : offset;
        x.push([centre + noise(r), centre + noise(r), noise(r)]);
        y.push(c);
        group.push(`rec:${c}-${s}`);
        t.push(i);
      }
    }
  }
  return { x, y, group, t, labels: ['Air', 'Coffee', 'Tea'] };
}

test('separability tells clean pairs from overlapping ones, holding specimens out', () => {
  const res = separability(blobs(12, 3), { maxPoints: 2000 });
  const pair = (a: string, b: string) => res.pairs.find((p) => p.a === a && p.b === b)!;
  assert.ok(pair('Air', 'Coffee').accuracy > 0.97, JSON.stringify(pair('Air', 'Coffee')));
  assert.ok(pair('Air', 'Tea').accuracy > 0.97);
  assert.ok(pair('Coffee', 'Tea').accuracy < 0.7, JSON.stringify(pair('Coffee', 'Tea')));
  assert.ok(res.classes.every((c) => !c.halved && c.specimens === 3));
  const text = describeSeparability(res, 'HP-354');
  assert.equal(text[0].level, 'bad');
  assert.match(text[0].text, /Coffee and Tea overlap/);
  assert.ok(text.some((v) => v.level === 'ok' && /Air and Coffee separate cleanly/.test(v.text)));
});

test('a class with one specimen is tested on the other half of it, and says so', () => {
  const res = separability(blobs(12, 1), { maxPoints: 2000 });
  assert.ok(res.classes.every((c) => c.halved));
  assert.ok(res.pairs.find((p) => p.a === 'Air' && p.b === 'Coffee')!.accuracy > 0.95);
  assert.ok(describeSeparability(res, 'HP').some((v) => /only one specimen/.test(v.text)));
});

test('stratified subsampling keeps small classes and respects the cap', () => {
  const y = [...Array(9000).fill(0), ...Array(100).fill(1)];
  const idx = stratifiedSubsample(y, 1000, 1);
  assert.ok(idx.length <= 1060 && idx.length >= 1000, `${idx.length}`);
  assert.ok(idx.filter((i) => y[i] === 1).length >= 60);
  assert.equal(new Set(idx).size, idx.length);
});

test('min/max downsampling keeps spikes and aligns series', () => {
  const n = 100_000;
  const t = Float64Array.from({ length: n }, (_, i) => i);
  const v = Float32Array.from({ length: n }, (_, i) => (i === 54_321 ? 1000 : i % 7));
  const other = { t: Float64Array.from([10, 50_000]), v: Float32Array.from([5, 6]) };
  const [xs, a, b] = bucketMinMax([{ t, v }, other], 0, n - 1, 500);
  assert.equal(xs.length, 1000);
  assert.equal(a.length, 1000);
  assert.equal(b.length, 1000);
  assert.equal(Math.max(...(a.filter((x) => x !== null) as number[])), 1000);
  assert.equal(Math.min(...(a.filter((x) => x !== null) as number[])), 0);
  assert.equal(b.filter((x) => x !== null).length, 4);
});
