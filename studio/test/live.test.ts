import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardBase, LineSplitter, parseLine, type BoardPoint } from '../src/core/board-serial.ts';
import { buildCycles, buildSpecimens, emptyPoints } from '../src/core/assemble.ts';
import { LiveAssembler, RoundCollector, combineVotes } from '../src/plugins/live/assembler.ts';
import { Capture, defaultConfig } from '../src/plugins/live/capture.ts';

test('parses data lines exactly as the firmware prints them', () => {
  const l = parseLine('D,3,123000,31.2000,1012.6000,35.6000,71628.40,7,1\r');
  assert.equal(l.kind, 'data');
  assert.deepEqual(l.kind === 'data' && l.point, {
    sensor: 3, ms: 123000, temp: 31.2, press: 1012.6, hum: 35.6, gas: 71628.4, step: 7, stable: true,
  });
  const u = parseLine('D,0,5,1,2,3,4,0,0');
  assert.equal(u.kind === 'data' && u.point.stable, false);
});

test('classifies replies, and treats anything odd as a log line', () => {
  assert.equal(parseLine('OK').kind, 'ok');
  assert.deepEqual(parseLine('ERR A burn-in is running.'), { kind: 'err', text: 'A burn-in is running.' });
  const s = parseLine('S,{"fw":"2.0.0","sensors":[],"problems":[]}');
  assert.equal(s.kind, 'status');
  assert.equal(s.kind === 'status' && s.json.fw, '2.0.0');
  assert.equal(parseLine('F,[{"name":"s0001_0000.bmerawdata","size":12}]').kind, 'files');
  assert.equal(parseLine('C,{"configHeader":{},"configBody":{}}').kind, 'config');
  // ESP-IDF log lines, boot text, help text, truncated or garbled machine lines
  for (const line of ['I (1234) storage: card mounted', 'ESP-ROM:esp32s3-20210327', 'commands:', '  status   board',
    'D,1,2,3', 'D,1,2,3,4,5,x,7,1', 'S,{"fw":', 'OKAY', 'Dropped']) {
    assert.equal(parseLine(line).kind, 'log', line);
  }
});

test('splits a byte stream into lines across chunk boundaries and line endings', () => {
  const sp = new LineSplitter();
  const out: string[] = [];
  for (const chunk of ['D,0,1,2,3', ',4,5,0,1\r', '\nOK\r\nI (5) x\n', 'ERR no\rpartial']) {
    out.push(...sp.push(chunk));
  }
  assert.deepEqual(out, ['D,0,1,2,3,4,5,0,1', 'OK', 'I (5) x', 'ERR no']);
  assert.deepEqual(sp.flush(), ['partial']);
});

class FakeLink extends BoardBase {
  label = 'fake';
  sent: string[] = [];
  async connect() { this.connected = true; }
  async disconnect() { this.closed('Disconnected.'); }
  protected async write(t: string) { this.sent.push(t); }
  inject(t: string) { this.feed(t); }
}

test('requests wait for their own reply and surface the board\'s errors', async () => {
  const b = new FakeLink();
  await b.connect();
  const data: BoardPoint[] = [];
  const logs: string[] = [];
  b.onData((p) => data.push(p));
  b.onLog((l) => logs.push(l));
  const st = b.request('status', 'S,', 500);
  await Promise.resolve();
  b.inject('D,0,1,2,3,4,5,0,1\nI (9) boot\nS,{"fw":"x"}\n');
  const r = await st;
  assert.equal(r.kind === 'status' && r.json.fw, 'x');
  assert.equal(data.length, 1);
  assert.deepEqual(logs, ['I (9) boot']);
  assert.deepEqual(b.sent, ['status\n']);

  const rec = b.request('rec start', 'OK', 500);
  await Promise.resolve();
  b.inject('ERR The SD card is missing.\n');
  await assert.rejects(rec, /SD card is missing/);

  const t = b.request('config', 'C,', 30);
  await assert.rejects(t, /did not answer/);

  const pending = b.request('files', 'F,', 500);
  await Promise.resolve();
  await b.disconnect();
  await assert.rejects(pending, /Disconnected/);
});

function pt(sensor: number, ms: number, step: number, gas = 1000 + step): BoardPoint {
  return { sensor, ms, temp: 30, press: 1000, hum: 40, gas, step, stable: true };
}

test('live assembly yields a cycle as soon as all ten steps are in', () => {
  const a = new LiveAssembler(defaultConfig());
  const got = [];
  for (let s = 0; s < 10; s++) {
    const c = a.push(pt(2, 100 * s, s));
    if (s < 9) assert.equal(c, null);
    else got.push(c);
  }
  assert.equal(got.length, 1);
  assert.equal(got[0]!.sensor, 2);
  assert.equal(got[0]!.heaterProfile, 'heater_354');
  assert.deepEqual(got[0]!.gas, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009]);
  assert.equal(got[0]!.start, 0);
  assert.equal(got[0]!.end, 900);
});

