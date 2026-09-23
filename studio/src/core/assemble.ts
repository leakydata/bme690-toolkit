/**
 * Turns raw data points into cycles and specimens, following the same rules
 * as BME AI-Studio's importer so a file yields the same cycles in both.
 *
 * Cycles: per sensor, a new cycle starts when a point has step 0, repeats a
 * step already in the current cycle, or comes after a higher step. A cycle
 * counts only when all ten steps are present and none carries an error.
 *
 * Specimens: every run of consecutive points (in file order, all sensors
 * interleaved) sharing a label tag is one specimen.
 */
import { STEPS, type BoardConfig, type Cycle, type Points, type Specimen } from './types.ts';

export interface LabelInfo {
  name: string;
  description: string;
  /** measured values carried in BME Studio's extra "values" field */
  values?: Record<string, number>;
}

export function buildSpecimens(points: Points, labels: Map<number, LabelInfo>): Specimen[] {
  const out: Specimen[] = [];
  let cur: Specimen | null = null;

  for (let i = 0; i < points.length; i++) {
    const tag = points.tag[i];
    const t = points.t[i];
    if (!cur || cur.tag !== tag) {
      const info = labels.get(tag);
      cur = {
        id: `sp${out.length}`,
        tag,
        name: info?.name || (tag === 0 ? 'unlabelled' : `label ${tag}`),
        comment: info?.description ?? '',
        start: t,
        end: t,
        classId: null,
        ...(info?.values ? { values: { ...info.values } } : {}),
      };
      out.push(cur);
    }
    cur.end = t;
  }
  return out;
}

/** Specimen index for a time, given specimens sorted by start. */
function specimenAt(specimens: Specimen[], t: number): number {
  let lo = 0;
  let hi = specimens.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (specimens[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

interface Pending {
  idx: (number | undefined)[];
}

export function buildCycles(
  points: Points,
  config: BoardConfig,
  specimens: Specimen[],
): { cycles: Cycle[]; dropped: number } {
  const cycles: Cycle[] = [];
  const current = new Map<number, Pending>();
  let dropped = 0;

  const profileOf = (sensor: number) =>
    config.sensors.find((s) => s.sensorIndex === sensor)?.heaterProfile ?? '';

  const close = (sensor: number, p: Pending) => {
    const idx = p.idx;
    const present = idx.filter((v) => v !== undefined) as number[];
    if (present.length === 0) {
      return;
    }
    const complete = present.length === STEPS;
    const clean = present.every((i) => points.error[i] === 0);
    if (!complete || !clean) {
      dropped++;
      return;
    }
    const ordered = idx as number[];
    const first = Math.min(...ordered);
    const last = Math.max(...ordered);
    cycles.push({
      sensor,
      start: points.t[first],
      end: points.t[last],
      heaterProfile: profileOf(sensor),
      gas: ordered.map((i) => points.gas[i]),
      temp: points.temp[ordered[0]],
      hum: points.hum[ordered[0]],
      press: points.press[ordered[0]],
      specimen: specimenAt(specimens, points.t[first]),
    });
  };

  for (let i = 0; i < points.length; i++) {
    const sensor = points.sensor[i];
    const step = points.step[i];
    if (step >= STEPS) {
      continue;
    }
    let p = current.get(sensor);
    const isNew =
      !p ||
      step === 0 ||
      p.idx[step] !== undefined ||
      p.idx.some((v, s) => v !== undefined && s > step);
    if (isNew) {
      if (p) {
        close(sensor, p);
      }
      p = { idx: new Array(STEPS).fill(undefined) };
      current.set(sensor, p);
    }
    p!.idx[step] = i;
  }
  for (const [sensor, p] of current) {
    close(sensor, p);
  }
  cycles.sort((a, b) => a.start - b.start || a.sensor - b.sensor);
  return { cycles, dropped };
}

export function emptyPoints(n: number): Points {
  return {
    length: n,
    sensor: new Uint8Array(n),
    t: new Float64Array(n),
    rtc: new Float64Array(n),
    temp: new Float32Array(n),
    press: new Float32Array(n),
    hum: new Float32Array(n),
    gas: new Float32Array(n),
    step: new Uint8Array(n),
    tag: new Uint16Array(n),
    error: new Uint8Array(n),
  };
}
