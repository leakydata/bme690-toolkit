/**
 * Live: the board over USB. Shows how the board and its sensors are doing,
 * plots cycles as they arrive, records straight into the project with
 * labels set here, and runs a saved model on the live data.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type uPlot from 'uplot';
import { CLASS_COLORS, useStudio } from '../../app/state.tsx';
import { hasWebSerial } from '../../core/board-serial.ts';
import { fmtDuration, fmtOhm, sensorColor } from '../../ui/format.ts';
import { registerView } from '../registry.ts';
import { axis, Chart, cssVar } from './chart.tsx';
import { live } from './session.ts';
import './live.css';

function useLive() {
  return useSyncExternalStore(live.subscribe, live.getState);
}

// ------------------------------------------------------------ connection

function ConnectCard() {
  const st = useLive();
  const serial = hasWebSerial();
  const s = st.status;

  if (st.phase !== 'connected') {
    return (
      <div className="card">
        <h2>Connect the board</h2>
        {!serial && !st.isMock ? (
          <div className="notice warn">
            This browser cannot talk to USB devices. Open BME Studio in <b>Chrome</b> or <b>Edge</b> on a computer
            (not a phone or tablet) to use the board live. Everything else in the studio works here.
          </div>
        ) : (
          <>
            <p>Plug the logger into this computer with a USB cable, press <b>Connect</b> and pick it from the list
              (it is usually called "USB Serial", "CP2102", "CH340" or "USB JTAG/serial").</p>
            {st.isMock && <div className="notice info">Using a <b>simulated board</b> (<code>?mockboard=1</code>). No real
              hardware is touched.</div>}
            {st.error && <div className="notice error">{st.error}</div>}
            {st.closedReason && !st.error && <div className="notice warn">{st.closedReason}</div>}
            <div className="row">
              <button className="btn primary" disabled={st.phase === 'connecting'} onClick={() => live.connect()}>
                {st.phase === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Some boards restart once when a program connects to them. Usually that is harmless: the board carries
              on after a few seconds, and a recording on the card starts a new file. <b>But a restart ends a
              burn-in</b>, so if one is running, check on it from the board's WiFi dashboard instead.
            </p>
          </>
        )}
      </div>
    );
  }

  const sensors = s?.sensors ?? [];
  const good = sensors.filter((x) => x.state === 'ok' || x.state === 'sleeping').length;
  const active = sensors.filter((x) => x.state !== 'inactive').length;
  const problems = s?.problems ?? [];
  const since = st.lastDataAt ? (Date.now() - st.lastDataAt) / 1000 : Infinity;

  return (
    <div className="card">
      <div className="row spread">
        <div>
          <h2 style={{ marginBottom: 2 }}>{s?.board ?? 'Board'} {st.isMock && <span className="pill">simulated</span>}</h2>
          <div className="muted small">
            firmware {s?.fw ?? '…'} · heater setup: {s?.config?.name ?? '…'}
            {s?.card && (s.card.present ? ` · SD card: ${((s.card.free_mb ?? 0) / 1024).toFixed(1)} GB free` : ' · no SD card')}
          </div>
        </div>
        <button className="btn" onClick={() => live.disconnect()}>Disconnect</button>
      </div>
      <div className="live-health">
        <span className={`pill ${sensors.length && good === active ? 'ok' : good ? 'warn' : 'err'}`}>
          {sensors.length ? `${good} of ${active} sensors working` : 'checking sensors…'}
        </span>
        <span className={`pill ${since < 10 ? 'ok' : 'warn'}`}>
          {since < 10 ? 'data arriving' : st.points ? `no data for ${Math.round(since)} s` : 'waiting for data…'}
        </span>
        {s?.burnin && <span className="pill warn">burn-in: {fmtDuration(s.burnin.remaining_s * 1000)} left</span>}
      </div>
      {sensors.length > 0 && (
        <div className="live-sensors" aria-label="Sensor states">
          {sensors.map((x) => (
            <span key={x.index} className={`live-sensor ${x.state}`} title={`Sensor ${x.index}${x.part ? ` (${x.part})` : ''}: ${x.state}`}>
              <span className="swatch" style={{ background: sensorColor(x.index) }} />
              {x.index} <span className="muted">{x.state === 'ok' ? '✓' : x.state}</span>
            </span>
          ))}
        </div>
      )}
      {st.silent && <div className="notice warn">The board has stopped answering. Check the cable; if it stays like this, press
        Disconnect and connect again.</div>}
      {problems.length === 0 && sensors.length > 0 && <p className="muted small" style={{ margin: '8px 0 0' }}>The board reports no problems.</p>}
      {problems.map((p, i) => (
        <div key={i} className={`notice ${p.level === 'error' ? 'error' : p.level === 'warn' ? 'warn' : 'info'}`} style={{ margin: '8px 0 0' }}>
          {p.text}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ board controls

function BoardControls() {
  const st = useLive();
  const s = st.status;
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<'burnin' | 'stopburn' | null>(null);
  const [hours, setHours] = useState('12');
  if (st.phase !== 'connected') return null;

  const run = async (cmd: string, done: string) => {
    setBusy(cmd);
    setMsg(null);
    const err = await live.command(cmd);
    setBusy('');
    setMsg(err ? { text: err, kind: 'error' } : { text: done, kind: 'ok' });
    if (cmd.startsWith('burnin')) void live.refreshConfig();
  };

  return (
    <div className="card">
      <h2>On the board's SD card</h2>
      <p className="muted small">The board can record to its own card, independently of this computer. Recordings from
        the card can be imported on the Data page later.</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className={`pill ${s?.recording ? 'err' : ''}`}>{s?.recording ? '● recording' : 'not recording'}</span>
        {s?.recording && <span className="muted small">{s.file} · {(s.rows_written ?? 0).toLocaleString()} rows</span>}
        {s?.label && <span className="muted small">label {s.label.tag}: <b>{s.label.name}</b></span>}
      </div>
      <div className="row">
        {s?.recording ? (
          <button className="btn" disabled={!!busy} onClick={() => run('rec stop', 'Recording stopped.')}>Stop recording</button>
        ) : (
          <button className="btn" disabled={!!busy || s?.card?.present === false} onClick={() => run('rec start', 'Recording to the SD card.')}>
            Start recording
          </button>
        )}
        <button className="btn" disabled={!!busy} onClick={() => run('label next', 'Switched to the next label.')}
          title="Same as pressing the BOOT button">Next label</button>
        <button className="btn" disabled={!!busy} onClick={() => run('rescan', 'Checked all eight sensors again.')}
          title="Check all eight sensors again">Re-check sensors</button>
        {s?.burnin ? (
          <button className="btn danger" disabled={!!busy} onClick={() => setConfirm('stopburn')}>Stop burn-in</button>
        ) : (
          <button className="btn" disabled={!!busy} onClick={() => setConfirm('burnin')}>Burn in new sensors…</button>
        )}
      </div>
      {confirm === 'burnin' && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <p><b>Burn-in</b> gets factory-new sensors ready: it heats all eight at a constant 320 °C (Bosch profile HP-001)
            and records it under the label "burn-in". Bosch recommend at least 12 hours. Afterwards the board goes back to
            its normal heater setup by itself. Leave the sensors in clean air meanwhile.</p>
          <div className="row">
            <label className="field" style={{ gridAutoFlow: 'column', alignItems: 'center' }}>
              Hours <input type="number" min={0.1} max={168} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 90 }} />
            </label>
            <button className="btn primary" onClick={() => { setConfirm(null); run(`burnin ${Number(hours) || 12}`, 'Burn-in started.'); }}>Start burn-in</button>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {confirm === 'stopburn' && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <p>Stop the burn-in early? Sensors that have not finished stabilising may drift for a while.</p>
          <div className="row">
            <button className="btn primary" onClick={() => { setConfirm(null); run('burnin stop', 'Burn-in stopped.'); }}>Stop burn-in</button>
            <button className="btn" onClick={() => setConfirm(null)}>Keep going</button>
          </div>
        </div>
      )}
      {busy && <p className="muted small" style={{ marginTop: 10 }}>Waiting for the board…</p>}
      {msg && <div className={`notice ${msg.kind === 'ok' ? 'ok' : 'error'}`} style={{ margin: '10px 0 0' }}>{msg.text}</div>}
    </div>
  );
}

// ------------------------------------------------------------ charts

const WINDOWS = [{ s: 120, label: '2 min' }, { s: 600, label: '10 min' }, { s: 3600, label: '1 hour' }];

function LiveCharts() {
  const st = useLive();
  const [step, setStep] = useState(9);
  const [win, setWin] = useState(600);
  const profile = st.config?.heaterProfiles[0];
  const sensors = useMemo(() => {
    const seen = new Set(live.cycles.map((r) => r.cycle.sensor));
    return [...seen].sort((a, b) => a - b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.version]);
  const sensorKey = sensors.join(',');

  const gasData = useMemo<uPlot.AlignedData>(() => {
    const from = Date.now() / 1000 - win;
    const rows = live.cycles.filter((r) => r.at >= from);
    const x = rows.map((r) => r.at);
    const ys = sensors.map((s) => rows.map((r) => (r.cycle.sensor === s ? r.cycle.gas[step] : null)));
    return [x, ...ys] as uPlot.AlignedData;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.version, step, win, sensorKey]);

  const envData = useMemo<uPlot.AlignedData>(() => {
    const from = Date.now() / 1000 - win;
    const rows = live.env.filter((r) => r.at >= from);
    return [rows.map((r) => r.at), rows.map((r) => r.temp), rows.map((r) => r.hum)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.version, win]);

  if (st.phase !== 'connected' && live.cycles.length === 0) return null;

  const latest = new Map<number, number>();
  for (const r of live.cycles) latest.set(r.cycle.sensor, r.cycle.gas[step]);
  const lastEnv = live.env[live.env.length - 1];

  return (
    <div className="card">
      <div className="row spread">
        <h2>Live readings</h2>
        <div className="row">
          <label className="field live-inline">Heater step
            <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => (
                <option key={i} value={i}>{i + 1}{profile ? ` (${profile.steps[i]?.[0]} °C)` : ''}</option>
              ))}
            </select>
          </label>
          <label className="field live-inline">Show
            <select value={win} onChange={(e) => setWin(Number(e.target.value))}>
              {WINDOWS.map((w) => <option key={w.s} value={w.s}>last {w.label}</option>)}
            </select>
          </label>
        </div>
      </div>
      <p className="muted small">Gas resistance of every sensor at one heater step, once per complete cycle (log scale). Lower
        resistance usually means more gas.</p>
      {live.cycles.length === 0 ? (
        <p className="empty">Waiting for the first complete heater cycle… (about {profile ? Math.round(profile.steps.reduce((a, s) => a + s[1], 0) * profile.timeBase / 1000) : 11} s{st.isMock ? ', faster when simulated' : ''})</p>
      ) : (
        <Chart
          label={`Gas resistance at heater step ${step + 1}, per sensor`}
          optionsKey={`gas-${sensorKey}`}
          data={gasData}
          height={260}
          options={() => ({
            scales: { x: { time: true }, y: { distr: 3 } },
            axes: [axis(), axis({ values: (_u, v) => v.map((x) => (x == null ? '' : fmtOhm(x))), size: 70 })],
            series: [
              {},
              ...sensors.map((s) => ({
                label: `sensor ${s}`,
                stroke: sensorColor(s),
                width: 1.6,
                spanGaps: true,
                points: { show: false },
                value: (_u: uPlot, v: number | null) => (v == null ? '–' : fmtOhm(v)),
              })),
            ],
            legend: { live: true },
            cursor: { drag: { x: false, y: false } },
          })}
        />
      )}
      <div className="live-latest">
        {[...latest].sort((a, b) => a[0] - b[0]).map(([s, g]) => (
          <span key={s}><span className="swatch" style={{ background: sensorColor(s) }} />{s}: <b className="num">{fmtOhm(g)}</b></span>
        ))}
      </div>
      {live.env.length > 1 && (
        <>
          <h3 style={{ marginTop: 14 }}>
            Temperature and humidity
            {lastEnv && <span className="muted small" style={{ fontWeight: 400 }}> · now {lastEnv.temp.toFixed(1)} °C, {lastEnv.hum.toFixed(1)} %RH, {lastEnv.press.toFixed(1)} hPa</span>}
          </h3>
          <Chart
            label="Temperature and relative humidity, averaged over the sensors"
            optionsKey="env"
            data={envData}
            height={180}
            options={() => ({
              scales: { x: { time: true }, C: { auto: true }, RH: { auto: true } },
              axes: [
                axis(),
                axis({ scale: 'C', values: (_u, v) => v.map((x) => (x == null ? '' : `${x.toFixed(1)} °C`)), size: 64 }),
                axis({ scale: 'RH', side: 1, grid: { show: false }, values: (_u, v) => v.map((x) => (x == null ? '' : `${x.toFixed(1)} %`)), size: 56 }),
              ],
              series: [
                {},
                { label: 'temperature', scale: 'C', stroke: cssVar('--s6'), width: 1.6, points: { show: false }, value: (_u: uPlot, v: number | null) => (v == null ? '–' : `${v.toFixed(2)} °C`) },
                { label: 'humidity', scale: 'RH', stroke: cssVar('--s0'), width: 1.6, points: { show: false }, value: (_u: uPlot, v: number | null) => (v == null ? '–' : `${v.toFixed(1)} %RH`) },
              ],
              cursor: { drag: { x: false, y: false } },
            })}
          />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ prediction

function Prediction() {
  const s = useStudio();
  const st = useLive();
  const [threshold, setThreshold] = useState(0.6);
  const models = s.project?.models ?? [];
  if (st.phase !== 'connected' && !st.model) return null;

  const colorOf = (label: string) => s.project?.classes.find((c) => c.name === label)?.color ?? cssVar('--muted');
  const a = st.answer;
  const labels = st.model?.labels ?? [];
  const sure = a && a.confidence >= threshold;
  const stale = a && Date.now() - a.at > 60_000;

  return (
    <div className="card">
      <h2>What does it smell?</h2>
      {models.length === 0 ? (
        <p className="muted">No trained models in this project yet. Record some samples below, sort them into classes on the
          Data page, then train a model on the Train page. It will show up here.</p>
      ) : (
        <>
          <div className="row">
            <label className="field live-model" style={{ flex: "1 1 240px" }}>Model
              <select value={st.model?.id ?? ''} onChange={(e) => live.chooseModel(models.find((m) => m.id === e.target.value) ?? null)}>
                <option value="">— choose a trained model —</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.dataset.mode === 'fused' ? 'all sensors together' : 'each sensor votes'})</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: '1 1 200px' }}>
              Say "not sure" below {Math.round(threshold * 100)} % confidence
              <input type="range" min={0.3} max={0.95} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            </label>
          </div>
          {st.modelError && <div className="notice error" style={{ marginTop: 10 }}>{st.modelError}</div>}
          {st.model && !st.modelError && (
            <div className={`live-answer${stale ? ' stale' : ''}`} aria-live="polite">
              {a ? (
                <>
                  <div className="live-answer-label" style={{ color: sure ? colorOf(labels[a.label]) : undefined }}>
                    {sure ? labels[a.label] : 'Not sure'}
                  </div>
                  <div className="muted">
                    {sure ? `${Math.round(a.confidence * 100)} % confident` : `best guess: ${labels[a.label]} (${Math.round(a.confidence * 100)} %)`}
                    {a.voters > 1 && ` · ${a.agree} of ${a.voters} sensors agree`}
                    {stale && ' · no new cycles for a while'}
                  </div>
                </>
              ) : (
                <div className="muted">{st.modelNote || 'Waiting for data…'}</div>
              )}
            </div>
          )}
          {a && st.modelNote && <p className="muted small">{st.modelNote}</p>}
          {st.history.length > 0 && (
            <div className="live-history" aria-label="Recent answers, oldest first">
              {st.history.slice(-24).map((h, i) => {
                const ok = h.confidence >= threshold;
                return (
                  <span key={i} className="live-chip" title={`${labels[h.label]} ${Math.round(h.confidence * 100)} % at ${new Date(h.at).toLocaleTimeString()}`}
                    style={ok ? { background: colorOf(labels[h.label]), color: '#fff' } : undefined}>
                    {ok ? labels[h.label] : '?'}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ capture

function defaultName() {
  const d = new Date();
  return `Live ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function CaptureCard() {
  const s = useStudio();
  const st = useLive();
  const [first, setFirst] = useState('');
  const [nextName, setNextName] = useState('');
  const [recName, setRecName] = useState(defaultName);
  const [asClasses, setAsClasses] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const cap = st.capture;
  const unsaved = st.unsaved;

  // Warn before closing the tab with a capture not yet saved.
  useEffect(() => {
    if (!cap && !unsaved) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener('beforeunload', on);
    return () => removeEventListener('beforeunload', on);
  }, [cap, unsaved]);

  const save = async () => {
    if (!unsaved) return;
    setSaving(true);
    try {
      const { recording, classes } = unsaved.capture.toRecording({
        name: recName.trim() || defaultName(),
        config: st.config,
        boardId: st.status?.board ?? '',
        firmware: st.status?.fw ? `bme690-logger-idf ${st.status.fw}` : '',
        classes: asClasses,
      });
      const have = s.project?.classes.length ?? 0;
      classes.forEach((c, i) => (c.color = CLASS_COLORS[(have + i) % CLASS_COLORS.length]));
      await s.addRecordings([recording], classes);
      s.toast(`Saved "${recording.name}": ${recording.specimens.length} sample(s), ${recording.cycles.length.toLocaleString()} complete cycles.`);
      live.discardUnsaved();
      setRecName(defaultName());
    } catch (e) {
      s.toast(`Could not save the capture: ${(e as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (unsaved) {
    const c = unsaved.capture;
    return (
      <div className="card">
        <h2>Save the capture</h2>
        {unsaved.reason && <div className="notice warn">{unsaved.reason}</div>}
        <p>{fmtDuration(c.duration)} of data, {c.length.toLocaleString()} readings, about {unsaved.cycles} complete cycles,
          in {c.labels.size} sample{c.labels.size === 1 ? '' : 's'}: {[...c.names().values()].join(', ')}.</p>
        <div className="row" style={{ alignItems: 'end' }}>
          <label className="field" style={{ flex: '1 1 240px' }}>Recording name
            <input value={recName} onChange={(e) => setRecName(e.target.value)} />
          </label>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={asClasses} onChange={(e) => setAsClasses(e.target.checked)} />
            Sort samples into classes by name
          </label>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={saving || !s.project} onClick={save}>{saving ? 'Saving…' : 'Save to project'}</button>
          {confirmDiscard ? (
            <>
              <span className="small">Throw this capture away?</span>
              <button className="btn danger" onClick={() => { live.discardUnsaved(); setConfirmDiscard(false); }}>Yes, discard</button>
              <button className="btn" onClick={() => setConfirmDiscard(false)}>No</button>
            </>
          ) : (
            <button className="btn danger" onClick={() => setConfirmDiscard(true)}>Discard</button>
          )}
        </div>
      </div>
    );
  }

  if (st.phase !== 'connected') return null;

  if (!cap) {
    return (
      <div className="card">
        <h2>Record into this project</h2>
        <p className="muted small">Capture what the board measures straight into this project, labelling samples as you go —
          no SD card needed. Give the first sample a name (what the sensors are smelling), start, and press "Next sample"
          each time you change what is in front of the sensors.</p>
        <form className="row" style={{ alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); live.startCapture(first); setFirst(''); }}>
          <label className="field" style={{ flex: '1 1 220px' }}>First sample
            <input value={first} onChange={(e) => setFirst(e.target.value)} placeholder="e.g. clean air" />
          </label>
          <button className="btn primary">Start capture</button>
        </form>
      </div>
    );
  }

  const samples = [...cap.names()];
  return (
    <div className="card live-capturing">
      <div className="row spread">
        <h2><span className="live-dot" aria-hidden /> Capturing</h2>
        <button className="btn" onClick={() => live.stopCapture()}>Stop capture</button>
      </div>
      <p className="num">{fmtDuration(cap.duration)} · {cap.length.toLocaleString()} readings · {st.captureCycles} complete cycles</p>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="muted small">Now:</span>
        <input aria-label="Name of the current sample" value={cap.labels.get(cap.tag) ?? ''}
          onChange={(e) => live.renameSample(cap.tag, e.target.value)} style={{ fontWeight: 600 }} />
        <span className="pill">sample {cap.tag}</span>
      </div>
      <form className="row" style={{ alignItems: 'end' }} onSubmit={(e) => { e.preventDefault(); live.nextSample(nextName); setNextName(''); }}>
        <label className="field" style={{ flex: '1 1 220px' }}>Next sample
          <input value={nextName} onChange={(e) => setNextName(e.target.value)} placeholder={`sample ${cap.tag + 1}`} />
        </label>
        <button className="btn primary">Next sample</button>
      </form>
      {samples.length > 1 && (
        <p className="muted small" style={{ marginTop: 10 }}>Samples so far: {samples.map(([t, n]) => `${t}. ${n}`).join(' · ')}</p>
      )}
      <p className="muted small">Samples captured here are labelled on this computer only; the board's own label (for its SD
        card) is separate.</p>
    </div>
  );
}

// ------------------------------------------------------------ console

function ConsoleCard() {
  const st = useLive();
  const [cmd, setCmd] = useState('');
  const [open, setOpen] = useState(false);
  if (st.phase !== 'connected' && live.console.length === 0) return null;
  return (
    <details className="card live-console" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><b>Board messages</b> <span className="muted small">({live.console.length}) — for troubleshooting</span></summary>
      {open && (
        <>
          <pre className="live-log" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
            {live.console.slice(-300).join('\n') || '(nothing yet)'}
          </pre>
          {st.phase === 'connected' && (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void live.raw(cmd); setCmd(''); }}>
              <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="Type a command, e.g. help" aria-label="Command" style={{ flex: 1, fontFamily: 'var(--mono)' }} />
              <button className="btn">Send</button>
            </form>
          )}
        </>
      )}
    </details>
  );
}

// ------------------------------------------------------------ page

function Live() {
  return (
    <>
      <div className="pagehead">
        <h1>Live</h1>
        <p>Watch the board over USB, record labelled samples straight into this project, and see what a trained model
          makes of the air right now.</p>
      </div>
      <ConnectCard />
      <CaptureCard />
      <Prediction />
      <LiveCharts />
      <BoardControls />
      <ConsoleCard />
    </>
  );
}

registerView({ id: 'live', title: 'Live', hint: 'Board over USB', order: 40, needsProject: true, component: Live });
