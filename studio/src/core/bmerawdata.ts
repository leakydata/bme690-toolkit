/**
 * Reading and writing BME AI-Studio's .bmerawdata / .bmelabelinfo files.
 * The format is documented in docs/bmerawdata-format.md.
 */
import { buildCycles, buildSpecimens, emptyPoints, type LabelInfo } from './assemble.ts';
import { newId } from './ids.ts';
import type { BoardConfig, Points, Recording } from './types.ts';

export interface InputFile {
  name: string;
  text: string;
}

const REQUIRED = [
  'sensor_index',
  'resistance_gassensor',
  'temperature',
  'pressure',
  'relative_humidity',
  'timestamp_since_poweron',
  'real_time_clock',
  'heater_profile_step_index',
  'error_code',
] as const;

/**
 * AI-Studio treats files named <stem>_<number>.bmerawdata in one folder as
 * one session. Returns the session key and the chunk's sort key.
 */
export function sessionKey(fileName: string): { stem: string; order: string } {
  const base = fileName.replace(/^.*[\\/]/, '');
  const parts = base.split('.');
  if (parts.length !== 2) {
    return { stem: base, order: '' };
  }
  const bits = parts[0].split('_');
  if (bits.length < 2 || !/^\d+$/.test(bits[bits.length - 1])) {
    return { stem: parts[0], order: '' };
  }
  const order = bits.pop()!;
  return { stem: bits.join('_'), order };
}

export function parseConfig(root: any): BoardConfig {
  const hdr = root?.configHeader ?? {};
  const body = root?.configBody ?? {};
  return {
    boardType: hdr.boardType ?? 'board_690',
    boardMode: hdr.boardMode ?? '',
    heaterProfiles: (body.heaterProfiles ?? []).map((h: any) => ({
      id: String(h.id),
      name: h.name,
      timeBase: Number(h.timeBase),
      steps: (h.temperatureTimeVectors ?? []).map((v: number[]) => [Number(v[0]), Number(v[1])]),
    })),
    dutyCycleProfiles: (body.dutyCycleProfiles ?? []).map((d: any) => ({
      id: String(d.id),
      name: d.name,
      scanningCycles: Number(d.numberScanningCycles),
      sleepingCycles: Number(d.numberSleepingCycles),
    })),
    sensors: (body.sensorConfigurations ?? []).map((s: any) => ({
      sensorIndex: Number(s.sensorIndex),
      active: s.active !== false,
      heaterProfile: String(s.heaterProfile),
      dutyCycleProfile: String(s.dutyCycleProfile),
    })),
  };
}

function parseLabels(text: string | undefined, into: Map<number, LabelInfo>) {
  if (!text) {
    return;
  }
  const info = JSON.parse(text);
  for (const l of info?.labelInformation ?? []) {
    into.set(Number(l.labelTag), {
      name: String(l.labelName ?? ''),
      description: String(l.labelDescription ?? ''),
    });
  }
}

/**
 * Parse one session: its .bmerawdata chunks plus any .bmelabelinfo files
 * with matching names. Throws an Error whose message a novice can act on.
 */
