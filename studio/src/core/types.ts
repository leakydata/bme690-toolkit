/**
 * The data model every part of the studio shares.
 *
 * Vocabulary follows BME AI-Studio so its users feel at home:
 *   recording  -- one measurement session (one or more .bmerawdata chunks)
 *   specimen   -- a stretch of a recording carrying one label ("coffee #3")
 *   class      -- what a specimen *is* for training ("Coffee"); many
 *                 specimens share a class
 *   cycle      -- one pass of one sensor through its ten-step heater
 *                 profile: the unit models train on
 */

export type BoardType = 'board_690' | 'board_8' | (string & {});

export const STEPS = 10;

export interface HeaterProfile {
  id: string;
  name?: string;
  /** ms per duration unit */
  timeBase: number;
  /** [temperature degC, duration in timeBase units], exactly ten */
  steps: [number, number][];
}

export interface DutyCycleProfile {
  id: string;
  name?: string;
  scanningCycles: number;
  sleepingCycles: number;
}

export interface SensorConfig {
  sensorIndex: number;
  active: boolean;
  heaterProfile: string;
  dutyCycleProfile: string;
}

export interface BoardConfig {
  boardType: BoardType;
  boardMode: string;
  heaterProfiles: HeaterProfile[];
  dutyCycleProfiles: DutyCycleProfile[];
  sensors: SensorConfig[];
}

/**
 * Every data point of a recording, column by column. Typed arrays keep a
 * twelve-hour, eight-sensor session (hundreds of thousands of points) small
 * in memory and in IndexedDB.
 */
export interface Points {
  length: number;
  sensor: Uint8Array;
  /** ms since the board powered on */
  t: Float64Array;
  /** wall clock, unix seconds (0 when the board's clock was not set) */
  rtc: Float64Array;
  temp: Float32Array;
  /** hPa */
  press: Float32Array;
  /** %RH */
  hum: Float32Array;
  /** ohm */
  gas: Float32Array;
  step: Uint8Array;
  tag: Uint16Array;
  error: Uint8Array;
}

export interface Cycle {
  sensor: number;
  /** ms since power-on of the first and last point */
  start: number;
  end: number;
  heaterProfile: string;
  /** gas resistance in ohm at steps 0..9 */
  gas: number[];
  /** environment at the first point, as AI-Studio uses it */
  temp: number;
  hum: number;
  press: number;
  /** index into Recording.specimens */
  specimen: number;
}

export interface Specimen {
  /** stable within the recording */
  id: string;
  tag: number;
  name: string;
  comment: string;
  /** ms since power-on */
  start: number;
  end: number;
  /** SpecimenClass.id, or null when not assigned */
  classId: string | null;
}

export interface Recording {
  id: string;
  projectId: string;
  name: string;
  /** file names it came from */
  sources: string[];
  importedAt: number;
  boardId: string;
  firmware: string;
  config: BoardConfig;
  points: Points;
  cycles: Cycle[];
  /** incomplete or errored cycles the importer set aside */
  droppedCycles: number;
  specimens: Specimen[];
}

export interface SpecimenClass {
  id: string;
  name: string;
  color: string;
}

/** How samples were built from cycles; a saved model keeps these to rebuild
 *  its inputs when it runs on new data. */
export interface DatasetSpec {
  featureSet: string;
  /** append temperature, humidity and pressure */
  environment: boolean;
  heaterProfile: string;
  /** sensor indices; empty means all */
  sensors: number[];
  mode: 'per-sensor' | 'fused';
  /** class id -> output label */
  labelOf: Record<string, string>;
}

/** A trained model, stored with everything needed to run it again. */
export interface ModelRecord {
  id: string;
  name: string;
  created: number;
  /** plugin id of the model kind, e.g. "mlp" */
  kind: string;
  dataset: DatasetSpec;
  /** output labels in order */
  labels: string[];
  featureNames: string[];
  params: Record<string, unknown>;
  /** test results: accuracy, confusion matrix, split used ... */
  metrics: Record<string, unknown>;
  /** kind-specific serialised model, from Predictor.save() */
  state: unknown;
}

export interface Project {
  id: string;
  name: string;
  created: number;
  updated: number;
  classes: SpecimenClass[];
  models: ModelRecord[];
}
