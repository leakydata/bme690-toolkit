import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boschPlan, classOfLabel, defaultPlan, planProblem, schedule, TEMPLATES, totalSeconds } from '../src/plugins/quick/plan.ts';

const coffee = defaultPlan(TEMPLATES[0]);

test('repeated rounds are the default and alternate order each round', () => {
  assert.equal(coffee.method, 'rounds');
  const b = schedule(coffee);
  assert.equal(b.length, 8);
  assert.deepEqual(b.slice(0, 4).map((x) => x.className), ['Air', 'Coffee', 'Coffee', 'Air']);
  assert.deepEqual(b.map((x) => x.label).slice(0, 2), ['Air 1', 'Coffee 1']);
  assert.ok(b.every((x) => x.settleSeconds === 60 && x.recordSeconds === 240));
  assert.equal(totalSeconds(coffee), 8 * 300);
});

test('Bosch standard is one 30-minute block each', () => {
  const b = schedule(boschPlan(coffee));
  assert.equal(b.length, 2);
  assert.deepEqual(b.map((x) => x.label), ['Air', 'Coffee']);
  assert.equal(b[0].settleSeconds + b[0].recordSeconds, 1800);
});

test('labels map back to classes; settling maps to none', () => {
  assert.equal(classOfLabel(coffee, 'Coffee 3'), 'Coffee');
  assert.equal(classOfLabel(coffee, 'Air'), 'Air');
  assert.equal(classOfLabel(coffee, 'settling'), null);
  assert.equal(classOfLabel(coffee, 'Coffee beans'), null);
});

test('plan problems are explained', () => {
  assert.equal(planProblem(coffee), null);
  assert.match(planProblem({ ...coffee, classes: ['Air', 'air'] })!, /different name/);
  assert.match(planProblem({ ...coffee, classes: ['Air'] })!, /at least two/);
});
