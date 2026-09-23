import { useEffect, useState } from 'react';
import { getViews } from '../plugins/registry.ts';
import { useStudio } from './state.tsx';

function currentHash(): string {
  return location.hash.replace(/^#\/?/, '') || 'projects';
}

export function App() {
  const s = useStudio();
  const [viewId, setViewId] = useState(currentHash);

  useEffect(() => {
    const on = () => setViewId(currentHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  const views = getViews().filter((v) => !v.needsProject || s.project);
  const view = views.find((v) => v.id === viewId) ?? views[0];
  const View = view.component;

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#projects">BME Studio</a>
        <span className="muted small top-project">
          {s.project ? s.project.name : 'No project open'}
        </span>
      </header>
      <nav className="side" aria-label="Sections">
        {views.map((v) => (
          <a key={v.id} href={`#${v.id}`} className={v.id === view.id ? 'on' : ''} aria-current={v.id === view.id ? 'page' : undefined}>
            <span>{v.title}</span>
            {v.hint && <small>{v.hint}</small>}
          </a>
        ))}
      </nav>
      <main className="content">
        {s.loading ? <p className="muted">Loading…</p> : <View key={view.id + (s.project?.id ?? '')} />}
      </main>
      <div className="toasts" role="status" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}
