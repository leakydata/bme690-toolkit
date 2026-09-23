/**
 * Feature sets turn one heater cycle into numbers a model can learn from.
 * Register new ones with registerFeatureSet(); they appear in the Train and
 * Explore views automatically.
 */
import type { Cycle } from '../core/types.ts';

export interface FeatureSet {
  id: string;
  name: string;
  /** one or two sentences for the UI */
  description: string;
  /** feature names for one cycle, in output order */
  names(opts: FeatureOptions): string[];
  extract(c: Cycle, opts: FeatureOptions): number[];
}

export interface FeatureOptions {
  /** append temperature, humidity and pressure */
  environment: boolean;
}

const sets: FeatureSet[] = [];

export function registerFeatureSet(f: FeatureSet): void {
  if (!sets.some((x) => x.id === f.id)) {
    sets.push(f);
  }
}

export function getFeatureSets(): readonly FeatureSet[] {
  return sets;
}

export function getFeatureSet(id: string): FeatureSet {
  const f = sets.find((x) => x.id === id);
  if (!f) {
    throw new Error(`Unknown feature set "${id}"`);
  }
  return f;
}

const steps = (prefix: string) => Array.from({ length: 10 }, (_, i) => `${prefix}${i + 1}`);
const env = (o: FeatureOptions, c?: Cycle) =>
  o.environment ? (c ? [c.temp, c.hum, c.press] : ['temperature', 'humidity', 'pressure']) : [];

registerFeatureSet({
  id: 'aistudio',
  name: 'Raw resistance (AI-Studio)',
  description: 'The ten gas resistances of a cycle as they are, like BME AI-Studio. Dominated by the overall resistance level, which drifts.',
  names: (o) => [...steps('gas step '), ...(env(o) as string[])],
  extract: (c, o) => [...c.gas, ...(env(o, c) as number[])],
});

registerFeatureSet({
  id: 'log',
  name: 'Log resistance',
  description: 'Logarithm of each resistance. Gas sensors respond multiplicatively, so this evens out the scale between steps.',
  names: (o) => [...steps('log gas step '), ...(env(o) as string[])],
  extract: (c, o) => [...c.gas.map((g) => Math.log10(Math.max(g, 1))), ...(env(o, c) as number[])],
});

registerFeatureSet({
  id: 'shape',
  name: 'Shape + level',
  description:
    'Separates the pattern across heater steps from the overall resistance level. The pattern is what identifies a smell; the level drifts with age and humidity. Usually the most robust choice.',
  names: (o) => [...steps('shape step '), 'level', ...(env(o) as string[])],
  extract: (c, o) => {
    const l = c.gas.map((g) => Math.log10(Math.max(g, 1)));
    const mean = l.reduce((a, b) => a + b, 0) / l.length;
    return [...l.map((v) => v - mean), mean, ...(env(o, c) as number[])];
  },
});
