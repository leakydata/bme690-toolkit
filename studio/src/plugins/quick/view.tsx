/**
 * Quick experiment: the guided path for a first project or a science fair.
 * Pick what to tell apart, follow the prompts while the board records, and
 * get a plain answer -- then watch the model guess live.
 *
 * Everything here reuses the full pages' machinery: the Live page's
 * connection and capture, and the Train page's pipeline.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CLASS_COLORS, useStudio } from '../../app/state.tsx';
import { newId } from '../../core/ids.ts';
import { listRecordings } from '../../core/store.ts';
import type { ModelRecord, SpecimenClass } from '../../core/types.ts';
import { summarize } from '../../ml/metrics.ts';
import { getModelKind, type ParamValue } from '../../ml/models.ts';
import { fmtDuration } from '../../ui/format.ts';
import { live } from '../live/session.ts';
import { toRecord, trainAndEvaluate, type TrainOutcome } from '../train/pipeline.ts';
import { registerView } from '../registry.ts';
import {
  boschPlan, classOfLabel, defaultPlan, honestyNote, planProblem, schedule, SETTLE_LABEL, TEMPLATES, totalSeconds,
  type Block, type ExperimentPlan,
} from './plan.ts';
import './quick.css';

type Step = 'choose' | 'setup' | 'record' | 'results' | 'test';
const STEP_NAMES: Record<Step, string> = {
  choose: '1. Choose', setup: '2. Connect', record: '3. Record', results: '4. Result', test: '5. Try it',
};
// Readings drift after power-on while the sensors and the board heat up.
// Bosch's own demo project leaves its first 15 minutes out as "Warm-Up".
const WARMUP_MS = 15 * 60 * 1000;
const NOT_SURE = 0.7;

function useLive() {
  return useSyncExternalStore(live.subscribe, live.getState);
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
    o.onended = () => ctx.close();
  } catch {
    // no sound available; the screen prompt is enough
  }
}

/** Label the board's own SD-card recording the same way: tag 1, 2 ... for
 *  each thing, and a separate tag for settling. Best effort -- a board that
 *  isn't recording just remembers the label. */
