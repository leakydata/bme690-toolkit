// Runs a model exported by bme690.lab.export.to_studio through BME Studio's
// own loader (loadRunner) and prints its predictions as JSON.
//
//   node studio_roundtrip.ts input.json
//
// input.json: {"model": <ModelRecord>, "cycles": [<Cycle>, ...]} -- per-sensor
// models get one cycle per prediction; for fused models "cycles" is a list of
// lists (one cycle per sensor). Prints {"probs": [[...] | null, ...]}.
import { readFileSync } from 'node:fs';
import '../../studio/src/ml/models/index.ts';
import { loadRunner } from '../../studio/src/ml/run.ts';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const runner = await loadRunner(input.model);
const probs = input.cycles.map((c: unknown) => runner.predict(Array.isArray(c) ? c : [c]));
process.stdout.write(JSON.stringify({ probs, labels: runner.labels, mode: runner.mode }));
