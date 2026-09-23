/**
 * Board configurations for the Heater profiles page: building, checking and
 * exporting .bmeconfig files for the BME690 8x shuttle board (board_690).
 * No UI here, so it can be tested.
 */
import { configToJson, parseConfig } from '../../core/bmerawdata.ts';
import { STEPS, type BoardConfig, type DutyCycleProfile, type HeaterProfile } from '../../core/types.ts';
import { DUTY_LIBRARY, HEATER_LIBRARY } from './library.ts';

/** Limits the board's firmware enforces (main/config.c) and AI-Studio's
 *  board_690 limits (board_types.json). */
export const LIMITS = {
  maxHeaterProfiles: 4,
  maxDutyCycles: 4,
  sensors: 8,
  tempMin: 0,
  tempMax: 400,
  durMin: 1,
  durMax: 255,
  timeBaseMin: 1,
  timeBaseMax: 5000,
  /** the firmware keeps ids in 40-byte strings */
  idMax: 39,
  cyclesMax: 65535,
};

export function libraryHeater(id: string) {
  return HEATER_LIBRARY.find((h) => h.id === id);
}

/** "heater_coffee_sniff" -> "coffee sniff": exported files carry only ids. */
export function prettyId(id: string): string {
  return id.replace(/^heater_/, '').replace(/_/g, ' ').trim() || id;
}

/** A profile is "standard" when it is one of Bosch's, unchanged. */
export function isStandard(h: HeaterProfile): boolean {
  const lib = libraryHeater(h.id);
  return !!lib && lib.timeBase === h.timeBase && lib.steps.every((s, i) => s[0] === h.steps[i]?.[0] && s[1] === h.steps[i]?.[1]);
}

export function heaterName(h: HeaterProfile): string {
  return h.name || libraryHeater(h.id)?.name || h.id;
}

export function dutyId(scanning: number, sleeping: number): string {
  return DUTY_LIBRARY.find((d) => d.scanningCycles === scanning && d.sleepingCycles === sleeping)?.id ?? `duty_${scanning}_${sleeping}`;
}

export function dutyName(d: DutyCycleProfile): string {
  return DUTY_LIBRARY.find((x) => x.id === d.id)?.name ?? d.name ?? `RDC-${d.scanningCycles}-${d.sleepingCycles}`;
}

export function makeDuty(scanning: number, sleeping: number): DutyCycleProfile {
  const id = dutyId(scanning, sleeping);
  return { id, name: DUTY_LIBRARY.find((d) => d.id === id)?.name ?? `RDC-${scanning}-${sleeping}`, scanningCycles: scanning, sleepingCycles: sleeping };
}

/** Units of time base in one cycle, and milliseconds. */
export function cycleMs(h: HeaterProfile): number {
  return h.steps.reduce((a, s) => a + (Number(s[1]) || 0), 0) * (Number(h.timeBase) || 0);
}

export function fmtCycle(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'profile';
}

/** An id for a custom profile, from its name, unique within the config. */
export function customHeaterId(name: string, taken: string[]): string {
  const base = `heater_${slug(name)}`.slice(0, LIMITS.idMax - 3);
  let id = base;
  for (let n = 2; taken.includes(id) || (libraryHeater(id) !== undefined); n++) id = `${base}_${n}`;
  return id;
}

/** A copy of a heater profile the user can edit. HP-001's 429-unit steps are
 *  capped at the board's 255. */
export function editableCopy(h: HeaterProfile, taken: string[]): HeaterProfile {
  const name = `${heaterName(h)} copy`;
  return {
    id: customHeaterId(name, taken),
    name,
    timeBase: h.timeBase,
    steps: h.steps.map((s) => [s[0], Math.min(s[1], LIMITS.durMax)] as [number, number]),
  };
}

export function fromLibrary(id: string): HeaterProfile {
  const lib = libraryHeater(id)!;
  return { id: lib.id, name: lib.name, timeBase: lib.timeBase, steps: lib.steps.map((s) => [s[0], s[1]] as [number, number]) };
}

/** A fresh configuration: HP-354, continuous, on all eight sensors. */
export function newConfig(): BoardConfig {
  return {
    boardType: 'board_690',
    boardMode: 'heater_profile_exploration',
    heaterProfiles: [fromLibrary('heater_354')],
    dutyCycleProfiles: [makeDuty(1, 0)],
    sensors: Array.from({ length: LIMITS.sensors }, (_, i) => ({ sensorIndex: i, active: true, heaterProfile: 'heater_354', dutyCycleProfile: 'duty_1' })),
  };
}

export interface Check {
  errors: string[];
  warnings: string[];
}

const whole = (v: number) => Number.isInteger(v);

