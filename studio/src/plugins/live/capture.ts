/**
 * An in-app capture: the board's live points, labelled on this computer,
 * turned into a Recording exactly like an imported .bmerawdata would be.
 */
import { buildCycles, buildSpecimens, emptyPoints, type LabelInfo } from '../../core/assemble.ts';
import type { BoardPoint } from '../../core/board-serial.ts';
import { newId } from '../../core/ids.ts';
import type { BoardConfig, Points, Recording, SpecimenClass } from '../../core/types.ts';

/** HP-354 on every sensor, continuous: what the board runs out of the box. */
export function defaultConfig(): BoardConfig {
  return {
    boardType: 'board_690',
    boardMode: 'burn_in',
    heaterProfiles: [{
      id: 'heater_354',
      name: 'HP-354',
      timeBase: 140,
      steps: [[320, 5], [100, 2], [100, 10], [100, 30], [200, 5], [200, 5], [200, 5], [320, 5], [320, 5], [320, 5]],
    }],
    dutyCycleProfiles: [{ id: 'duty_1', scanningCycles: 1, sleepingCycles: 0 }],
    sensors: Array.from({ length: 8 }, (_, i) => ({ sensorIndex: i, active: true, heaterProfile: 'heater_354', dutyCycleProfile: 'duty_1' })),
  };
}

const COLS = ['sensor', 't', 'rtc', 'temp', 'press', 'hum', 'gas', 'step', 'tag'] as const;

export class Capture {
  readonly startedAt: number;
  /** tag -> name, in the order the samples were started */
  readonly labels = new Map<number, string>();
  tag = 0;
  private cols: Record<(typeof COLS)[number], number[]> = Object.fromEntries(COLS.map((c) => [c, []])) as never;
  private t0: number | null = null;
  private lastMs = 0;
  private offset = 0;

  constructor(firstName: string, now = Date.now()) {
    this.startedAt = now;
    this.next(firstName);
  }

  get length() {
    return this.cols.t.length;
  }

  /** ms from the first point to the last */
  get duration() {
    const t = this.cols.t;
    return t.length ? t[t.length - 1] : 0;
  }

  /** Start the next sample; returns its tag. */
  next(name: string): number {
    this.tag++;
    this.labels.set(this.tag, name.trim() || `sample ${this.tag}`);
    return this.tag;
  }

  rename(tag: number, name: string) {
    // Kept as typed (even empty, mid-edit); names() fills blanks in.
    if (this.labels.has(tag)) this.labels.set(tag, name);
  }

  /** tag -> name, with blank names filled in */
  names(): Map<number, string> {
    return new Map([...this.labels].map(([t, n]) => [t, n.trim() || `sample ${t}`]));
  }

  add(p: BoardPoint, now = Date.now()) {
    // If the board restarted mid-capture its clock starts again at zero;
    // carry on from where we were so time keeps going forward.
    if (p.ms + this.offset < this.lastMs - 10_000) {
      this.offset = this.lastMs - p.ms + 1000;
    }
    const ms = p.ms + this.offset;
    this.lastMs = Math.max(this.lastMs, ms);
    if (this.t0 === null) this.t0 = ms;
    const c = this.cols;
    c.sensor.push(p.sensor);
    c.t.push(ms - this.t0);
    c.rtc.push(Math.round(now / 1000));
    c.temp.push(p.temp);
    c.press.push(p.press);
    c.hum.push(p.hum);
    c.gas.push(p.gas);
    c.step.push(p.step);
    c.tag.push(this.tag);
  }

  points(): Points {
    const n = this.length;
    const p = emptyPoints(n);
    const c = this.cols;
    p.sensor.set(c.sensor);
    p.t.set(c.t);
    p.rtc.set(c.rtc);
    p.temp.set(c.temp);
    p.press.set(c.press);
    p.hum.set(c.hum);
    p.gas.set(c.gas);
    p.step.set(c.step);
    p.tag.set(c.tag);
    return p;
  }

  /**
   * The capture as a Recording. With `classes`, samples are sorted into
   * classes named after them (the project merges these with its own classes
   * of the same name).
   */
  toRecording(opts: { name: string; config: BoardConfig | null; boardId: string; firmware: string; classes: boolean }): {
    recording: Omit<Recording, 'projectId'>;
    classes: SpecimenClass[];
  } {
    const points = this.points();
    const labelInfo = new Map<number, LabelInfo>();
    for (const [tag, name] of this.names()) labelInfo.set(tag, { name, description: '' });
    const specimens = buildSpecimens(points, labelInfo);
    const config = opts.config ?? defaultConfig();
    const { cycles, dropped } = buildCycles(points, config, specimens);
    const classes: SpecimenClass[] = [];
    if (opts.classes) {
      for (const sp of specimens) {
        let c = classes.find((x) => x.name.toLowerCase() === sp.name.toLowerCase());
        if (!c) {
          c = { id: newId('cls'), name: sp.name, color: '' };
          classes.push(c);
        }
        sp.classId = c.id;
      }
    }
    return {
      recording: {
        id: newId('rec'),
        name: opts.name,
        sources: [],
        importedAt: this.startedAt,
        boardId: opts.boardId,
        firmware: opts.firmware,
        config,
        points,
        cycles,
        droppedCycles: dropped,
        specimens,
      },
      classes,
    };
  }
}
