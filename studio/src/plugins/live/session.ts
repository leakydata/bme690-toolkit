/**
 * The live session: one board connection and everything that flows from it
 * (status, cycles, charts, console, capture, prediction). It lives outside
 * React so a capture keeps running while the person looks at other pages.
 * The Live view subscribes with useSyncExternalStore.
 */
import { parseConfig } from '../../core/bmerawdata.ts';
import { BoardConnection, type BoardLink, type BoardPoint, type BoardStatus } from '../../core/board-serial.ts';
import type { BoardConfig, Cycle, ModelRecord } from '../../core/types.ts';
import '../../ml/models/index.ts';
import { loadRunner, type Runner } from '../../ml/run.ts';
import { LiveAssembler, RoundCollector, combineVotes, type Answer } from './assembler.ts';
import { Capture } from './capture.ts';
import { MockBoard } from './mock-board.ts';

export const MOCK = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockboard') === '1';

const MAX_CYCLES = 1500;
const MAX_ENV = 900;
const MAX_CONSOLE = 400;
const POLL_MS = 3000;

export interface CycleRow {
  /** wall clock, unix seconds, when it completed */
  at: number;
  cycle: Cycle;
}

export interface LiveState {
  phase: 'idle' | 'connecting' | 'connected';
  isMock: boolean;
  error: string;
  /** why the last connection ended, shown until the next connect */
  closedReason: string;
  status: BoardStatus | null;
  /** the board stopped answering status requests */
  silent: boolean;
  config: BoardConfig | null;
  lastDataAt: number;
  points: number;
  capture: Capture | null;
  captureCycles: number;
  /** a finished capture waiting to be saved or thrown away */
  unsaved: { capture: Capture; cycles: number; reason: string } | null;
  model: ModelRecord | null;
  runner: Runner | null;
  modelError: string;
  modelNote: string;
  answer: Answer | null;
  history: Answer[];
  /** bumps on every change the view should see */
  version: number;
}

type Fn = () => void;

class LiveSession {
  state: LiveState = {
    phase: 'idle', isMock: MOCK, error: '', closedReason: '', status: null, silent: false, config: null,
    lastDataAt: 0, points: 0, capture: null, captureCycles: 0, unsaved: null,
    model: null, runner: null, modelError: '', modelNote: '', answer: null, history: [], version: 0,
  };
  /** completed cycles, oldest first (for the charts) */
  cycles: CycleRow[] = [];
  /** averaged environment, one row a second */
  env: { at: number; temp: number; hum: number; press: number }[] = [];
  console: string[] = [];
  private link: BoardLink | null = null;
  private subs = new Set<Fn>();
  private assembler = new LiveAssembler(null);
  private rounds = new RoundCollector(() => this.expectedSensors());
  private lastCycleAt = new Map<number, number>();
  private lastEnv = new Map<number, { temp: number; hum: number; press: number; at: number }>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private misses = 0;
  private dirty = false;
  private unsub: (() => void)[] = [];

