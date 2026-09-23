/**
 * Off-main-thread work for the separation map: UMAP layout and the
 * nearest-neighbour separability check. One job per worker; the page
 * terminates the worker to cancel.
 */
import { UMAP } from 'umap-js';
import { rng } from '../../ml/dataset.ts';
import { standardise } from '../../ml/pca.ts';
import { separability, type SeparabilityInput } from '../../ml/separability.ts';

export type WorkerRequest =
  | { kind: 'umap'; x: number[][]; seed: number }
  | { kind: 'separability'; input: SeparabilityInput; maxPoints: number };

export type WorkerReply =
  | { kind: 'progress'; done: number; total: number; embedding?: number[][] }
  | { kind: 'umap-done'; embedding: number[][]; ms: number }
  | { kind: 'separability-done'; result: ReturnType<typeof separability>; ms: number }
  | { kind: 'error'; message: string };

const post = (m: WorkerReply) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const t0 = performance.now();
  try {
    if (req.kind === 'separability') {
      const result = separability(req.input, { maxPoints: req.maxPoints });
      post({ kind: 'separability-done', result, ms: performance.now() - t0 });
      return;
    }
    const z = standardise(req.x).z.map((r) => Array.from(r));
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: Math.max(2, Math.min(15, z.length - 1)),
      minDist: 0.1,
      random: rng(req.seed),
    });
    post({ kind: 'progress', done: 0, total: 1 });
    const total = umap.initializeFit(z);
    for (let i = 0; i < total; i++) {
      umap.step();
      if (i % 25 === 24) post({ kind: 'progress', done: i + 1, total, embedding: i % 100 === 99 ? umap.getEmbedding() : undefined });
    }
    post({ kind: 'umap-done', embedding: umap.getEmbedding(), ms: performance.now() - t0 });
  } catch (err) {
    post({ kind: 'error', message: (err as Error).message });
  }
};