export function parseSession(stem: string, raw: InputFile[], labelFiles: InputFile[]): Omit<Recording, 'projectId'> {
  raw = [...raw].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const docs = raw.map((f) => {
    try {
      return JSON.parse(f.text);
    } catch {
      throw new Error(`${f.name} is not a valid .bmerawdata file (it is not JSON). It may be cut short.`);
    }
  });
  for (const [i, d] of docs.entries()) {
    for (const key of ['configHeader', 'configBody', 'rawDataHeader', 'rawDataBody']) {
      if (!d?.[key]) {
        throw new Error(`${raw[i].name} has no ${key}, so it is not a .bmerawdata file.`);
      }
    }
  }

  let total = 0;
  for (const d of docs) {
    total += d.rawDataBody.dataBlock?.length ?? 0;
  }
  const pts: Points = emptyPoints(total);
  let n = 0;
  let t0: number | null = null;

  for (const [fi, d] of docs.entries()) {
    const cols: Record<string, number> = {};
    (d.rawDataBody.dataColumns ?? []).forEach((c: any, i: number) => (cols[c.key] = i));
    for (const key of REQUIRED) {
      if (cols[key] === undefined) {
        throw new Error(`${raw[fi].name} has no "${key}" column, which AI-Studio requires.`);
      }
    }
    const tag = cols.label_tag;
    for (const row of d.rawDataBody.dataBlock ?? []) {
      const step = Number(row[cols.heater_profile_step_index]);
      if (!(step >= 0 && step < 10)) {
        continue;
      }
      const t = Number(row[cols.timestamp_since_poweron]);
      if (t0 === null) {
        t0 = t;
      }
      pts.sensor[n] = Number(row[cols.sensor_index]);
      pts.t[n] = t - t0;
      pts.rtc[n] = Number(row[cols.real_time_clock]) || 0;
      pts.temp[n] = Number(row[cols.temperature]);
      pts.press[n] = Number(row[cols.pressure]);
      pts.hum[n] = Number(row[cols.relative_humidity]);
      pts.gas[n] = Number(row[cols.resistance_gassensor]);
      pts.step[n] = step;
      pts.tag[n] = tag === undefined ? 0 : Number(row[tag]) || 0;
      pts.error[n] = Number(row[cols.error_code]) ? 1 : 0;
      n++;
    }
  }
  const points = trim(pts, n);

  const labels = new Map<number, LabelInfo>();
  for (const f of labelFiles) {
    try {
      parseLabels(f.text, labels);
    } catch {
      throw new Error(`${f.name} is not a valid .bmelabelinfo file.`);
    }
  }

  const config = parseConfig(docs[0]);
  const specimens = buildSpecimens(points, labels);
  const { cycles, dropped } = buildCycles(points, config, specimens);
  const hdr = docs[0].rawDataHeader ?? {};

  return {
    id: newId('rec'),
    name: stem,
    sources: [...raw, ...labelFiles].map((f) => f.name),
    importedAt: Date.now(),
    boardId: String(hdr.boardId ?? ''),
    firmware: String(hdr.firmwareVersion ?? ''),
    config,
    points,
    cycles,
    droppedCycles: dropped,
    specimens,
  };
}

function trim(p: Points, n: number): Points {
  if (n === p.length) {
    return p;
  }
  return {
    length: n,
    sensor: p.sensor.slice(0, n),
    t: p.t.slice(0, n),
    rtc: p.rtc.slice(0, n),
    temp: p.temp.slice(0, n),
    press: p.press.slice(0, n),
    hum: p.hum.slice(0, n),
    gas: p.gas.slice(0, n),
    step: p.step.slice(0, n),
    tag: p.tag.slice(0, n),
    error: p.error.slice(0, n),
  };
}

/** Group dropped/picked files into sessions the way AI-Studio would. */
export function groupFiles(files: InputFile[]): { stem: string; raw: InputFile[]; labels: InputFile[] }[] {
  const sessions = new Map<string, { stem: string; raw: InputFile[]; labels: InputFile[] }>();
  const lower = (s: string) => s.toLowerCase();
  for (const f of files) {
    if (!lower(f.name).endsWith('.bmerawdata')) {
      continue;
    }
    const { stem } = sessionKey(f.name);
    if (!sessions.has(stem)) {
      sessions.set(stem, { stem, raw: [], labels: [] });
    }
    sessions.get(stem)!.raw.push(f);
  }
  for (const f of files) {
    if (!lower(f.name).endsWith('.bmelabelinfo')) {
      continue;
    }
    const base = f.name.replace(/\.bmelabelinfo$/i, '');
    const { stem } = sessionKey(base + '.bmerawdata');
    sessions.get(stem)?.labels.push(f);
  }
  return [...sessions.values()];
}

// ------------------------------------------------------------------ writing

