/**
 * A pretend board for development and testing, enabled with ?mockboard=1.
 * It prints what the real logger prints: boot text, D lines for eight
 * sensors on HP-354, and S/C/OK/ERR replies to commands -- ten times faster
 * than real life so cycles arrive quickly.
 *
 * What it "smells" follows the board's label: odd label numbers are clean
 * air, even ones a coffee-like odour (lower resistance, strongest at the
 * cool steps), so a test can label two samples and train on them.
 */
import { BoardBase, type BoardStatus } from '../../core/board-serial.ts';
import { configToJson } from '../../core/bmerawdata.ts';
import { defaultConfig } from './capture.ts';

const TIME_BASE = 140;
const TEMPS = [320, 100, 100, 100, 200, 200, 200, 320, 320, 320];
const DURS = [5, 2, 10, 30, 5, 5, 5, 5, 5, 5];
const CYCLE_MS = DURS.reduce((a, b) => a + b, 0) * TIME_BASE;
const SPEED = 10;
const TICK_MS = 50;

/** Deterministic noise so runs are comparable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export class MockBoard extends BoardBase {
  label = 'simulated board';
  private timer: ReturnType<typeof setInterval> | null = null;
  private simMs = 0;
  private bootMs = 2000;
  /** per sensor: index of the next step and when it ends */
  private next: { step: number; endsAt: number }[] = [];
  private rand = rng(690);
  private offsets = Array.from({ length: 8 }, (_, i) => 0.55 + ((i * 37) % 11) / 10);
  private recording = false;
  private session = 0;
  private rows = 0;
  private tag = 1;
  private labels = new Map<number, string>([[1, 'sample 1']]);
  private burnin: { hours: number; endsAt: number } | null = null;
  private unix = 0;
  private unixAt = 0;
  /** sensor 5 goes quiet now and then, to exercise the problems list */
  private flaky = 5;

  async connect(): Promise<void> {
    this.connected = true;
    this.simMs = this.bootMs;
    this.next = Array.from({ length: 8 }, (_, i) => ({ step: 0, endsAt: this.simMs + DURS[0] * TIME_BASE + i * 37 }));
    this.out('ESP-ROM:esp32s3-20210327\r\nBuild:Mar 27 2021\r\n');
    this.out('I (312) app: bme690-logger-idf 2.0.0 (simulated)\r\n');
    this.out('I (845) sensors: 8 of 8 sensors answered\r\n');
    this.out('I (901) storage: card mounted: 13859 MB free of 14893 MB\r\n');
    this.out('I (955) net: access point BME690-M0CK up\r\n');
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async disconnect(): Promise<void> {
    this.stop();
    this.closed('Disconnected.');
  }

  /** Pretend the cable was pulled. */
  unplug() {
    this.stop();
    this.closed('The board was unplugged.');
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private out(text: string) {
    // Deliver asynchronously and sometimes split mid-line, like a serial port.
    const cut = Math.floor(this.rand() * text.length);
    queueMicrotask(() => {
      if (!this.connected) return;
      this.feed(text.slice(0, cut));
      this.feed(text.slice(cut));
    });
  }

  private gas(sensor: number, temp: number, t: number): number {
    // log10 R falls with heater temperature: ~40 kOhm at 320 C, a few MOhm at 100 C.
    let logR = 4.6 + ((320 - temp) / 220) * 1.85;
    logR += Math.log10(this.offsets[sensor]);
    logR += 0.05 * Math.sin(t / 600_000 + sensor); // slow drift
    if (this.tag % 2 === 0) {
      // "coffee": reducing gases pull resistance down, most at cool steps
      logR -= 0.25 + 0.35 * ((320 - temp) / 220) + 0.03 * sensor;
    }
    logR += (this.rand() - 0.5) * 0.02;
    return 10 ** logR;
  }

  private tick() {
    this.simMs += TICK_MS * SPEED;
    const env = {
      temp: 31 + 0.3 * Math.sin(this.simMs / 300_000),
      hum: 35 + 1.5 * Math.sin(this.simMs / 500_000 + 1),
      press: 1012.6 + 0.2 * Math.sin(this.simMs / 900_000),
    };
    let text = '';
    for (let s = 0; s < 8; s++) {
      const n = this.next[s];
      while (n.endsAt <= this.simMs) {
        const quiet = s === this.flaky && Math.floor(this.simMs / 90_000) % 4 === 3;
        if (!quiet) {
          const temp = env.temp + s * 0.12 + (this.rand() - 0.5) * 0.05;
          const gas = this.gas(s, TEMPS[n.step], n.endsAt);
          text += `D,${s},${n.endsAt},${temp.toFixed(4)},${(env.press + s * 0.01).toFixed(4)},${(env.hum - s * 0.2).toFixed(4)},${gas.toFixed(2)},${n.step},1\n`;
          if (this.recording) this.rows++;
        }
        n.step = (n.step + 1) % 10;
        n.endsAt += DURS[n.step] * TIME_BASE;
      }
    }
    if (this.rand() < 0.004) {
      text += `I (${this.simMs}) storage: ${this.recording ? `wrote ${this.rows} rows` : 'idle'}\n`;
    }
    if (this.burnin && this.simMs >= this.burnin.endsAt) {
      this.burnin = null;
      text += `I (${this.simMs}) app: burn-in finished; back to the previous configuration\n`;
    }
    if (text) this.out(text);
  }

  private statusJson(): BoardStatus {
    const now = this.simMs;
    const flakyQuiet = Math.floor(now / 90_000) % 4 === 3;
    const sensors = Array.from({ length: 8 }, (_, i) => ({
      index: i,
      part: `U${i + 1}`,
      shuttle_pin: `P${i < 4 ? 1 : 2}-${(i % 4) + 4}`,
      gpio: [1, 2, 4, 5, 6, 7, 15, 16][i],
      state: i === this.flaky && flakyQuiet ? 'lost' : 'ok',
      probe: 'ok',
      heater_profile: this.burnin ? 'heater_stab' : 'heater_354',
      cycle_ms: CYCLE_MS,
      cycles: Math.floor(now / CYCLE_MS),
      heat_stable_pct: 99.5,
      last: { ms: now, temp: 31.2, press: 1012.6, hum: 35.4, gas: this.gas(i, 320, now), step: 0, stable: true },
    }));
    const problems: BoardStatus['problems'] = [];
    if (flakyQuiet) {
      problems.push({ level: 'error', sensor: this.flaky, text: `Sensor ${this.flaky} (U${this.flaky + 1}) stopped answering. Check the wire from shuttle P2-5 to GPIO7; it resumes by itself when the connection returns.` });
    }
    if (!this.unix) {
      problems.push({ level: 'info', sensor: null, text: 'The clock is not set, so files are dated from power-on. Connecting from the dashboard or the studio sets it.' });
    }
    return {
      fw: '2.0.0-sim',
      board: 'BME690-M0CK',
      uptime_ms: now,
      time_set: this.unix > 0,
      unix: this.unix ? this.unix + Math.round((Date.now() - this.unixAt) / 1000) : Math.round(now / 1000),
      recording: this.recording,
      session: this.session ? `s${String(this.session).padStart(4, '0')}` : '',
      file: this.recording ? `s${String(this.session).padStart(4, '0')}_0000.bmerawdata` : '',
      rows_written: this.rows,
      label: { tag: this.tag, name: this.labels.get(this.tag) ?? `sample ${this.tag}` },
      labels: [...this.labels].map(([tag, name]) => ({ tag, name, desc: '' })),
      card: { present: true, total_mb: 14893, free_mb: 13859, error: null },
      config: this.burnin ? { source: 'burn-in', name: 'Burn-in: HP-001, 320 C constant' } : { source: 'default', name: 'HP-354, continuous (factory default)' },
      wifi: { ssid: 'BME690-M0CK', clients: 0 },
      burnin: this.burnin ? { hours: this.burnin.hours, remaining_s: Math.max(0, Math.round((this.burnin.endsAt - now) / 1000)) } : null,
      sensors,
      problems,
    };
  }

  protected async write(text: string): Promise<void> {
    if (!this.connected) throw new Error('The board is not connected.');
    for (const line of text.split('\n')) {
      if (line.trim()) setTimeout(() => this.run(line.trim()), 20 + this.rand() * 60);
    }
  }

  private run(line: string) {
    if (!this.connected) return;
    const [cmd, arg, ...rest] = line.split(/\s+/);
    const ok = () => this.out('OK\n');
    const err = (t: string) => this.out(`ERR ${t}\n`);
    switch (cmd) {
      case 'status':
        this.out(`S,${JSON.stringify(this.statusJson())}\n`);
        return;
      case 'config': {
        const cfg = defaultConfig();
        if (this.burnin) {
          cfg.boardMode = 'sensor_stabilization';
          cfg.heaterProfiles = [{ id: 'heater_stab', timeBase: 140, steps: Array.from({ length: 10 }, () => [320, 255] as [number, number]) }];
          cfg.sensors.forEach((x) => (x.heaterProfile = 'heater_stab'));
        }
        const c = configToJson(cfg, new Date().toISOString());
        c.configHeader.appVersion = 'bme690-logger-idf 2.0.0';
        this.out(`C,${JSON.stringify(c)}\n`);
        return;
      }
      case 'files':
        this.out(`F,${JSON.stringify(Array.from({ length: this.session }, (_, i) => ({ name: `s${String(i + 1).padStart(4, '0')}_0000.bmerawdata`, size: 123456 })))}\n`);
        return;
      case 'rescan':
        this.out('I (0) sensors: rescanning\n8 of 8 sensors answered\n');
        ok();
        return;
      case 'time':
        if (!arg || !Number.isFinite(Number(arg))) return err('expected seconds since 1970');
        this.unix = Number(arg);
        this.unixAt = Date.now();
        return ok();
      case 'rec':
        if (arg === 'start') {
          if (!this.recording) {
            this.session++;
            this.rows = 0;
          }
          this.recording = true;
          return ok();
        }
        if (arg === 'stop') {
          this.recording = false;
          return ok();
        }
        break;
      case 'label':
        if (arg === 'next') {
          this.tag++;
          if (!this.labels.has(this.tag)) this.labels.set(this.tag, `sample ${this.tag}`);
          return ok();
        }
        if (arg) {
          const n = Number(arg);
          if (!(n >= 1 && n <= 65535)) return err('Label numbers run from 1 to 65535.');
          this.tag = n;
          this.labels.set(n, rest.join(' ') || this.labels.get(n) || `sample ${n}`);
          return ok();
        }
        break;
      case 'burnin':
        if (arg === 'stop') {
          this.burnin = null;
          return ok();
        }
        if (arg) {
          const h = Number(arg);
          if (this.burnin) return err('A burn-in is already running.');
          if (!(h >= 0.1 && h <= 168)) return err('Choose between 0.1 and 168 hours; Bosch recommend at least 12.');
          this.burnin = { hours: h, endsAt: this.simMs + h * 3_600_000 };
          return ok();
        }
        break;
    }
    this.out('commands:\n  status             board, sensor and card status as JSON\n  rec start|stop     start or stop recording to the SD card\n');
  }
}
