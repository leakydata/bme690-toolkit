/**
 * Explore: look at the data before training on it. A timeline of each
 * recording, per-class fingerprints, a 2-D map with a separability verdict,
 * and plain-English checks for problems that would mislead a model.
 */
import { useMemo, useState } from 'react';
import { useStudio } from '../../app/state.tsx';
import { heaterProfilesIn } from '../../ml/dataset.ts';
import { registerView } from '../registry.ts';
import { dataChecks } from './checks.ts';
import { Fingerprints } from './fingerprints.tsx';
import { SeparationMap } from './map.tsx';
import { Timeline } from './timeline.tsx';
import './explore.css';

function DataChecks() {
  const s = useStudio();
  const checks = useMemo(() => (s.project ? dataChecks(s.project, s.recordings) : []), [s.project, s.recordings]);
  const warns = checks.filter((c) => c.level === 'warn').length;
  return (
    <div className="card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Data checks</h2>
        {warns > 0 ? <span className="pill warn">{warns} to look at</span> : <span className="pill ok">looks fine</span>}
      </div>
      <p className="muted small ex-hint">Problems that would make a model look better than it is, or learn the wrong thing. Worth fixing before you train.</p>
      {warns === 0 && (
        <div className="notice ok small">Nothing worrying found: every class has enough specimens, the classes are reasonably balanced, and they were recorded in similar conditions.</div>
      )}
      {checks.map((c, i) => (
        <div key={i} className={`notice small ${c.level === 'warn' ? 'warn' : 'info'}`}>
          <b>{c.title}.</b> {c.detail}
        </div>
      ))}
    </div>
  );
}

function Explore() {
  const s = useStudio();
  const profiles = useMemo(() => heaterProfilesIn(s.recordings), [s.recordings]);
  const [picked, setProfile] = useState('');
  const profile = profiles.some((p) => p.id === picked) ? picked : profiles[0]?.id ?? '';
  const classed = s.recordings.some((r) => r.specimens.some((sp) => sp.classId));

  return (
    <>
      <div className="pagehead">
        <h1>Explore</h1>
        <p>See what your sensors recorded, how each class's fingerprint looks, and whether the classes can be told apart, before you train a model.</p>
      </div>
      {s.recordings.length === 0 ? (
        <div className="card empty">
          <p>No recordings in this project yet.</p>
          <a className="btn primary" href="#data">Import data on the Data page</a>
        </div>
      ) : (
        <>
          {!classed && (
            <div className="notice info">
              None of your specimens has a class yet, so only the timeline can be shown. Assign classes (like "Coffee" or "Air")
              on the <a href="#data">Data page</a> to compare fingerprints and check how well they separate.
            </div>
          )}
          <Timeline />
          <Fingerprints profile={profile} setProfile={setProfile} />
          <SeparationMap profile={profile} setProfile={setProfile} />
          <DataChecks />
        </>
      )}
    </>
  );
}

registerView({ id: 'explore', title: 'Explore', hint: 'Graphs, fingerprints, maps', order: 20, needsProject: true, component: Explore });
