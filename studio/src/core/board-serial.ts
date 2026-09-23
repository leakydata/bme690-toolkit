/**
 * The ESP32-S3 logger over USB, through the browser's Web Serial API.
 * No UI here: the Live page (and anything else) listens to typed events.
 *
 * The board prints free text (boot messages, ESP-IDF log lines such as
 * "I (1234) storage: ...") mixed with machine lines, one per line:
 *
 *   D,<sensor>,<ms>,<temp_C>,<press_hPa>,<hum_pct>,<gas_ohm>,<step>,<stable>
 *   S,<status json>   F,<files json>   C,<config json>   OK   ERR <text>
 *
 * See firmware/bme690-logger-idf/API.md and main/console.c.
 */

// ------------------------------------------------------------ line parsing

/** One heater step of one sensor, as the board reports it. */
export interface BoardPoint {
  sensor: number;
  /** ms since the board powered on */
  ms: number;
  temp: number;
  press: number;
  hum: number;
  gas: number;
  step: number;
  stable: boolean;
}

export type BoardLine =
  | { kind: 'data'; point: BoardPoint }
  | { kind: 'status'; json: BoardStatus }
  | { kind: 'files'; json: { name: string; size: number }[] }
  | { kind: 'config'; json: unknown }
  | { kind: 'ok' }
  | { kind: 'err'; text: string }
  | { kind: 'log'; text: string };

/** The status object (API.md). Fields are optional because older firmware
 *  may leave some out. */
export interface BoardStatus {
  fw?: string;
  board?: string;
  uptime_ms?: number;
  time_set?: boolean;
  unix?: number;
  recording?: boolean;
  session?: string;
  file?: string;
  rows_written?: number;
  label?: { tag: number; name: string } | null;
  labels?: { tag: number; name: string; desc?: string }[];
  card?: { present: boolean; total_mb?: number; free_mb?: number; error?: string | null };
  config?: { source?: string; name?: string };
  wifi?: { ssid?: string; clients?: number };
  burnin?: { hours: number; remaining_s: number } | null;
  sensors?: BoardSensor[];
  problems?: { level: 'error' | 'warn' | 'info'; sensor: number | null; text: string }[];
}

export interface BoardSensor {
  index: number;
  part?: string;
  shuttle_pin?: string;
  gpio?: number;
  state: 'ok' | 'missing' | 'lost' | 'sleeping' | 'inactive' | (string & {});
  probe?: string;
  heater_profile?: string;
  cycle_ms?: number;
  cycles?: number;
  heat_stable_pct?: number;
  last?: { ms: number; temp: number; press: number; hum: number; gas: number; step: number; stable: boolean } | null;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Classify one line from the board. Anything unrecognised is a log line. */
export function parseLine(raw: string): BoardLine {
  const line = raw.replace(/\r/g, '').trimEnd();
  if (line.startsWith('D,')) {
    const f = line.split(',');
    if (f.length === 9) {
      const n = f.slice(1).map(Number);
      if (n.every((v) => Number.isFinite(v)) && n[6] >= 0 && n[6] < 256) {
        return {
          kind: 'data',
          point: { sensor: n[0], ms: n[1], temp: n[2], press: n[3], hum: n[4], gas: n[5], step: n[6], stable: n[7] !== 0 },
        };
      }
    }
    return { kind: 'log', text: line };
  }
  const prefix = line.slice(0, 2);
  if (prefix === 'S,' || prefix === 'F,' || prefix === 'C,') {
    const v = json(line.slice(2));
    if (prefix === 'S,' && v && typeof v === 'object' && !Array.isArray(v)) {
      return { kind: 'status', json: v as BoardStatus };
    }
    if (prefix === 'F,' && Array.isArray(v)) {
      return { kind: 'files', json: v as { name: string; size: number }[] };
    }
    if (prefix === 'C,' && v && typeof v === 'object') {
      return { kind: 'config', json: v };
    }
    return { kind: 'log', text: line };
  }
  if (line === 'OK') {
    return { kind: 'ok' };
  }
  if (line === 'ERR' || line.startsWith('ERR ')) {
    return { kind: 'err', text: line.slice(4).trim() };
  }
  return { kind: 'log', text: line };
}

/** Splits a stream of text chunks into lines on \n, tolerating \r\n and a
 *  lone \r. A partial line waits for the next chunk. */
export class LineSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split(/\r\n|\n|\r(?!$)/);
    // The last part is unfinished; a lone trailing \r may be the first
    // half of \r\n, so it waits too.
    this.buf = parts.pop() ?? '';
    if (this.buf.length > 4096) {
      // No newline for a long time: the board is printing binary noise
      // (a baud mismatch, say). Hand it out rather than grow forever.
      parts.push(this.buf);
      this.buf = '';
    }
    return parts.map((p) => p.replace(/\r$/, '')).filter((p) => p.length > 0);
  }

  /** Whatever is left when the stream ends. */
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    return rest ? [rest] : [];
  }
}

