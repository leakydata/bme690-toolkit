import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConfig, editableCopy, fromBmeconfig, fromLibrary, isStandard, makeDuty, newConfig, toBmeconfig } from '../src/plugins/profiles/model.ts';

test('a new configuration is valid and round-trips through a .bmeconfig', () => {
  const c = newConfig();
  assert.deepEqual(checkConfig(c).errors, []);
  const text = toBmeconfig(c, new Date('2026-09-23T10:00:00Z'));
  const doc = JSON.parse(text);
  assert.equal(doc.configHeader.boardType, 'board_690');
  assert.equal(doc.configHeader.boardMode, 'heater_profile_exploration');
  assert.equal(doc.configHeader.dateCreated, '2026-09-23T10:00:00.000Z');
  assert.deepEqual(doc.configBody.heaterProfiles[0].temperatureTimeVectors[3], [100, 30]);
  const back = fromBmeconfig(text).config;
  assert.equal(back.heaterProfiles[0].name, 'HP-354');
  assert.deepEqual(back.sensors, c.sensors);
  assert.ok(isStandard(back.heaterProfiles[0]));
});

test('limits are checked in plain English', () => {
  const c = newConfig();
  c.heaterProfiles.push(fromLibrary('heater_1')); // HP-001: 429-unit steps
  c.heaterProfiles[0] = { ...c.heaterProfiles[0], steps: c.heaterProfiles[0].steps.map((s, i) => (i === 2 ? [450, s[1]] : s)) as [number, number][] };
  for (const [s, l] of [[1, 1], [1, 2], [2, 2], [3, 3]]) c.dutyCycleProfiles.push(makeDuty(s, l));
  c.sensors.forEach((s) => (s.active = false));
  const { errors } = checkConfig(c);
  assert.ok(errors.some((e) => /step 3: the temperature must be .* 0 to 400 °C \(it is 450\)/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /HP-001.*step 1: the duration .* 1 to 255 .*\(it is 429\)/.test(e)));
  assert.ok(errors.some((e) => /at most 4 duty cycles/.test(e)));
  assert.ok(errors.some((e) => /Switch on at least one sensor/.test(e)));
});

test('duplicating HP-001 caps its steps at the board limit and gets a new id', () => {
  const copy = editableCopy(fromLibrary('heater_1'), ['heater_354']);
  assert.equal(copy.name, 'HP-001 copy');
  assert.equal(copy.id, 'heater_hp_001_copy');
  assert.ok(copy.steps.every((s) => s[0] === 320 && s[1] === 255));
  assert.equal(isStandard(copy), false);
});

test('imports an AI-Studio file with missing sensors and another board type', () => {
  const text = JSON.stringify({
    configHeader: { boardType: 'board_8', boardMode: 'x' },
    configBody: {
      heaterProfiles: [{ id: 'heater_411', timeBase: 140, temperatureTimeVectors: fromLibrary('heater_411').steps }],
      dutyCycleProfiles: [{ id: 'duty_1', numberScanningCycles: 1, numberSleepingCycles: 0 }],
      sensorConfigurations: [{ sensorIndex: 0, active: true, heaterProfile: 'heater_411', dutyCycleProfile: 'duty_1' }],
    },
  });
  const { config, notes } = fromBmeconfig(text);
  assert.equal(config.boardType, 'board_690');
  assert.equal(config.sensors.length, 8);
  assert.equal(config.sensors.filter((s) => s.active).length, 1);
  assert.equal(config.heaterProfiles[0].name, 'HP-411');
  assert.equal(notes.length, 2);
  assert.deepEqual(checkConfig(config).errors, []);
  assert.throws(() => fromBmeconfig('nope'), /not JSON/);
});