/** Every limit, in plain English. Export is allowed only without errors. */
export function checkConfig(c: BoardConfig): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  const L = LIMITS;

  if (c.heaterProfiles.length === 0) errors.push('Add at least one heater profile.');
  if (c.heaterProfiles.length > L.maxHeaterProfiles) {
    errors.push(`A board configuration can hold at most ${L.maxHeaterProfiles} heater profiles (AI-Studio's limit); this one has ${c.heaterProfiles.length}. Remove ${c.heaterProfiles.length - L.maxHeaterProfiles}.`);
  }
  if (c.dutyCycleProfiles.length === 0) errors.push('Add at least one duty cycle.');
  if (c.dutyCycleProfiles.length > L.maxDutyCycles) {
    errors.push(`A board configuration can hold at most ${L.maxDutyCycles} duty cycles (AI-Studio's limit); this one has ${c.dutyCycleProfiles.length}. Remove ${c.dutyCycleProfiles.length - L.maxDutyCycles}.`);
  }

  const ids = new Set<string>();
  for (const h of c.heaterProfiles) {
    const n = `“${heaterName(h)}”`;
    if (ids.has(h.id)) errors.push(`Two heater profiles are called ${n}. Give each a different name.`);
    ids.add(h.id);
    if (!h.id || h.id.length > L.idMax) errors.push(`Heater profile ${n} needs a shorter name (the board keeps at most ${L.idMax} characters of its id).`);
    if (!whole(h.timeBase) || h.timeBase < L.timeBaseMin || h.timeBase > L.timeBaseMax) {
      errors.push(`Heater profile ${n}: the time base must be a whole number of milliseconds from ${L.timeBaseMin} to ${L.timeBaseMax} (Bosch use 140).`);
    }
    if (h.steps.length !== STEPS) errors.push(`Heater profile ${n} has ${h.steps.length} steps; it needs exactly ${STEPS}.`);
    h.steps.forEach(([t, d], i) => {
      if (!whole(t) || t < L.tempMin || t > L.tempMax) {
        errors.push(`Heater profile ${n}, step ${i + 1}: the temperature must be a whole number from ${L.tempMin} to ${L.tempMax} °C${Number.isFinite(t) ? ` (it is ${t})` : ''}.`);
      }
      if (!whole(d) || d < L.durMin || d > L.durMax) {
        errors.push(`Heater profile ${n}, step ${i + 1}: the duration must be a whole number from ${L.durMin} to ${L.durMax} time-base units${Number.isFinite(d) ? ` (it is ${d})` : ''}. The board stores each step's length in one byte.`);
      }
    });
  }

  const dids = new Set<string>();
  for (const d of c.dutyCycleProfiles) {
    const n = `“${dutyName(d)}”`;
    if (dids.has(d.id)) errors.push(`The duty cycle ${n} is in the list twice. Remove one.`);
    dids.add(d.id);
    if (!whole(d.scanningCycles) || d.scanningCycles < 1 || d.scanningCycles > L.cyclesMax) {
      errors.push(`Duty cycle ${n}: scanning cycles must be a whole number from 1 to ${L.cyclesMax}.`);
    }
    if (!whole(d.sleepingCycles) || d.sleepingCycles < 0 || d.sleepingCycles > L.cyclesMax) {
      errors.push(`Duty cycle ${n}: sleeping cycles must be a whole number from 0 to ${L.cyclesMax}.`);
    }
  }

  if (c.sensors.length !== L.sensors) errors.push(`The board has ${L.sensors} sensors; the configuration lists ${c.sensors.length}.`);
  if (!c.sensors.some((s) => s.active)) errors.push('Switch on at least one sensor.');
  for (const s of c.sensors) {
    if (!ids.has(s.heaterProfile)) errors.push(`Sensor ${s.sensorIndex} has no heater profile. Choose one in the Sensors table.`);
    if (!dids.has(s.dutyCycleProfile)) errors.push(`Sensor ${s.sensorIndex} has no duty cycle. Choose one in the Sensors table.`);
  }
  for (const h of c.heaterProfiles) {
    if (!c.sensors.some((s) => s.active && s.heaterProfile === h.id)) {
      warnings.push(`No sensor uses heater profile “${heaterName(h)}”. It will be exported but not run.`);
    }
  }
  for (const d of c.dutyCycleProfiles) {
    if (!c.sensors.some((s) => s.active && s.dutyCycleProfile === d.id)) {
      warnings.push(`No sensor uses duty cycle “${dutyName(d)}”.`);
    }
  }
  return { errors, warnings };
}

/** The .bmeconfig file AI-Studio's "Save board configuration" writes. */
export function toBmeconfig(c: BoardConfig, now = new Date()): string {
  const doc = configToJson({ ...c, boardType: 'board_690', boardMode: 'heater_profile_exploration' }, now.toISOString());
  return JSON.stringify(doc, null, 2);
}

/**
 * Read a .bmeconfig (or the config part of a .bmerawdata). Throws an Error
 * a novice can act on. Names are filled in from Bosch's library where the
 * ids match.
 */
export function fromBmeconfig(text: string): { config: BoardConfig; notes: string[] } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error('That file is not a board configuration (it is not JSON). Choose a .bmeconfig saved from AI-Studio or from this page.');
  }
  const r = root as { configBody?: unknown };
  if (!r || typeof r !== 'object' || !r.configBody) {
    throw new Error('That file has no configBody, so it is not a board configuration. Choose a .bmeconfig file.');
  }
  const config = parseConfig(root);
  const notes: string[] = [];
  if (config.boardType !== 'board_690') {
    notes.push(`It was made for board type "${config.boardType}"; it has been switched to the BME690 8x shuttle board (board_690).`);
    config.boardType = 'board_690';
  }
  config.boardMode = 'heater_profile_exploration';
  config.heaterProfiles = config.heaterProfiles.map((h) => ({ ...h, name: h.name || libraryHeater(h.id)?.name || prettyId(h.id) }));
  config.dutyCycleProfiles = config.dutyCycleProfiles.map((d) => ({ ...d, name: dutyName(d) }));
  // Fill in any of the eight sensors the file leaves out, switched off.
  const byIndex = new Map(config.sensors.map((s) => [s.sensorIndex, s]));
  config.sensors = Array.from({ length: LIMITS.sensors }, (_, i) => byIndex.get(i) ?? {
    sensorIndex: i,
    active: false,
    heaterProfile: config.heaterProfiles[0]?.id ?? '',
    dutyCycleProfile: config.dutyCycleProfiles[0]?.id ?? '',
  });
  if (byIndex.size < LIMITS.sensors) notes.push(`It listed only ${byIndex.size} sensors; the others are switched off.`);
  return { config, notes };
}