// ------------------------------------------------------------ events

type Listener<T> = (v: T) => void;

class Emitter<T> {
  private fns = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(v: T) {
    for (const fn of [...this.fns]) {
      try {
        fn(v);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

/** Everything a page needs from a board, real or simulated. */
export interface BoardLink {
  readonly connected: boolean;
  /** a human name for what we are talking to */
  readonly label: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(cmd: string): Promise<void>;
  /**
   * Send a command and wait for the reply line that starts with
   * `expectPrefix` ("S,", "C,", "F," or "OK"). Resolves with the parsed
   * line; rejects with the board's own words on "ERR ...", or on timeout.
   * Requests run one at a time so replies cannot be confused.
   */
  request(cmd: string, expectPrefix: string, timeoutMs?: number): Promise<BoardLine>;
  onData(fn: Listener<BoardPoint>): () => void;
  onStatus(fn: Listener<BoardStatus>): () => void;
  /** replies: S, F, C, OK and ERR lines, as text */
  onReply(fn: Listener<string>): () => void;
  /** free text: boot messages, log lines, help text */
  onLog(fn: Listener<string>): () => void;
  /** the connection ended; reason is plain English */
  onClose(fn: Listener<string>): () => void;
}

interface Pending {
  prefix: string;
  resolve: (l: BoardLine) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Shared plumbing: line dispatch, events and the request queue. Subclasses
 * provide the transport by implementing write() and calling feed()/closed().
 */
export abstract class BoardBase implements BoardLink {
  abstract readonly label: string;
  connected = false;
  private splitter = new LineSplitter();
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private dataEv = new Emitter<BoardPoint>();
  private statusEv = new Emitter<BoardStatus>();
  private replyEv = new Emitter<string>();
  private logEv = new Emitter<string>();
  private closeEv = new Emitter<string>();

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  protected abstract write(text: string): Promise<void>;

  onData(fn: Listener<BoardPoint>) { return this.dataEv.on(fn); }
  onStatus(fn: Listener<BoardStatus>) { return this.statusEv.on(fn); }
  onReply(fn: Listener<string>) { return this.replyEv.on(fn); }
  onLog(fn: Listener<string>) { return this.logEv.on(fn); }
  onClose(fn: Listener<string>) { return this.closeEv.on(fn); }

  async send(cmd: string): Promise<void> {
    if (!this.connected) {
      throw new Error('The board is not connected.');
    }
    // The console reads a line at a time; a plain \n ends it.
    await this.write(cmd.replace(/[\r\n]+/g, ' ').trim() + '\n');
  }

  request(cmd: string, expectPrefix: string, timeoutMs = 3000): Promise<BoardLine> {
    const run = () =>
      new Promise<BoardLine>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error(`The board did not answer "${cmd}" in time.`));
        }, timeoutMs);
        this.pending = { prefix: expectPrefix, resolve, reject, timer };
        this.send(cmd).catch((e) => {
          clearTimeout(timer);
          this.pending = null;
          reject(e);
        });
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Transport hands over raw text here. */
  protected feed(chunk: string) {
    for (const line of this.splitter.push(chunk)) {
      this.dispatch(line);
    }
  }

  protected dispatch(line: string) {
    const parsed = parseLine(line);
    switch (parsed.kind) {
      case 'data':
        this.dataEv.emit(parsed.point);
        return;
      case 'log':
        this.logEv.emit(parsed.text);
        return;
      case 'status':
        this.statusEv.emit(parsed.json);
        break;
    }
    this.replyEv.emit(line);
    const p = this.pending;
    if (!p) return;
    if (parsed.kind === 'err') {
      clearTimeout(p.timer);
      this.pending = null;
      p.reject(new Error(parsed.text || 'The board refused the command.'));
    } else if (line.startsWith(p.prefix)) {
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve(parsed);
    }
  }

  /** Transport calls this once when the link ends, for whatever reason. */
  protected closed(reason: string) {
    if (!this.connected) return;
    this.connected = false;
    for (const line of this.splitter.flush()) this.dispatch(line);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = null;
    }
    this.closeEv.emit(reason);
  }
}

// ------------------------------------------------------------ Web Serial

// Minimal typings: TypeScript's DOM library does not include Web Serial yet.
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(s: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}
interface SerialLike extends EventTarget {
  requestPort(o?: { filters?: unknown[] }): Promise<SerialPortLike>;
}

function serialApi(): SerialLike | null {
  return (typeof navigator !== 'undefined' && (navigator as unknown as { serial?: SerialLike }).serial) || null;
}

/** Is Web Serial available here (Chrome or Edge on a desktop computer)? */
export function hasWebSerial(): boolean {
  return serialApi() !== null;
}

export const BAUD = 115200;

export class BoardConnection extends BoardBase {
  label = 'USB board';
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private readDone: Promise<void> | null = null;
  private closing = false;
  private onDisconnectEvent = (e: Event) => {
    if ((e as unknown as { target: unknown }).target === this.port || (e as { port?: unknown } & Event).port === this.port) {
      this.closed('The board was unplugged.');
      void this.release();
    }
  };

  async connect(): Promise<void> {
    const serial = serialApi();
    if (!serial) {
      throw new Error('This browser cannot talk to USB boards. Use Chrome or Edge on a computer.');
    }
    // No filters: the board may enumerate through a CP210x, a CH34x or the
    // ESP32-S3's own USB, so let the person pick it from the list.
    let port: SerialPortLike;
    try {
      port = await serial.requestPort({ filters: [] });
    } catch {
      throw new Error('No board chosen. Plug the board in, press Connect and pick it from the list.');
    }
    try {
      await port.open({ baudRate: BAUD });
    } catch (e) {
      throw new Error(
        `Could not open the board (${(e as Error).message}). Close any other program using it ` +
          '(a serial monitor, the bme690 tool, another browser tab) and try again.',
      );
    }
    // ESP32 dev boards wire DTR and RTS to the chip's EN (reset) and GPIO0
    // (boot mode) pins through an "auto-reset" circuit, so the flashing tool
    // can restart the chip. Opening a port often asserts both lines, which
    // would reset the board and interrupt a recording. Release them straight
    // away. Some boards (and some USB bridges) still reset once while the
    // port opens, before we get the chance; the board then boots normally
    // and resumes, which shows up as boot messages in the console.
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      // Native USB-CDC ports may not support signals; nothing to release.
    }
    this.port = port;
    this.connected = true;
    this.closing = false;
    serial.addEventListener('disconnect', this.onDisconnectEvent);
    this.readDone = this.readLoop(port);
  }

  private async readLoop(port: SerialPortLike) {
    let reason = 'The connection to the board ended.';
    try {
      while (port.readable && !this.closing) {
        const decoder = new TextDecoderStream();
        const piped = port.readable.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => undefined);
        const reader = decoder.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) this.feed(value);
          }
        } catch (e) {
          if (!this.closing) {
            // A framing or buffer-overrun error is recoverable: loop and
            // reopen the stream. A lost device is not.
            const msg = (e as Error).message || '';
            if (/lost|disconnect|device/i.test(msg) || (e as Error).name === 'NetworkError') {
              reason = 'The board was unplugged.';
              break;
            }
          }
        } finally {
          reader.releaseLock();
          this.reader = null;
          await piped;
        }
      }
    } finally {
      if (this.closing) reason = 'Disconnected.';
      this.closed(reason);
    }
  }

  protected async write(text: string): Promise<void> {
    const w = this.port?.writable?.getWriter();
    if (!w) {
      throw new Error('The board is not connected.');
    }
    try {
      await w.write(new TextEncoder().encode(text));
    } finally {
      w.releaseLock();
    }
  }

  async disconnect(): Promise<void> {
    if (!this.port) return;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      // already gone
    }
    await this.readDone?.catch(() => undefined);
    await this.release();
    this.closed('Disconnected.');
  }

  private async release() {
    serialApi()?.removeEventListener('disconnect', this.onDisconnectEvent);
    const port = this.port;
    this.port = null;
    try {
      await port?.close();
    } catch {
      // closing an unplugged port throws; nothing left to do
    }
  }
}
