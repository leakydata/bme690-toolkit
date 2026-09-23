import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { openAiStudioProject } from '../src/core/aistudio-project.ts';

// AI-Studio's bundled demo project, present where AI-Studio is installed.
const DEMO = process.env.AISTUDIO_DEMO ?? '/opt/bme-ai-studio/app/src/config/demo.bmeproject/project.db';

test('opens the AI-Studio demo project', { skip: !existsSync(DEMO) && 'AI-Studio demo not installed' }, async () => {
  const SQL = await initSqlJs();
  const p = openAiStudioProject(SQL, readFileSync(DEMO));
  assert.equal(p.recordings.length, 1);
  const r = p.recordings[0];
  assert.equal(r.config.boardType, 'board_8');
  // 27 specimen rows, of which 21 are per-algorithm copies of the 6 originals.
  assert.equal(r.specimens.length, 6);
  assert.deepEqual(p.classes.map((c) => c.name).sort(), ['Air', 'Coffee', 'Espresso', 'Filter Coffee']);
  // The demo DB holds 3256 cycles, 8 of them marked dropped.
  assert.equal(r.cycles.length, 3256 - 8);
  const cls = (id: string | null) => p.classes.find((c) => c.id === id)?.name ?? null;
  const byName = Object.fromEntries(r.specimens.map((s) => [s.name, cls(s.classId)]));
  // The most specific class wins: Espresso, not Coffee.
  assert.equal(byName['Espresso Coffee'], 'Espresso');
  assert.equal(byName['Filter Coffee'], 'Filter Coffee');
  assert.equal(byName['Neutral Air'], 'Air');
  // Every cycle after warm-up belongs to a specimen with data.
  const perSpec = r.specimens.map((_, i) => r.cycles.filter((c) => c.specimen === i).length);
  assert.ok(perSpec.every((n) => n > 0), `cycles per specimen: ${perSpec}`);
});

test('brings the demo specimens\' measured caffeine across', { skip: !existsSync(DEMO) && 'AI-Studio demo not installed' }, async () => {
  const SQL = await initSqlJs();
  const r = openAiStudioProject(SQL, readFileSync(DEMO)).recordings[0];
  const values = Object.fromEntries(r.specimens.map((s) => [s.name, s.values]));
  assert.deepEqual(values['Espresso Coffee'], { 'Caffeine [mg]': 126 });
  assert.deepEqual(values['Filter Coffee'], { 'Caffeine [mg]': 81.3434 });
  // Warm-Up has an empty value, the air specimens none.
  assert.equal(values['Warm-Up'], undefined);
  assert.equal(values['Neutral Air'], undefined);
});