export const DATA_COLUMNS = [
  { name: 'Sensor Index', unit: '', format: 'integer', key: 'sensor_index' },
  { name: 'Sensor ID', unit: '', format: 'integer', key: 'sensor_id' },
  { name: 'Time Since PowerOn', unit: 'Milliseconds', format: 'integer', key: 'timestamp_since_poweron' },
  { name: 'Real time clock', unit: 'Unix Timestamp: seconds since Jan 01 1970. (UTC)', format: 'integer', key: 'real_time_clock' },
  { name: 'Temperature', unit: 'DegreesCelcius', format: 'float', key: 'temperature' },
  { name: 'Pressure', unit: 'Hectopascals', format: 'float', key: 'pressure' },
  { name: 'Relative Humidity', unit: 'Percent', format: 'float', key: 'relative_humidity' },
  { name: 'Resistance Gassensor', unit: 'Ohms', format: 'float', key: 'resistance_gassensor' },
  { name: 'Heater Profile Step Index', unit: '', format: 'integer', key: 'heater_profile_step_index' },
  { name: 'Scanning Mode Enabled', unit: '', format: 'boolean', key: 'scanning_mode_enabled' },
  { name: 'Label Tag', unit: '', format: 'integer', key: 'label_tag' },
  { name: 'Error Code', unit: '', format: 'integer', key: 'error_code' },
];

export function configToJson(c: BoardConfig, dateIso: string) {
  return {
    configHeader: {
      dateCreated: dateIso,
      appVersion: 'bme-studio',
      boardType: c.boardType,
      boardMode: c.boardMode,
      boardLayout: '',
    },
    configBody: {
      heaterProfiles: c.heaterProfiles.map((h) => ({
        id: h.id,
        timeBase: h.timeBase,
        temperatureTimeVectors: h.steps.map((s) => [s[0], s[1]]),
      })),
      dutyCycleProfiles: c.dutyCycleProfiles.map((d) => ({
        id: d.id,
        numberScanningCycles: d.scanningCycles,
        numberSleepingCycles: d.sleepingCycles,
      })),
      sensorConfigurations: c.sensors.map((s) => ({
        sensorIndex: s.sensorIndex,
        active: s.active,
        heaterProfile: s.heaterProfile,
        dutyCycleProfile: s.dutyCycleProfile,
      })),
    },
  };
}

/** A recording back out as an importable .bmerawdata + .bmelabelinfo pair. */
export function writeRecording(r: Recording): { raw: string; labels: string } {
  const date = new Date(r.importedAt).toISOString();
  const p = r.points;
  const rows: unknown[][] = new Array(p.length);
  for (let i = 0; i < p.length; i++) {
    rows[i] = [
      p.sensor[i], p.sensor[i], Math.round(p.t[i]), Math.round(p.rtc[i]),
      +p.temp[i].toFixed(4), +p.press[i].toFixed(4), +p.hum[i].toFixed(4),
      +p.gas[i].toFixed(2), p.step[i], true, p.tag[i], p.error[i],
    ];
  }
  const doc = {
    ...configToJson(r.config, date),
    rawDataHeader: {
      counterPowerOnOff: 1,
      seedPowerOnOff: '',
      counterFileLimit: 1,
      dateCreated: date,
      firmwareVersion: r.firmware,
      boardId: r.boardId,
    },
    rawDataBody: { dataColumns: DATA_COLUMNS, dataBlock: rows },
  };
  const seen = new Map<number, { name: string; comment: string }>();
  for (const s of r.specimens) {
    if (!seen.has(s.tag)) {
      seen.set(s.tag, { name: s.name, comment: s.comment });
    }
  }
  const labels = {
    labelInformation: [...seen].map(([tag, s]) => ({
      labelTag: tag,
      labelName: s.name,
      labelDescription: s.comment,
    })),
  };
  return { raw: JSON.stringify(doc), labels: JSON.stringify(labels, null, 1) };
}
