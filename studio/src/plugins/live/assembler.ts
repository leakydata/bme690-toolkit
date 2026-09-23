/**
 * Live cycle assembly: the board's D lines, one sensor at a time, into
 * complete heater cycles as they happen. Same rules as core/assemble.ts
 * (AI-Studio's importer): per sensor, a new cycle starts at step 0, at a
 * step already seen in the current cycle, or after a higher step. A cycle is
 * complete once all ten steps are in -- it is handed out straight away
 * rather than when the next cycle begins, so predictions keep up.
 */
import type { BoardPoint } from '../../core/board-serial.ts';
import { STEPS, type BoardConfig, type Cycle } from '../../core/types.ts';

interface Open {
  steps: (BoardPoint | undefined)[];
}

export class LiveAssembler {
  private open = new Map<number, Open>();
  /** cycles started but abandoned before all ten steps arrived */
  dropped = 0;
  complete = 0;

  private config: BoardConfig | null;

  constructor(config: BoardConfig | null) {
    this.config = config;
  }

  setConfig(c: BoardConfig | null) {
    this.config = c;
    this.open.clear();
  }

  profileOf(sensor: number): string {
    return this.config?.sensors.find((s) => s.sensorIndex === sensor)?.heaterProfile ?? '';
  }

  /** Feed one point; returns the cycle it completes, if any. */
  push(p: BoardPoint): Cycle | null {
    if (!(p.step >= 0 && p.step < STEPS)) {
      return null;
    }
    let cur = this.open.get(p.sensor);
    const isNew =
      !cur ||
      p.step === 0 ||
      cur.steps[p.step] !== undefined ||
      cur.steps.some((v, s) => v !== undefined && s > p.step);
    if (isNew) {
      if (cur && cur.steps.some((v) => v !== undefined)) {
        this.dropped++;
      }
      cur = { steps: new Array(STEPS).fill(undefined) };
      this.open.set(p.sensor, cur);
    }
    cur!.steps[p.step] = p;
    if (cur!.steps.every((v) => v !== undefined)) {
      this.open.delete(p.sensor);
      this.complete++;
      const s = cur!.steps as BoardPoint[];
      return {
        sensor: p.sensor,
        start: s[0].ms,
        end: s[STEPS - 1].ms,
        heaterProfile: this.profileOf(p.sensor),
        gas: s.map((x) => x.gas),
        temp: s[0].temp,
        hum: s[0].hum,
        press: s[0].press,
        specimen: 0,
      };
    }
    return null;
  }

  reset() {
    this.open.clear();
    this.dropped = 0;
    this.complete = 0;
  }
}

/** A prediction for one cycle (per-sensor model) or one round (fused). */
export interface Vote {
  sensor: number | null;
  probs: number[];
}

export interface Answer {
  /** index into the model's labels */
  label: number;
  /** 0..1 */
  confidence: number;
  /** sensors agreeing / sensors voting (1/1 for a fused model) */
  agree: number;
  voters: number;
  at: number;
}

/**
 * Majority vote across sensors. The winner is the label most sensors pick
 * (ties go to the higher average probability); confidence is the winner's
 * average probability across all voting sensors, so disagreement lowers it.
 */
export function combineVotes(votes: Vote[], at = Date.now()): Answer | null {
  if (votes.length === 0) return null;
  const n = votes[0].probs.length;
  const count = new Array(n).fill(0);
  const sum = new Array(n).fill(0);
  for (const v of votes) {
    let best = 0;
    for (let i = 1; i < n; i++) if (v.probs[i] > v.probs[best]) best = i;
    count[best]++;
    for (let i = 0; i < n; i++) sum[i] += v.probs[i] ?? 0;
  }
  let win = 0;
  for (let i = 1; i < n; i++) {
    if (count[i] > count[win] || (count[i] === count[win] && sum[i] > sum[win])) win = i;
  }
  return { label: win, confidence: sum[win] / votes.length, agree: count[win], voters: votes.length, at };
}

/**
 * Collects per-sensor cycles into rounds: one cycle from each expected
 * sensor. A round closes when every expected sensor has delivered, or when
 * a sensor delivers a second cycle before the others catch up (a sensor has
 * gone quiet or runs a different duty cycle) -- then with what it has.
 */
export class RoundCollector {
  private pending = new Map<number, Cycle>();

  expected: () => number[];

  constructor(expected: () => number[]) {
    this.expected = expected;
  }

  /** Returns the finished round's cycles, if this one closed a round. */
  push(c: Cycle): Cycle[] | null {
    let out: Cycle[] | null = null;
    if (this.pending.has(c.sensor)) {
      out = [...this.pending.values()];
      this.pending.clear();
    }
    this.pending.set(c.sensor, c);
    const want = this.expected();
    if (!out && want.length > 0 && want.every((s) => this.pending.has(s))) {
      out = [...this.pending.values()];
      this.pending.clear();
    }
    return out;
  }

  clear() {
    this.pending.clear();
  }
}

/** A regression model's answer for one round. */
export interface Estimate {
  /** median of the sensors' estimates (the one estimate for a fused model) */
  value: number;
  /** half the spread between the lowest and highest sensor estimate: shown as ± */
  spread: number;
  voters: number;
  at: number;
}

/** Combine per-sensor estimates: the median, robust to one odd sensor, and how far apart they are. */
export function combineEstimates(values: number[], at = Date.now()): Estimate | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  const value = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { value, spread: (v[v.length - 1] - v[0]) / 2, voters: v.length, at };
}