test('live assembly drops broken cycles and keeps sensors apart, like the importer', () => {
  const a = new LiveAssembler(defaultConfig());
  const seq: BoardPoint[] = [];
  let ms = 0;
  // sensor 0: steps 0-4, then a restart at 0 (dropped), then a full cycle
  for (const s of [0, 1, 2, 3, 4]) seq.push(pt(0, ms += 10, s));
  // sensor 1 interleaved: a full cycle with step 5 missing then repeated step (dropped)
  for (const s of [0, 1, 2, 3, 4, 6, 7, 8, 9]) seq.push(pt(1, ms += 10, s));
  for (let s = 0; s < 10; s++) {
    seq.push(pt(0, ms += 10, s));
    seq.push(pt(1, ms += 10, s));
  }
  const live = seq.map((p) => a.push(p)).filter((c) => c !== null);
  assert.deepEqual(live.map((c) => c!.sensor).sort(), [0, 1]);
  assert.equal(a.dropped, 2);

  // The saved recording agrees with the live count.
  const points = emptyPoints(seq.length);
  seq.forEach((p, i) => {
    points.sensor[i] = p.sensor; points.t[i] = p.ms; points.gas[i] = p.gas; points.step[i] = p.step;
  });
  const { cycles, dropped } = buildCycles(points, defaultConfig(), buildSpecimens(points, new Map()));
  assert.equal(cycles.length, 2);
  assert.equal(dropped, 2);
});

test('sensors vote; confidence falls when they disagree', () => {
  const a = combineVotes([
    { sensor: 0, probs: [0.9, 0.1] },
    { sensor: 1, probs: [0.8, 0.2] },
    { sensor: 2, probs: [0.3, 0.7] },
  ], 0)!;
  assert.equal(a.label, 0);
  assert.equal(a.agree, 2);
  assert.equal(a.voters, 3);
  assert.ok(Math.abs(a.confidence - (0.9 + 0.8 + 0.3) / 3) < 1e-9);
  assert.equal(combineVotes([]), null);
});

test('rounds close when every expected sensor has a cycle, or one comes round again', () => {
  const r = new RoundCollector(() => [0, 1, 2]);
  const cyc = (sensor: number) => ({ sensor, start: 0, end: 0, heaterProfile: 'h', gas: [], temp: 0, hum: 0, press: 0, specimen: 0 });
  assert.equal(r.push(cyc(0)), null);
  assert.equal(r.push(cyc(1)), null);
  assert.deepEqual(r.push(cyc(2))!.map((c) => c.sensor), [0, 1, 2]);
  assert.equal(r.push(cyc(0)), null);
  // sensor 0 again before 1 and 2: round closes with what it has
  assert.deepEqual(r.push(cyc(0))!.map((c) => c.sensor), [0]);
});

test('a capture becomes a recording with one specimen per sample and complete cycles', () => {
  const cap = new Capture('clean air', 1_000_000);
  let ms = 50_000;
  const feed = (cycles: number) => {
    for (let k = 0; k < cycles; k++) {
      for (let s = 0; s < 10; s++) {
        for (let sensor = 0; sensor < 8; sensor++) cap.add(pt(sensor, ms + sensor, s), 1_000_000 + ms);
        ms += 100;
      }
    }
  };
  feed(3);
  cap.next('coffee');
  feed(2);
  cap.next('');
  // board restarts: its clock goes back to zero
  ms = 10; // well below where it was
  feed(1);
  const { recording, classes } = cap.toRecording({ name: 'test', config: null, boardId: 'B', firmware: 'f', classes: true });
  assert.deepEqual(recording.specimens.map((s) => s.name), ['clean air', 'coffee', 'sample 3']);
  assert.equal(recording.cycles.length, 6 * 8);
  assert.equal(recording.droppedCycles, 0);
  assert.equal(recording.points.length, 6 * 80);
  assert.equal(recording.points.t[0], 0);
  for (let i = 1; i < recording.points.length; i++) {
    assert.ok(recording.points.t[i] >= recording.points.t[i - 1] - 10, 'time keeps going forward');
  }
  assert.deepEqual(classes.map((c) => c.name), ['clean air', 'coffee', 'sample 3']);
  assert.ok(recording.specimens.every((s) => classes.some((c) => c.id === s.classId)));
  const byClass = recording.cycles.map((c) => recording.specimens[c.specimen].name);
  assert.equal(byClass.filter((n) => n === 'clean air').length, 24);
});
