/**
 * Running a saved model on new cycles -- from an imported recording or live
 * from the board. Rebuilds each input exactly the way the model was trained.
 */
import type { Cycle, ModelRecord, Task } from '../core/types.ts';
import { getFeatureSet } from './features.ts';
import { getModelKind, type Predictor } from './models.ts';

export interface Runner {
  model: ModelRecord;
  /** 'regress': predict() returns [value]; old models without a task classify */
  task: Task;
  labels: string[];
  /** does this model take one sensor's cycle, or all sensors' at once? */
  mode: 'per-sensor' | 'fused';
  /** sensors whose cycles the model uses, ascending */
  sensors: number[] | null;
  /**
   * Probabilities per label (regression: [estimated value]), or null when the cycles don't fit the model
   * (wrong heater profile, missing sensor ...). For a per-sensor model pass
   * one cycle; for a fused model pass one cycle per sensor, in any order.
   */
  predict(cycles: Cycle[]): number[] | null;
}

export async function loadRunner(model: ModelRecord): Promise<Runner> {
  const predictor: Predictor = await getModelKind(model.kind).load(model.state);
  const spec = model.dataset;
  const fs = getFeatureSet(spec.featureSet);
  const fixedSensors = spec.sensors.length ? [...spec.sensors].sort((a, b) => a - b) : null;

  return {
    model,
    task: spec.task === 'regress' ? 'regress' : 'classify',
    labels: model.labels,
    mode: spec.mode,
    sensors: fixedSensors,
    predict(cycles) {
      if (cycles.length === 0 || cycles.some((c) => c.heaterProfile !== spec.heaterProfile)) {
        return null;
      }
      let x: number[];
      if (spec.mode === 'per-sensor') {
        const c = cycles[0];
        if (fixedSensors && !fixedSensors.includes(c.sensor)) return null;
        x = fs.extract(c, spec);
      } else {
        const sorted = [...cycles].sort((a, b) => a.sensor - b.sensor);
        if (fixedSensors && sorted.map((c) => c.sensor).join() !== fixedSensors.join()) return null;
        x = sorted.flatMap((c) => fs.extract(c, spec));
      }
      if (x.length !== model.featureNames.length) {
        return null;
      }
      return predictor.predict([x])[0];
    },
  };
}
