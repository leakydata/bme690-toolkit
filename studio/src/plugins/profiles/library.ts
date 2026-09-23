/**
 * Bosch Sensortec's standard heater profiles and duty cycles, as defined in
 * BME AI-Studio (src/config/heater_profiles.json and duty_cycle_profiles.json).
 * Numbers only: id, name, time base and steps.
 */
import type { DutyCycleProfile, HeaterProfile } from '../../core/types.ts';

export const LIBRARY_CREDIT = "Profile definitions from Bosch Sensortec's BME AI-Studio.";

/** [temperature degC, duration in time-base units] x 10 */
export const HEATER_LIBRARY: Required<HeaterProfile>[] = [
  { id: 'heater_1', name: 'HP-001', timeBase: 140, steps: [[320, 429], [320, 429], [320, 429], [320, 429], [320, 429], [320, 429], [320, 429], [320, 429], [320, 429], [320, 429]] },
  { id: 'heater_354', name: 'HP-354', timeBase: 140, steps: [[320, 5], [100, 2], [100, 10], [100, 30], [200, 5], [200, 5], [200, 5], [320, 5], [320, 5], [320, 5]] },
  { id: 'heater_301', name: 'HP-301', timeBase: 140, steps: [[100, 2], [100, 41], [200, 2], [200, 14], [200, 14], [200, 14], [320, 2], [320, 14], [320, 14], [320, 14]] },
  { id: 'heater_321', name: 'HP-321', timeBase: 140, steps: [[100, 43], [320, 2], [320, 2], [200, 2], [200, 21], [200, 21], [320, 2], [320, 14], [320, 14], [320, 14]] },
  { id: 'heater_322', name: 'HP-322', timeBase: 140, steps: [[100, 64], [320, 2], [320, 2], [200, 2], [200, 31], [200, 31], [320, 2], [320, 20], [320, 21], [320, 21]] },
  { id: 'heater_323', name: 'HP-323', timeBase: 140, steps: [[70, 43], [350, 2], [350, 2], [210, 2], [210, 21], [210, 21], [350, 2], [350, 14], [350, 14], [350, 14]] },
  { id: 'heater_324', name: 'HP-324', timeBase: 140, steps: [[70, 64], [350, 2], [350, 2], [210, 2], [210, 31], [210, 31], [350, 2], [350, 20], [350, 21], [350, 21]] },
  { id: 'heater_331', name: 'HP-331', timeBase: 140, steps: [[50, 70], [50, 70], [350, 1], [350, 1], [350, 138], [140, 70], [140, 70], [350, 1], [350, 1], [350, 138]] },
  { id: 'heater_332', name: 'HP-332', timeBase: 140, steps: [[50, 100], [50, 100], [350, 1], [350, 1], [350, 198], [140, 100], [140, 100], [350, 1], [350, 1], [350, 198]] },
  { id: 'heater_411', name: 'HP-411', timeBase: 140, steps: [[100, 43], [320, 2], [170, 43], [320, 2], [240, 2], [240, 20], [240, 21], [320, 2], [320, 20], [320, 21]] },
  { id: 'heater_412', name: 'HP-412', timeBase: 140, steps: [[100, 64], [320, 2], [170, 64], [320, 2], [240, 2], [240, 31], [240, 32], [320, 2], [320, 31], [320, 32]] },
  { id: 'heater_413', name: 'HP-413', timeBase: 140, steps: [[70, 43], [350, 2], [163, 43], [350, 2], [256, 2], [256, 20], [256, 21], [350, 2], [350, 20], [350, 21]] },
  { id: 'heater_414', name: 'HP-414', timeBase: 140, steps: [[70, 64], [350, 2], [163, 64], [350, 2], [256, 2], [256, 31], [256, 32], [350, 2], [350, 31], [350, 32]] },
  { id: 'heater_501', name: 'HP-501', timeBase: 140, steps: [[210, 24], [265, 2], [265, 22], [320, 2], [320, 22], [265, 24], [210, 24], [155, 24], [100, 24], [155, 24]] },
  { id: 'heater_502', name: 'HP-502', timeBase: 140, steps: [[210, 32], [265, 2], [265, 30], [320, 2], [320, 30], [265, 32], [210, 32], [155, 32], [100, 32], [155, 32]] },
  { id: 'heater_503', name: 'HP-503', timeBase: 140, steps: [[210, 24], [280, 2], [280, 22], [350, 2], [350, 22], [280, 24], [210, 24], [140, 24], [70, 24], [140, 24]] },
  { id: 'heater_504', name: 'HP-504', timeBase: 140, steps: [[210, 32], [280, 2], [280, 30], [350, 2], [350, 30], [280, 32], [210, 32], [140, 32], [70, 32], [140, 32]] },
];

export const DUTY_LIBRARY: Required<DutyCycleProfile>[] = [
  { id: 'duty_1', name: 'RDC-1-0 Continuous', scanningCycles: 1, sleepingCycles: 0 },
  { id: 'duty_1_1', name: 'RDC-1-1', scanningCycles: 1, sleepingCycles: 1 },
  { id: 'duty_1_2', name: 'RDC-1-2', scanningCycles: 1, sleepingCycles: 2 },
  { id: 'duty_1_3', name: 'RDC-1-3', scanningCycles: 1, sleepingCycles: 3 },
  { id: 'duty_1_4', name: 'RDC-1-4', scanningCycles: 1, sleepingCycles: 4 },
  { id: 'duty_2_2', name: 'RDC-2-2', scanningCycles: 2, sleepingCycles: 2 },
  { id: 'duty_2_4', name: 'RDC-2-4', scanningCycles: 2, sleepingCycles: 4 },
  { id: 'duty_2_6', name: 'RDC-2-6', scanningCycles: 2, sleepingCycles: 6 },
  { id: 'duty_2_8', name: 'RDC-2-8', scanningCycles: 2, sleepingCycles: 8 },
  { id: 'duty_3_3', name: 'RDC-3-3', scanningCycles: 3, sleepingCycles: 3 },
  { id: 'duty_3_6', name: 'RDC-3-6', scanningCycles: 3, sleepingCycles: 6 },
  { id: 'duty_3_9', name: 'RDC-3-9', scanningCycles: 3, sleepingCycles: 9 },
  { id: 'duty_3_12', name: 'RDC-3-12', scanningCycles: 3, sleepingCycles: 12 },
  { id: 'duty_4_8', name: 'RDC-4-8', scanningCycles: 4, sleepingCycles: 8 },
  { id: 'duty_5_10', name: 'RDC-5-10', scanningCycles: 5, sleepingCycles: 10 },
  { id: 'duty_6_12', name: 'RDC-6-12', scanningCycles: 6, sleepingCycles: 12 },
];