  subscribe = (fn: Fn) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  getState = () => this.state;

  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    this.dirty = false;
    for (const fn of this.subs) fn();
  }

  /** Changes that arrive many times a second are batched into the 1 s tick. */
  private touch() {
    this.dirty = true;
  }

  private logLine(line: string) {
    this.console.push(line);
    if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE);
    this.touch();
  }

  async connect() {
    if (this.state.phase !== 'idle') return;
    const link: BoardLink = MOCK ? new MockBoard() : new BoardConnection();
    this.set({ phase: 'connecting', error: '', closedReason: '' });
    this.assembler.reset();
    this.rounds.clear();
    this.unsub = [
      link.onData((p) => this.onPoint(p)),
      link.onLog((l) => this.logLine(l)),
      link.onReply((l) => {
        if (!l.startsWith('S,') && !l.startsWith('C,')) this.logLine(l.length > 300 ? l.slice(0, 300) + '…' : l);
      }),
      link.onStatus((s) => this.onStatus(s)),
      link.onClose((why) => this.onClosed(why)),
    ];
    this.logLine(`--- connecting to the ${link.label} at ${new Date().toLocaleTimeString()} ---`);
    try {
      await link.connect();
    } catch (e) {
      this.unsub.forEach((f) => f());
      this.set({ phase: 'idle', error: (e as Error).message });
      return;
    }
    this.link = link;
    this.set({ phase: 'connected' });
    this.ticker = setInterval(() => this.tick(), 1000);
    // Set the board's clock so its files carry real dates, then ask what it
    // is and how it is configured.
    try {
      await link.request(`time ${Math.floor(Date.now() / 1000)}`, 'OK', 3000);
    } catch {
      this.logLine('(The board did not confirm the clock; its files may be dated from power-on.)');
    }
    await this.refreshStatus();
    await this.refreshConfig();
    this.poll = setInterval(() => void this.refreshStatus(), POLL_MS);
  }

  async disconnect() {
    await this.link?.disconnect();
  }

  /** For tests with the mock: pretend the cable was pulled. */
  simulateUnplug() {
    if (this.link instanceof MockBoard) this.link.unplug();
  }

  private onClosed(reason: string) {
    this.unsub.forEach((f) => f());
    this.unsub = [];
    if (this.poll) clearInterval(this.poll);
    if (this.ticker) clearInterval(this.ticker);
    this.poll = this.ticker = null;
    this.link = null;
    const patch: Partial<LiveState> = { phase: 'idle', closedReason: reason, silent: false };
    if (this.state.capture) {
      const c = this.state.capture;
      patch.capture = null;
      patch.unsaved = c.length
        ? { capture: c, cycles: this.state.captureCycles, reason: `${reason} Everything captured until then is kept.` }
        : null;
    }
    this.set(patch);
  }

  async refreshStatus() {
    if (!this.link) return;
    try {
      await this.link.request('status', 'S,', 3000);
      this.misses = 0;
      if (this.state.silent) this.set({ silent: false });
    } catch {
      this.misses++;
      if (this.misses >= 2 && !this.state.silent && this.link) this.set({ silent: true });
    }
  }

  async refreshConfig() {
    if (!this.link) return;
    try {
      const reply = await this.link.request('config', 'C,', 4000);
      if (reply.kind === 'config') {
        const cfg = parseConfig(reply.json);
        this.assembler.setConfig(cfg);
        this.set({ config: cfg });
      }
    } catch {
      this.logLine('(Could not read the heater configuration; assuming HP-354 on all sensors.)');
    }
  }

  private onStatus(s: BoardStatus) {
    const prev = this.state.status;
    this.set({ status: s });
    if (prev && (prev.config?.name !== s.config?.name || prev.config?.source !== s.config?.source)) {
      void this.refreshConfig();
    }
  }

  /** Send a command that answers OK; returns an error message or ''. */
  async command(cmd: string): Promise<string> {
    if (!this.link) return 'The board is not connected.';
    try {
      await this.link.request(cmd, 'OK', 6000);
      await this.refreshStatus();
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** A command typed into the console: sent as is, the answer shows there. */
  async raw(cmd: string) {
    if (!this.link || !cmd.trim()) return;
    this.logLine(`> ${cmd.trim()}`);
    try {
      await this.link.send(cmd);
    } catch (e) {
      this.logLine(`(${(e as Error).message})`);
    }
  }

  // ---------------------------------------------------------- data

  private onPoint(p: BoardPoint) {
    const now = Date.now();
    this.state.lastDataAt = now;
    this.state.points++;
    this.lastEnv.set(p.sensor, { temp: p.temp, hum: p.hum, press: p.press, at: now });
    if (this.state.capture) this.state.capture.add(p, now);
    const c = this.assembler.push(p);
    if (c) this.onCycle(c, now);
    this.touch();
  }

  private onCycle(c: Cycle, now: number) {
    this.cycles.push({ at: now / 1000, cycle: c });
    if (this.cycles.length > MAX_CYCLES) this.cycles.splice(0, this.cycles.length - MAX_CYCLES);
    this.lastCycleAt.set(c.sensor, now);
    if (this.state.capture) this.state.captureCycles++;
    const round = this.rounds.push(c);
    if (round && this.state.runner) this.predictRound(round, now);
  }

  /** Sensors that have delivered a cycle recently (and that the model uses). */
  private expectedSensors(): number[] {
    const now = Date.now();
    const cycleMs = Math.max(2000, ...(this.state.status?.sensors ?? []).map((s) => s.cycle_ms ?? 0)) / (MOCK ? 10 : 1);
    let recent = [...this.lastCycleAt].filter(([, t]) => now - t < cycleMs * 3).map(([s]) => s);
    const fixed = this.state.runner?.sensors;
    if (fixed) recent = recent.filter((s) => fixed.includes(s));
    return recent.sort((a, b) => a - b);
  }

  private predictRound(round: Cycle[], now: number) {
    const r = this.state.runner!;
    let answer: Answer | null = null;
    if (r.mode === 'fused') {
      const probs = r.predict(round);
      if (probs) answer = combineVotes([{ sensor: null, probs }], now);
    } else {
      const votes = round
        .map((c) => ({ sensor: c.sensor, probs: r.predict([c]) }))
        .filter((v): v is { sensor: number; probs: number[] } => v.probs !== null);
      answer = combineVotes(votes, now);
    }
    if (!answer) {
      const profile = round[0]?.heaterProfile || 'unknown';
      const want = r.model.dataset.heaterProfile;
      const note = profile !== want
        ? `This model was trained on heater profile "${want}", but the board is running "${profile}". Choose a model trained on the board's profile, or load that profile onto the board.`
        : r.mode === 'fused'
          ? `This model needs one cycle from each of sensors ${(r.sensors ?? []).join(', ') || 'it was trained on'}; waiting for all of them.`
          : 'The model could not use these cycles (it was trained on other sensors).';
      if (note !== this.state.modelNote) this.set({ modelNote: note });
      return;
    }
    const history = [...this.state.history, answer].slice(-40);
    this.set({ answer, history, modelNote: '' });
  }

  async chooseModel(m: ModelRecord | null) {
    this.rounds.clear();
    if (!m) {
      this.set({ model: null, runner: null, modelError: '', modelNote: '', answer: null, history: [] });
      return;
    }
    this.set({ model: m, runner: null, modelError: '', modelNote: 'Loading the model…', answer: null, history: [] });
    try {
      const runner = await loadRunner(m);
      if (this.state.model?.id !== m.id) return;
      this.set({ runner, modelNote: 'Waiting for the next complete cycle…' });
    } catch (e) {
      this.set({
        modelError: `Could not load this model: ${(e as Error).message}. It may have been made with a model type this version of the studio does not have.`,
        modelNote: '',
      });
    }
  }

  // ---------------------------------------------------------- capture

  startCapture(firstName: string) {
    if (this.state.capture || !this.link) return;
    this.set({ capture: new Capture(firstName), captureCycles: 0 });
  }

  nextSample(name: string) {
    this.state.capture?.next(name);
    this.set({});
  }

  renameSample(tag: number, name: string) {
    this.state.capture?.rename(tag, name);
    this.set({});
  }

  stopCapture() {
    const c = this.state.capture;
    if (!c) return;
    this.set({ capture: null, unsaved: c.length ? { capture: c, cycles: this.state.captureCycles, reason: '' } : null });
  }

  discardUnsaved() {
    this.set({ unsaved: null });
  }

  // ---------------------------------------------------------- ticking

  private tick() {
    const now = Date.now();
    const fresh = [...this.lastEnv.values()].filter((e) => now - e.at < 30_000);
    if (fresh.length) {
      const avg = (k: 'temp' | 'hum' | 'press') => fresh.reduce((a, e) => a + e[k], 0) / fresh.length;
      this.env.push({ at: now / 1000, temp: avg('temp'), hum: avg('hum'), press: avg('press') });
      if (this.env.length > MAX_ENV) this.env.splice(0, this.env.length - MAX_ENV);
      this.dirty = true;
    }
    if (this.dirty) this.set({});
  }
}

export const live = new LiveSession();
