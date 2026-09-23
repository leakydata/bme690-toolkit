import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { groupFiles, parseSession, writeRecording } from '../src/core/bmerawdata.ts';

// Real files recorded by the ESP32-S3 logger, checked against AI-Studio 3.1.0.
const DIR = new URL('./fixtures/', import.meta.url).pathname;
const files = readdirSync(DIR).map((name: string) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));

test('groups chunks and label files into sessions', () => {
  const s = groupFiles(files);
  assert.deepEqual(s.map((x) => x.stem).sort(), ['s0001', 's0002']);
  assert.ok(s.every((x) => x.raw.length === 1 && x.labels.length === 1));
});

test('yields the cycles and specimens AI-Studio does', () => {
  const byStem = Object.fromEntries(groupFiles(files).map((x) => [x.stem, parseSession(x.stem, x.raw, x.labels)]));
  // AI-Studio 3.1.0's parser on the same files, counting only complete,
  // error-free cycles (its import drops the rest): 48 and 48.
  // s0002 has specimens "sample 1" then "coffee test".
  assert.equal(byStem.s0001.cycles.length, 48);
  assert.equal(byStem.s0002.cycles.length, 48);
  assert.deepEqual(byStem.s0002.specimens.map((s) => s.name), ['sample 1', 'coffee test']);
  assert.equal(byStem.s0002.config.boardType, 'board_690');
  assert.equal(byStem.s0002.config.sensors.length, 8);
  for (const c of byStem.s0002.cycles) {
    assert.equal(c.gas.length, 10);
    assert.ok(c.gas.every((g) => g > 0));
  }
});

test('round-trips through the writer', () => {
  const g = groupFiles(files).find((x) => x.stem === 's0002')!;
  const r = { ...parseSession(g.stem, g.raw, g.labels), projectId: 'p' };
  const out = writeRecording(r);
  const again = parseSession('x', [{ name: 'x.bmerawdata', text: out.raw }], [{ name: 'x.bmelabelinfo', text: out.labels }]);
  assert.equal(again.cycles.length, r.cycles.length);
  assert.deepEqual(again.specimens.map((s) => s.name), r.specimens.map((s) => s.name));
});