const SETTLE_TAG = 99;
function tellBoard(tag: number, name: string) {
  if (live.getState().phase === 'connected') {
    live.command(`label ${tag} ${name}`).catch(() => {});
  }
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ choose

function Choose({ plan, setPlan, onNext }: { plan: ExperimentPlan | null; setPlan: (p: ExperimentPlan) => void; onNext: () => void }) {
  const problem = plan ? planProblem(plan) : 'Pick an experiment.';
  const set = (patch: Partial<ExperimentPlan>) => plan && setPlan({ ...plan, ...patch });
  const setClass = (i: number, name: string, prompt?: string) => {
    if (!plan) return;
    const classes = [...plan.classes];
    const prompts = [...plan.prompts];
    classes[i] = name;
    if (prompt !== undefined) prompts[i] = prompt;
    setPlan({ ...plan, classes, prompts });
  };

  return (
    <>
      <div className="q-templates">
        {TEMPLATES.map((t) => (
          <button key={t.id} className={`q-template${plan?.title === t.title ? ' on' : ''}`} onClick={() => setPlan(defaultPlan(t))}>
            <b>{t.title}</b>
            <span>{t.blurb}</span>
          </button>
        ))}
      </div>

      {plan && (
        <>
          <div className="card">
            <h2>What to tell apart</h2>
            <div className="stack">
              {plan.classes.map((c, i) => (
                <div key={i} className="q-class">
                  <span className="swatch" style={{ background: CLASS_COLORS[i] }} />
                  <input value={c} onChange={(e) => setClass(i, e.target.value)} aria-label={`Name of thing ${i + 1}`} />
                  <input className="q-prompt" value={plan.prompts[i] ?? ''} onChange={(e) => setClass(i, c, e.target.value)}
                    aria-label={`Instruction for ${c}`} placeholder="What to do for this one" />
                  {plan.classes.length > 2 && (
                    <button className="btn small" onClick={() => setPlan({ ...plan, classes: plan.classes.filter((_, j) => j !== i), prompts: plan.prompts.filter((_, j) => j !== i) })}>Remove</button>
                  )}
                </div>
              ))}
            </div>
            {plan.classes.length < 4 && (
              <button className="btn small" style={{ marginTop: 10 }}
                onClick={() => setPlan({ ...plan, classes: [...plan.classes, `Sample ${String.fromCharCode(65 + plan.classes.length)}`], prompts: [...plan.prompts, ''] })}>
                Add another
              </button>
            )}
          </div>

          <div className="card">
            <h2>How to record</h2>
            <div className="q-methods">
              <label className={`q-method${plan.method === 'rounds' ? ' on' : ''}`}>
                <input type="radio" name="method" checked={plan.method === 'rounds'} onChange={() => setPlan({ ...plan, method: 'rounds', rounds: 4, minutes: 5, settleSeconds: 60 })} />
                <span><b>Repeated rounds</b> <span className="pill ok">recommended</span><br />
                  <span className="muted small">Each thing several times, taking turns. The model has to learn the smell rather than
                    the time of day, and it can be tested on rounds it never saw.</span></span>
              </label>
              <label className={`q-method${plan.method === 'bosch' ? ' on' : ''}`}>
                <input type="radio" name="method" checked={plan.method === 'bosch'} onChange={() => setPlan(boschPlan(plan))} />
                <span><b>Bosch standard</b><br />
                  <span className="muted small">30 minutes of each, once, as in Bosch's AI-Studio tutorial. Plenty of data, but the
                    score can't be checked on anything new.</span></span>
              </label>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              {plan.method === 'rounds' && (
                <label className="field">Rounds
                  <input type="number" min={1} max={20} value={plan.rounds} onChange={(e) => set({ rounds: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 90 }} />
                </label>
              )}
              <label className="field">Minutes each
                <input type="number" min={1} max={120} value={plan.minutes} onChange={(e) => set({ minutes: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 90 }} />
              </label>
              <label className="field">Settling (seconds)
                <input type="number" min={0} max={600} step={10} value={plan.settleSeconds} onChange={(e) => set({ settleSeconds: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 110 }} />
              </label>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Settling is the start of each turn, while the sensors react to the new sample and clear the last one. It is recorded
              but not used for training.
            </p>
            <div className="notice info" style={{ marginTop: 10 }}>
              <b>About {fmtDuration(totalSeconds(plan) * 1000)}</b> of recording, plus the time you take to swap samples.
              {' '}{honestyNote(plan)}
            </div>
          </div>

          {problem && <div className="notice warn">{problem}</div>}
          <button className="btn primary big" disabled={!!problem} onClick={onNext}>Next: connect the board</button>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ setup

function Setup({ onStart, onBack }: { onStart: () => void; onBack: () => void }) {
  const st = useLive();
  const sensors = st.status?.sensors ?? [];
  const ok = sensors.filter((x) => x.state === 'ok' || x.state === 'sleeping').length;
  const up = st.status?.uptime_ms ?? null;
  const warming = up !== null && up < WARMUP_MS;

  if (!('serial' in navigator) && !st.isMock) {
    return (
      <div className="notice warn">
        Connecting to the board needs <b>Chrome</b> or <b>Edge</b> on a computer. Open this page there, or record on the SD card
        (press BOOT at each swap) and import the files on the Data page.
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Connect the board</h2>
      {st.phase !== 'connected' ? (
        <>
          <p>Plug the board into this computer with a USB cable, press <b>Connect</b> and choose it from the list.</p>
          <div className="row">
            <button className="btn primary" disabled={st.phase === 'connecting'} onClick={() => live.connect()}>
              {st.phase === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            <button className="btn" onClick={onBack}>Back</button>
          </div>
          {st.error && <div className="notice error" style={{ marginTop: 12 }}>{st.error}</div>}
          <p className="muted small" style={{ marginTop: 10 }}>Don't connect while a burn-in is running: some boards restart when
            a program connects, which ends it.</p>
        </>
      ) : (
        <>
          <p><span className={`pill ${ok >= 6 ? 'ok' : ok > 0 ? 'warn' : 'err'}`}>{ok} of {sensors.length || 8} sensors working</span>
            {st.status?.board && <span className="muted small"> · {st.status.board}</span>}</p>
          {ok === 0 && <div className="notice error">No sensor is answering yet. Check the board's wiring (the Live page lists what is wrong).</div>}
          {ok > 0 && ok < 6 && <div className="notice warn">Some sensors aren't working. The experiment still works with the rest, but the Live page shows which wire to check.</div>}
          {warming && (
            <div className="notice warn">
              The board was switched on {fmtDuration(up!)} ago. Readings drift for a while after power-on as the sensors and the board heat up; Bosch leaves the first 15 minutes out of their own demo. Waiting
              {fmtDuration(WARMUP_MS - up!)} more gives better results. You can start anyway.
            </div>
          )}
          <div className="row">
            <button className="btn primary big" disabled={ok === 0} onClick={onStart}>Start the experiment</button>
            <button className="btn" onClick={onBack}>Back</button>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ record

type Stage = 'waiting' | 'settling' | 'recording';

function Record({ plan, onDone, onAbort }: { plan: ExperimentPlan; onDone: () => void; onAbort: () => void }) {
  const st = useLive();
  const blocks = useMemo(() => schedule(plan), [plan]);
  const [i, setI] = useState(0);
  const [stage, setStage] = useState<Stage>('waiting');
  const [endsAt, setEndsAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [paused, setPaused] = useState<number | null>(null);
  const started = useRef(false);

  const block: Block = blocks[i];

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      live.startCapture(SETTLE_LABEL);
      tellBoard(SETTLE_TAG, SETTLE_LABEL);
    }
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // The clock drives the stages.
  useEffect(() => {
    if (paused !== null || stage === 'waiting' || now < endsAt) return;
    if (stage === 'settling') {
      live.nextSample(block.label);
      tellBoard(plan.classes.indexOf(block.className) + 1, block.className);
      setStage('recording');
      setEndsAt(Date.now() + block.recordSeconds * 1000);
    } else {
      beep();
      live.nextSample(SETTLE_LABEL);
      tellBoard(SETTLE_TAG, SETTLE_LABEL);
      if (i + 1 >= blocks.length) {
        live.stopCapture();
        onDone();
      } else {
        setI(i + 1);
        setStage('waiting');
      }
    }
  }, [now, endsAt, stage, paused, block, i, blocks.length, onDone, plan.classes]);

  const begin = () => {
    setStage('settling');
    setEndsAt(Date.now() + block.settleSeconds * 1000);
  };
  const togglePause = () => {
    if (paused === null) {
      setPaused(Date.now());
    } else {
      setEndsAt(endsAt + (Date.now() - paused));
      setPaused(null);
    }
  };

  const disconnected = st.phase !== 'connected';
  const left = Math.max(0, (endsAt - (paused ?? now)) / 1000);
  const blockLen = stage === 'settling' ? block.settleSeconds : block.recordSeconds;
  const done = blocks.slice(0, i).reduce((n, b) => n + b.settleSeconds + b.recordSeconds, 0)
    + (stage === 'recording' ? block.settleSeconds + (blockLen - left) : stage === 'settling' ? blockLen - left : 0);
  const total = totalSeconds(plan);
  const color = CLASS_COLORS[plan.classes.indexOf(block.className)] ?? 'var(--accent)';

  return (
    <>
      <div className="q-progress" aria-label="Progress through the experiment">
        <div style={{ width: `${Math.min(100, (100 * done) / total)}%` }} />
      </div>
      <p className="muted small">Turn {i + 1} of {blocks.length}{plan.rounds > 1 ? ` · round ${block.round} of ${plan.rounds}` : ''} ·
        about {fmtDuration(Math.max(0, total - done) * 1000)} to go</p>

      {disconnected && (
        <div className="notice error">
          The board disconnected. {st.unsaved ? 'What was recorded so far is kept.' : ''} Reconnect on the previous step, or stop here and keep what you have.
        </div>
      )}

      <div className="q-now" style={{ borderColor: color }}>
        {stage === 'waiting' ? (
          <>
            <div className="q-label" style={{ color }}>{block.className}</div>
            <p className="q-instruction">{block.prompt}</p>
            <button className="btn primary big" onClick={begin} disabled={disconnected}>Done, start the timer</button>
          </>
        ) : (
          <>
            <div className="q-label" style={{ color }}>{block.className}</div>
            <div className="q-clock num">{fmtClock(left)}</div>
            <p className="q-instruction">
              {stage === 'settling'
                ? 'Settling: the sensors are adjusting. Leave everything as it is.'
                : 'Recording. Leave everything as it is until the timer ends.'}
            </p>
            <button className="btn" onClick={togglePause}>{paused !== null ? 'Carry on' : 'Pause'}</button>
          </>
        )}
      </div>

      {blocks[i + 1] && (
        <p className="muted small" style={{ textAlign: 'center' }}>Next: {blocks[i + 1].className}</p>
      )}

      <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
        <button className="btn danger small" onClick={() => { live.stopCapture(); onAbort(); }}>Stop here and keep what I have</button>
      </div>
      <p className="muted small" style={{ textAlign: 'center' }}>{st.captureCycles.toLocaleString()} complete cycles so far</p>
    </>
  );
}

// ------------------------------------------------------------------ results

function Results({ plan, onTest, onAgain, onNew }: { plan: ExperimentPlan; onTest: (m: ModelRecord) => void; onAgain: () => void; onNew: () => void }) {
  const s = useStudio();
  const st = useLive();
  const [phase, setPhase] = useState<'saving' | 'training' | 'done' | 'error'>('saving');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<TrainOutcome | null>(null);
  const [model, setModel] = useState<ModelRecord | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const abort = new AbortController();   // never aborted: a finished model is saved even if the page is left
    (async () => {
      try {
        // 1. Save the capture, with a class for each thing told apart.
        const project = s.project!;
        const classes: SpecimenClass[] = [];
        const idOf = new Map<string, string>();
        plan.classes.forEach((name, k) => {
          const have = project.classes.find((c) => c.name.toLowerCase() === name.toLowerCase());
          const c = have ?? { id: newId('cls'), name, color: CLASS_COLORS[(project.classes.length + k) % CLASS_COLORS.length] };
          if (!have) classes.push(c);
          idOf.set(name, c.id);
        });
        let recId: string | null = null;
        let heater = '';
        if (st.unsaved) {
          const { recording } = st.unsaved.capture.toRecording({
            name: `${plan.title} · ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
            config: st.config,
            boardId: st.status?.board ?? '',
            firmware: st.status?.fw ? `bme690-logger-idf ${st.status.fw}` : '',
            classes: false,
          });
          for (const sp of recording.specimens) {
            const c = classOfLabel(plan, sp.name);
            sp.classId = c ? idOf.get(c) ?? null : null;
          }
          const count = new Map<string, number>();
          for (const c of recording.cycles) count.set(c.heaterProfile, (count.get(c.heaterProfile) ?? 0) + 1);
          heater = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
          recId = recording.id;
          await s.addRecordings([recording], classes);
          live.discardUnsaved();
        }
        if (!recId) throw new Error('Nothing was recorded, so there is nothing to train on.');

        // 2. Train on every recording of these classes in the project, so a
        //    second session adds to the first.
        setPhase('training');
        const kind = getModelKind('forest');
        const params: Record<string, ParamValue> = Object.fromEntries(kind.params.map((p) => [p.key, p.default]));
        const labelOf: Record<string, string> = {};
        for (const [name, id] of idOf) labelOf[id] = name;
        const all = await listRecordings(project.id);
        const o = await trainAndEvaluate(all, {
          spec: { featureSet: 'shape', environment: false, heaterProfile: heater, sensors: [], mode: 'per-sensor', labelOf },
          kind: 'forest', params, split: 'specimen', testFraction: 0.3, compare: true,
        }, (_phase, p) => setProgress(p.fraction), abort.signal);
        const rec = toRecord(o, `${plan.title} model`);
        await s.saveModel(rec);
        setOutcome(o);
        setModel(rec);
        setPhase('done');
      } catch (e) {
        setError((e as Error).message);
        setPhase('error');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'error') {
    return (
      <div className="card">
        <div className="notice error">{error}</div>
        <p>A model needs at least two rounds of each thing to be tested honestly. Record another round and try again.</p>
        <button className="btn primary" onClick={onAgain}>Record more</button>
      </div>
    );
  }
  if (phase !== 'done' || !outcome || !model) {
    return (
      <div className="card">
        <h2>{phase === 'saving' ? 'Saving the recording…' : 'Teaching the model…'}</h2>
        <div className="q-progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      </div>
    );
  }

  const honest = outcome.main;
  const pct = Math.round(honest.scores.accuracy * 100);
  const verdict = pct >= 90 ? 'Yes, clearly.' : pct >= 75 ? 'Mostly.' : pct >= 60 ? 'Only somewhat.' : 'Not reliably yet.';
  return (
    <>
      <div className="card q-result">
        <p className="muted">Can the sensors tell {plan.classes.join(' from ')}?</p>
        <div className="q-verdict">{verdict}</div>
        <div className="q-score num">{pct}%</div>
        <p>{summarize(honest.scores, outcome.labels, honest.split)}</p>
        {honest.warning && <div className="notice warn">{honest.warning}</div>}
        {outcome.other && (
          <p className="muted small">
            A random test, the way BME AI-Studio scores, would say {Math.round(outcome.other.scores.accuracy * 100)}%. This page
            reports the harder test: rounds the model never saw.
          </p>
        )}
      </div>
      <div className="card">
        <h2>Per thing</h2>
        <table className="data">
          <thead><tr><th>Thing</th><th className="num">Recognised</th></tr></thead>
          <tbody>
            {outcome.labels.map((l, k) => (
              <tr key={l}><td><span className="swatch" style={{ background: CLASS_COLORS[plan.classes.indexOf(l)] ?? '#888' }} />{l}</td>
                <td className="num">{Number.isFinite(honest.scores.recall[k]) ? `${Math.round(honest.scores.recall[k] * 100)}%` : '–'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn primary big" onClick={() => onTest(model)}>Try it live</button>
        <button className="btn" onClick={onAgain}>Record another session</button>
        <a className="btn" href="#train" style={{ textDecoration: 'none' }}>Open the full Train page</a>
        <button className="btn" onClick={onNew}>New experiment</button>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>More sessions on different days make the model sturdier; each one is
        added to the last.</p>
    </>
  );
}

// ------------------------------------------------------------------ test

function Test({ model, onBack }: { model: ModelRecord; onBack: () => void }) {
  const st = useLive();
  useEffect(() => {
    live.chooseModel(model);
  }, [model]);
  const a = st.answer;
  const fresh = a && Date.now() - a.at < 60_000;
  const sure = a && a.confidence >= NOT_SURE;
  const label = a ? model.labels[a.label] : '';
  const color = CLASS_COLORS[model.labels.indexOf(label)] ?? 'var(--accent)';

  return (
    <>
      <div className="q-now q-live" style={{ borderColor: sure && fresh ? color : 'var(--line)' }}>
        {st.phase !== 'connected' ? (
          <p className="q-instruction">The board is not connected. Go back a step and connect it.</p>
        ) : !fresh ? (
          <p className="q-instruction">Listening… the first answer comes after one full heater cycle, about 11 seconds.</p>
        ) : sure ? (
          <>
            <div className="q-big" style={{ color }}>{label.toUpperCase()}</div>
            <p className="q-instruction">{Math.round(a!.confidence * 100)}% sure · {a!.agree} of {a!.voters} sensors agree</p>
          </>
        ) : (
          <>
            <div className="q-big muted">NOT SURE</div>
            <p className="q-instruction">Leaning towards {label} ({Math.round(a!.confidence * 100)}%). Give it a moment.</p>
          </>
        )}
      </div>
      <p className="muted small" style={{ textAlign: 'center' }}>Move the samples around and watch the answer change. It updates about every
        11 seconds, once per heater cycle.</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn" onClick={onBack}>Back to the result</button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ page

/** The guide's progress lives outside the component: opening the experiment's
 *  project re-mounts the page, and the guide must carry on where it was. */
const kept: { step: Step; plan: ExperimentPlan | null; model: ModelRecord | null; ownProject: string | null } = {
  step: 'choose', plan: null, model: null, ownProject: null,
};

function useKept<K extends keyof typeof kept>(key: K): [(typeof kept)[K], (v: (typeof kept)[K]) => void] {
  const [v, setV] = useState(kept[key]);
  return [v, (next) => {
    kept[key] = next;
    setV(next);
  }];
}

function Quick() {
  const s = useStudio();
  const [step, setStep] = useKept('step');
  const [plan, setPlan] = useKept('plan');
  const [model, setModel] = useKept('model');

  // Each experiment gets its own project, so its classes never mix with
  // other data; "Record another session" keeps adding to the same one.
  const [ownProject, setOwnProject] = useKept('ownProject');
  const toSetup = async () => {
    if (plan && (!ownProject || s.project?.id !== ownProject)) {
      const p = await s.createProject(plan.title);
      setOwnProject(p.id);
    }
    setStep('setup');
  };

  return (
    <>
      <div className="pagehead">
        <h1>Quick experiment</h1>
        <p>Teach the sensors to tell things apart, step by step: choose what to compare, follow the prompts while the board
          records, and see how well it works. Good for a first project or a science fair.</p>
      </div>
      <ol className="q-steps" aria-label="Steps">
        {(Object.keys(STEP_NAMES) as Step[]).map((k) => (
          <li key={k} className={k === step ? 'on' : ''}>{STEP_NAMES[k]}</li>
        ))}
      </ol>

      {step === 'choose' && <Choose plan={plan} setPlan={setPlan} onNext={toSetup} />}
      {step === 'setup' && plan && <Setup onStart={() => setStep('record')} onBack={() => setStep('choose')} />}
      {step === 'record' && plan && <Record plan={plan} onDone={() => setStep('results')} onAbort={() => setStep('results')} />}
      {step === 'results' && plan && (
        <Results plan={plan} onTest={(m) => { setModel(m); setStep('test'); }} onAgain={() => setStep('setup')}
          onNew={() => { setPlan(null); setModel(null); setOwnProject(null); setStep('choose'); }} />
      )}
      {step === 'test' && model && <Test model={model} onBack={() => setStep('results')} />}
    </>
  );
}

registerView({ id: 'quick', title: 'Quick experiment', hint: 'Start here: guided, step by step', order: 5, component: Quick });
