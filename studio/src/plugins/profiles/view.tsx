/**
 * Heater profiles: design board configurations (.bmeconfig) the way BME
 * AI-Studio's board-configuration screen does -- heater profiles, duty
 * cycles and which sensor runs what -- check them against the board's
 * limits, keep them in the project and export them for the board.
 */
import { useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import { useStudio } from '../../app/state.tsx';
import { newId } from '../../core/ids.ts';
import type { BoardConfig, HeaterProfile } from '../../core/types.ts';
import { download, fmtDate, sensorColor } from '../../ui/format.ts';
import { axis, Chart, cssVar } from '../live/chart.tsx';
import { registerView } from '../registry.ts';
import { DUTY_LIBRARY, HEATER_LIBRARY, LIBRARY_CREDIT } from './library.ts';
import {
  LIMITS, checkConfig, customHeaterId, cycleMs, dutyName, editableCopy, fmtCycle, fromBmeconfig, fromLibrary,
  heaterName, isStandard, makeDuty, newConfig, slug, toBmeconfig,
} from './model.ts';
import './profiles.css';

// ------------------------------------------------------------ step chart

function StepChart({ profile, height = 200 }: { profile: HeaterProfile; height?: number }) {
  const data = useMemo<uPlot.AlignedData>(() => {
    const x = [0];
    const y: number[] = [];
    let t = 0;
    for (const [temp, dur] of profile.steps) {
      y.push(Number(temp) || 0);
      t += (Number(dur) || 0) * (Number(profile.timeBase) || 0);
      x.push(t / 1000);
    }
    y.push(y[y.length - 1] ?? 0);
    return [x, y];
  }, [profile]);
  const key = `${profile.id}`;
  return (
    <Chart
      label={`Heater temperature over one cycle of ${heaterName(profile)}`}
      optionsKey={key}
      data={data}
      height={height}
      options={() => ({
        scales: { x: { time: false }, y: { range: [0, 400] } },
        axes: [
          axis({ values: (_u, v) => v.map((s) => (s == null ? '' : `${+s.toFixed(1)} s`)) }),
          axis({ values: (_u, v) => v.map((s) => (s == null ? '' : `${s} °C`)), size: 60 }),
        ],
        series: [
          { label: 'time', value: (_u: uPlot, v: number | null) => (v == null ? '–' : `${v.toFixed(2)} s`) },
          {
            label: 'heater',
            stroke: cssVar('--s6'),
            fill: `color-mix(in srgb, ${cssVar('--s6')} 14%, transparent)`,
            width: 2,
            paths: uPlot.paths.stepped!({ align: 1 }),
            points: { show: false },
            value: (_u: uPlot, v: number | null) => (v == null ? '–' : `${v} °C`),
          },
        ],
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
      })}
    />
  );
}

// ------------------------------------------------------------ library

function Library({ config, onAdd }: { config: BoardConfig; onAdd: (h: HeaterProfile, editable: boolean) => void }) {
  const [preview, setPreview] = useState('heater_354');
  const lib = HEATER_LIBRARY.find((h) => h.id === preview)!;
  const full = config.heaterProfiles.length >= LIMITS.maxHeaterProfiles;
  const already = config.heaterProfiles.some((h) => h.id === lib.id);
  const tooLong = lib.steps.some((s) => s[1] > LIMITS.durMax);

  return (
    <div className="card">
      <h2>Bosch's standard heater profiles</h2>
      <p className="muted small">Read-only. Add one to your configuration as it is, or duplicate it to make your own
        version. {LIBRARY_CREDIT}</p>
      <div className="hp-lib">
        <div className="hp-lib-list" role="listbox" aria-label="Standard heater profiles">
          {HEATER_LIBRARY.map((h) => (
            <button key={h.id} role="option" aria-selected={h.id === preview}
              className={`hp-lib-item${h.id === preview ? ' on' : ''}`} onClick={() => setPreview(h.id)}>
              <b>{h.name}</b>
              <span className="muted small">{fmtCycle(cycleMs(h))}</span>
            </button>
          ))}
        </div>
        <div className="hp-lib-preview">
          <div className="row spread">
            <h3 style={{ margin: 0 }}>{lib.name} <span className="muted small" style={{ fontWeight: 400 }}>· {lib.id} · cycle {fmtCycle(cycleMs(lib))}</span></h3>
          </div>
          <StepChart profile={lib} height={170} />
          <p className="small muted hp-steps">{lib.steps.map((s) => `${s[0]} °C × ${s[1]}`).join(' · ')} <span>(time base {lib.timeBase} ms)</span></p>
          {tooLong && (
            <div className="notice warn small">
              {lib.name} is Bosch's burn-in profile for new sensors: 320 °C held for {lib.steps[0][1]} time-base units per
              step. The board's heater stores each step's length in one byte, so it caps every step at {LIMITS.durMax} — the
              heater still stays at 320 °C the whole time; only the cycle is shorter. To burn in sensors, use
              <b> Burn in new sensors</b> on the Live page instead. "Duplicate" here makes a copy with the steps capped at {LIMITS.durMax}.
            </div>
          )}
          <div className="row">
            <button className="btn" disabled={full || already || tooLong} onClick={() => onAdd(fromLibrary(lib.id), false)}>
              Add to configuration
            </button>
            <button className="btn primary" disabled={full} onClick={() => onAdd(lib, true)}>Duplicate to edit</button>
            {full && <span className="muted small">The configuration already has {LIMITS.maxHeaterProfiles} heater profiles, the most a board can take.</span>}
            {already && !full && <span className="muted small">Already in the configuration.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ profile editor

function NumberCell({ value, onChange, min, max, label }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string }) {
  const bad = !Number.isInteger(value) || value < min || value > max;
  return (
    <input type="number" inputMode="numeric" className={`hp-num${bad ? ' bad' : ''}`} value={Number.isFinite(value) ? value : ''}
      min={min} max={max} step={1} aria-label={label} aria-invalid={bad}
      onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
  );
}

function ProfileEditor({ profile, config, onChange, onCopy, onRemove }: {
  profile: HeaterProfile;
  config: BoardConfig;
  onChange: (h: HeaterProfile) => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const standard = isStandard(profile);
  const users = config.sensors.filter((s) => s.heaterProfile === profile.id).map((s) => s.sensorIndex);
  const setStep = (i: number, k: 0 | 1, v: number) =>
    onChange({ ...profile, steps: profile.steps.map((s, j) => (j === i ? (k === 0 ? [v, s[1]] : [s[0], v]) : s)) as [number, number][] });
  let t = 0;

  return (
    <div className="hp-editor">
      <div className="row spread" style={{ alignItems: 'end' }}>
        {standard ? (
          <div>
            <h3 style={{ margin: 0 }}>{heaterName(profile)} <span className="pill">Bosch standard</span></h3>
            <span className="muted small">Standard profiles can't be changed. Make a copy to edit it.</span>
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'end' }}>
            <label className="field">Name
              <input value={profile.name ?? ''} onChange={(e) => onChange({ ...profile, name: e.target.value })} maxLength={34} />
            </label>
            <label className="field">Time base (ms)
              <NumberCell value={profile.timeBase} min={LIMITS.timeBaseMin} max={LIMITS.timeBaseMax} label="Time base in milliseconds"
                onChange={(v) => onChange({ ...profile, timeBase: v })} />
            </label>
          </div>
        )}
        <div className="row">
          {standard && <button className="btn primary small" onClick={onCopy}>Make an editable copy</button>}
          <button className="btn danger small" onClick={onRemove}>Remove</button>
        </div>
      </div>
      <p className="muted small" style={{ margin: '8px 0' }}>
        id <code>{profile.id}</code> · one cycle takes <b>{fmtCycle(cycleMs(profile))}</b>
        {' '}({profile.steps.reduce((a, s) => a + (Number(s[1]) || 0), 0)} × {profile.timeBase} ms)
        {' · '}{users.length ? `used by sensor${users.length > 1 ? 's' : ''} ${users.join(', ')}` : 'not used by any sensor yet'}
      </p>
      <div className="hp-edit-grid">
        <div className="table-wrap">
          <table className="data hp-steps-table">
            <thead>
              <tr><th>Step</th><th className="num">Temperature (°C)</th><th className="num">Duration (× {profile.timeBase} ms)</th><th className="num">Starts at</th></tr>
            </thead>
            <tbody>
              {profile.steps.map((s, i) => {
                const start = t;
                t += (Number(s[1]) || 0) * (Number(profile.timeBase) || 0);
                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td className="num">{standard ? s[0] : <NumberCell value={s[0]} min={LIMITS.tempMin} max={LIMITS.tempMax} label={`Step ${i + 1} temperature`} onChange={(v) => setStep(i, 0, v)} />}</td>
                    <td className="num">{standard ? s[1] : <NumberCell value={s[1]} min={LIMITS.durMin} max={LIMITS.durMax} label={`Step ${i + 1} duration`} onChange={(v) => setStep(i, 1, v)} />}</td>
                    <td className="num muted">{fmtCycle(start)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div>
          <StepChart profile={profile} />
          {!standard && <p className="muted small">Temperatures 0–{LIMITS.tempMax} °C; durations 1–{LIMITS.durMax} time-base
            units. The last reading of each step is the one that counts, so give short steps at least 2 units.</p>}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ page

interface Draft {
  savedId: string | null;
  name: string;
  config: BoardConfig;
}

function freshDraft(): Draft {
  return { savedId: null, name: 'My configuration', config: newConfig() };
}

function Profiles() {
  const s = useStudio();
  const saved = s.project?.savedConfigs ?? [];
  const [draft, setDraft] = useState<Draft>(freshDraft);
  const [sel, setSel] = useState(0);
  const [importMsg, setImportMsg] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [addDuty, setAddDuty] = useState('duty_1');
  const [custom, setCustom] = useState({ scan: 1, sleep: 0 });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const c = draft.config;
  const check = useMemo(() => checkConfig(c), [c]);
  const savedCopy = saved.find((x) => x.id === draft.savedId);
  const changed = !savedCopy || JSON.stringify(savedCopy.config) !== JSON.stringify(c) || savedCopy.name !== draft.name;
  const selected = c.heaterProfiles[Math.min(sel, c.heaterProfiles.length - 1)];

  const setConfig = (next: BoardConfig) => setDraft((d) => ({ ...d, config: next }));

  // ---- heater profiles
  const addHeater = (h: HeaterProfile, editable: boolean) => {
    const taken = c.heaterProfiles.map((x) => x.id);
    const p = editable ? editableCopy(h, taken) : h;
    const heaterProfiles = [...c.heaterProfiles, p];
    // A configuration with only unused profiles is confusing; give the first
    // added profile to every sensor that has none.
    const sensors = c.sensors.map((x) => (taken.includes(x.heaterProfile) ? x : { ...x, heaterProfile: p.id }));
    setConfig({ ...c, heaterProfiles, sensors });
    setSel(heaterProfiles.length - 1);
  };
  const updateHeater = (i: number, h: HeaterProfile) => {
    const old = c.heaterProfiles[i];
    let next = h;
    if (h.name !== old.name && !isStandard(old)) {
      // The id follows the name, so it reads well in AI-Studio and in recordings.
      next = { ...h, id: customHeaterId(h.name || 'profile', c.heaterProfiles.filter((_, j) => j !== i).map((x) => x.id)) };
    }
    setConfig({
      ...c,
      heaterProfiles: c.heaterProfiles.map((x, j) => (j === i ? next : x)),
      sensors: next.id === old.id ? c.sensors : c.sensors.map((x) => (x.heaterProfile === old.id ? { ...x, heaterProfile: next.id } : x)),
    });
  };
  const removeHeater = (i: number) => {
    const gone = c.heaterProfiles[i].id;
    const rest = c.heaterProfiles.filter((_, j) => j !== i);
    setConfig({ ...c, heaterProfiles: rest, sensors: c.sensors.map((x) => (x.heaterProfile === gone ? { ...x, heaterProfile: rest[0]?.id ?? '' } : x)) });
    setSel(0);
  };
  const copyHeater = (i: number) => addHeater(c.heaterProfiles[i], true);

  // ---- duty cycles
  const addDutyCycle = (scan: number, sleep: number) => {
    const d = makeDuty(scan, sleep);
    if (c.dutyCycleProfiles.some((x) => x.id === d.id)) return;
    setConfig({ ...c, dutyCycleProfiles: [...c.dutyCycleProfiles, d] });
  };
  const removeDuty = (id: string) => {
    const rest = c.dutyCycleProfiles.filter((x) => x.id !== id);
    setConfig({ ...c, dutyCycleProfiles: rest, sensors: c.sensors.map((x) => (x.dutyCycleProfile === id ? { ...x, dutyCycleProfile: rest[0]?.id ?? '' } : x)) });
  };

  // ---- sensors
  const setSensor = (i: number, patch: Partial<BoardConfig['sensors'][number]>) =>
    setConfig({ ...c, sensors: c.sensors.map((x) => (x.sensorIndex === i ? { ...x, ...patch } : x)) });
  const setAll = (patch: Partial<BoardConfig['sensors'][number]>) => setConfig({ ...c, sensors: c.sensors.map((x) => ({ ...x, ...patch })) });
  const allSame = <K extends 'heaterProfile' | 'dutyCycleProfile'>(k: K) => (c.sensors.every((x) => x[k] === c.sensors[0]?.[k]) ? c.sensors[0]?.[k] ?? '' : '');

  // ---- files
  const doExport = () => {
    download(`${slug(draft.name)}.bmeconfig`, toBmeconfig(c), 'application/json');
    s.toast(`Exported ${slug(draft.name)}.bmeconfig. See "Loading it onto the board" below.`);
  };
  const doImport = async (f: File | undefined) => {
    if (!f) return;
    try {
      const { config, notes } = fromBmeconfig(await f.text());
      setDraft({ savedId: null, name: f.name.replace(/\.(bmeconfig|json|bmerawdata)$/i, ''), config });
      setSel(0);
      const problems = checkConfig(config).errors.length;
      setImportMsg({
        kind: notes.length || problems ? 'warn' : 'ok',
        text: `Opened ${f.name}: ${config.heaterProfiles.length} heater profile(s), ${config.dutyCycleProfiles.length} duty cycle(s).` +
          (notes.length ? ' ' + notes.join(' ') : '') +
          (problems ? ` It has ${problems} problem(s) to fix before it can be exported — see "Check and export".` : ''),
      });
    } catch (e) {
      setImportMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      if (file.current) file.current.value = '';
    }
  };
  const doSave = async () => {
    const id = draft.savedId ?? newId('cfg');
    await s.saveConfig({ id, name: draft.name.trim() || 'Untitled configuration', config: c, updated: Date.now() });
    setDraft((d) => ({ ...d, savedId: id, name: d.name.trim() || 'Untitled configuration' }));
    s.toast(`Saved "${draft.name.trim() || 'Untitled configuration'}" in this project.`);
  };
  const open = (id: string) => {
    const x = saved.find((y) => y.id === id);
    if (!x) return;
    setDraft({ savedId: x.id, name: x.name, config: structuredClone(x.config) });
    setSel(0);
    setImportMsg(null);
  };

  return (
    <>
      <div className="pagehead">
        <h1>Heater profiles</h1>
        <p>Design what the board's heaters do: which heater profiles and duty cycles it runs and on which of the eight
          sensors. Export the result as a <code>.bmeconfig</code> file for the board or for BME AI-Studio.</p>
      </div>

      <div className="card">
        <div className="row spread" style={{ alignItems: 'end' }}>
          <label className="field" style={{ flex: '1 1 260px' }}>Configuration name
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <div className="row">
            {changed ? <span className="pill warn">not saved</span> : <span className="pill ok">saved</span>}
            <button className="btn primary" onClick={doSave}>Save in project</button>
            <button className="btn" onClick={() => { setDraft(freshDraft()); setSel(0); setImportMsg(null); }}>New</button>
            <button className="btn" onClick={() => file.current?.click()}>Open .bmeconfig…</button>
            <input ref={file} type="file" accept=".bmeconfig,.json" hidden onChange={(e) => doImport(e.target.files?.[0])} />
          </div>
        </div>
        {importMsg && <div className={`notice ${importMsg.kind}`} style={{ margin: '12px 0 0' }}>{importMsg.text}</div>}
        {saved.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <h3>Saved in this project</h3>
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {[...saved].sort((a, b) => b.updated - a.updated).map((x) => (
                    <tr key={x.id}>
                      <td><b>{x.name}</b>{x.id === draft.savedId && <span className="pill" style={{ marginLeft: 6 }}>open</span>}</td>
                      <td className="muted small">{x.config.heaterProfiles.map(heaterName).join(', ')}</td>
                      <td className="muted small">{fmtDate(x.updated)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {confirmDelete === x.id ? (
                          <>
                            <button className="btn danger small" onClick={async () => { await s.deleteConfig(x.id); setConfirmDelete(null); if (draft.savedId === x.id) setDraft((d) => ({ ...d, savedId: null })); }}>Delete</button>{' '}
                            <button className="btn small" onClick={() => setConfirmDelete(null)}>Keep</button>
                          </>
                        ) : (
                          <>
                            <button className="btn small" onClick={() => open(x.id)}>Open</button>{' '}
                            <button className="btn small danger" onClick={() => setConfirmDelete(x.id)} aria-label={`Delete ${x.name}`}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Library config={c} onAdd={addHeater} />

      <div className="card">
        <h2>Heater profiles in this configuration <span className="muted small" style={{ fontWeight: 400 }}>({c.heaterProfiles.length} of at most {LIMITS.maxHeaterProfiles})</span></h2>
        {c.heaterProfiles.length === 0 ? (
          <p className="empty">None yet. Add one from Bosch's standard profiles above.</p>
        ) : (
          <>
            <div className="hp-tabs" role="tablist">
              {c.heaterProfiles.map((h, i) => (
                <button key={h.id + i} role="tab" aria-selected={h === selected} className={`hp-tab${h === selected ? ' on' : ''}`} onClick={() => setSel(i)}>
                  {heaterName(h)}
                </button>
              ))}
            </div>
            {selected && (
              <ProfileEditor
                key={c.heaterProfiles.indexOf(selected)}
                profile={selected}
                config={c}
                onChange={(h) => updateHeater(c.heaterProfiles.indexOf(selected), h)}
                onCopy={() => copyHeater(c.heaterProfiles.indexOf(selected))}
                onRemove={() => removeHeater(c.heaterProfiles.indexOf(selected))}
              />
            )}
          </>
        )}
      </div>

      <div className="grid hp-two">
        <div className="card">
          <h2>Duty cycles <span className="muted small" style={{ fontWeight: 400 }}>({c.dutyCycleProfiles.length} of at most {LIMITS.maxDutyCycles})</span></h2>
          <p className="muted small">A duty cycle lets a sensor rest between scans to save power and stay cooler: it runs its
            heater profile for some cycles, then sleeps for some. Continuous (RDC-1-0) never rests.</p>
          <table className="data">
            <thead><tr><th>Duty cycle</th><th className="num">Scanning</th><th className="num">Sleeping</th><th /></tr></thead>
            <tbody>
              {c.dutyCycleProfiles.map((d) => (
                <tr key={d.id}>
                  <td><b>{dutyName(d)}</b> <span className="muted small">{d.id}</span></td>
                  <td className="num">{d.scanningCycles}</td>
                  <td className="num">{d.sleepingCycles}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn danger small" onClick={() => removeDuty(d.id)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}>
            <select value={addDuty} onChange={(e) => setAddDuty(e.target.value)} aria-label="Standard duty cycle">
              {DUTY_LIBRARY.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.scanningCycles} on, {d.sleepingCycles} off)</option>)}
            </select>
            <button className="btn" disabled={c.dutyCycleProfiles.length >= LIMITS.maxDutyCycles || c.dutyCycleProfiles.some((x) => x.id === addDuty)}
              onClick={() => { const d = DUTY_LIBRARY.find((x) => x.id === addDuty)!; addDutyCycle(d.scanningCycles, d.sleepingCycles); }}>Add</button>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small muted">or your own:</span>
            <label className="small">scan <input type="number" min={1} value={custom.scan} onChange={(e) => setCustom({ ...custom, scan: Number(e.target.value) })} className="hp-num" aria-label="Scanning cycles" /></label>
            <label className="small">sleep <input type="number" min={0} value={custom.sleep} onChange={(e) => setCustom({ ...custom, sleep: Number(e.target.value) })} className="hp-num" aria-label="Sleeping cycles" /></label>
            <button className="btn" disabled={c.dutyCycleProfiles.length >= LIMITS.maxDutyCycles || !(Number.isInteger(custom.scan) && custom.scan >= 1 && Number.isInteger(custom.sleep) && custom.sleep >= 0 && custom.scan <= LIMITS.cyclesMax && custom.sleep <= LIMITS.cyclesMax)}
              onClick={() => addDutyCycle(custom.scan, custom.sleep)}>Add</button>
          </div>
        </div>

        <div className="card">
          <h2>Sensors</h2>
          <div className="table-wrap">
            <table className="data hp-sensors">
              <thead><tr><th>Sensor</th><th>On</th><th>Heater profile</th><th>Duty cycle</th></tr></thead>
              <tbody>
                <tr className="hp-all">
                  <td><b>All</b></td>
                  <td><input type="checkbox" aria-label="Switch all sensors on or off" checked={c.sensors.every((x) => x.active)}
                    ref={(el) => { if (el) el.indeterminate = !c.sensors.every((x) => x.active) && c.sensors.some((x) => x.active); }}
                    onChange={(e) => setAll({ active: e.target.checked })} /></td>
                  <td>
                    <select value={allSame('heaterProfile')} onChange={(e) => e.target.value && setAll({ heaterProfile: e.target.value })} aria-label="Heater profile for all sensors">
                      <option value="">— mixed —</option>
                      {c.heaterProfiles.map((h) => <option key={h.id} value={h.id}>{heaterName(h)}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={allSame('dutyCycleProfile')} onChange={(e) => e.target.value && setAll({ dutyCycleProfile: e.target.value })} aria-label="Duty cycle for all sensors">
                      <option value="">— mixed —</option>
                      {c.dutyCycleProfiles.map((d) => <option key={d.id} value={d.id}>{dutyName(d)}</option>)}
                    </select>
                  </td>
                </tr>
                {c.sensors.map((x) => (
                  <tr key={x.sensorIndex} className={x.active ? '' : 'hp-off'}>
                    <td><span className="swatch" style={{ background: sensorColor(x.sensorIndex) }} />{x.sensorIndex}</td>
                    <td><input type="checkbox" checked={x.active} aria-label={`Sensor ${x.sensorIndex} on`} onChange={(e) => setSensor(x.sensorIndex, { active: e.target.checked })} /></td>
                    <td>
                      <select value={x.heaterProfile} onChange={(e) => setSensor(x.sensorIndex, { heaterProfile: e.target.value })} aria-label={`Heater profile for sensor ${x.sensorIndex}`}>
                        {!c.heaterProfiles.some((h) => h.id === x.heaterProfile) && <option value={x.heaterProfile}>— choose —</option>}
                        {c.heaterProfiles.map((h) => <option key={h.id} value={h.id}>{heaterName(h)}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={x.dutyCycleProfile} onChange={(e) => setSensor(x.sensorIndex, { dutyCycleProfile: e.target.value })} aria-label={`Duty cycle for sensor ${x.sensorIndex}`}>
                        {!c.dutyCycleProfiles.some((d) => d.id === x.dutyCycleProfile) && <option value={x.dutyCycleProfile}>— choose —</option>}
                        {c.dutyCycleProfiles.map((d) => <option key={d.id} value={d.id}>{dutyName(d)}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Check and export</h2>
        {check.errors.length === 0 ? (
          <div className="notice ok">Everything is within the board's limits. Ready to export.</div>
        ) : (
          <div className="notice error">
            <b>Fix {check.errors.length === 1 ? 'this' : `these ${check.errors.length} things`} before exporting:</b>
            <ul className="hp-issues">{check.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </div>
        )}
        {check.warnings.length > 0 && (
          <div className="notice warn"><ul className="hp-issues">{check.warnings.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
        )}
        <div className="row">
          <button className="btn primary" disabled={check.errors.length > 0} onClick={doExport}>Export .bmeconfig</button>
          <span className="muted small">{slug(draft.name)}.bmeconfig · board type BME690 8x shuttle board (board_690)</span>
        </div>
        <h3 style={{ marginTop: 16 }}>Loading it onto the board</h3>
        <ol className="small hp-howto">
          <li>Join the board's WiFi network (<b>BME690-XXXX</b>, no password) and open its dashboard at <code>http://192.168.4.1</code>.</li>
          <li>Go to <b>Recording → Heater profile → Upload</b> and choose the exported file. The board switches straight away; a
            recording in progress ends and a new one begins.</li>
          <li>Or copy the file to the top folder of the board's SD card and restart the board. Keep only one
            <code>.bmeconfig</code> file there; a file called <code>bme690.bmeconfig</code> is always used first.</li>
        </ol>
        <p className="muted small">The same file opens in BME AI-Studio's board configuration, so recordings made with it can
          be compared there too.</p>
      </div>
    </>
  );
}

registerView({ id: 'profiles', title: 'Heater profiles', hint: 'Design .bmeconfig files', order: 50, needsProject: true, component: Profiles });
